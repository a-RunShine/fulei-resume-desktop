import type { Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { expect as expectPage } from "@playwright/test";
import {
	desktopDataDirectory,
	desktopExecutable,
	desktopPort,
	killLeftoverWindows,
	openDesktopWindow,
	seedPreparedFontCache,
	stopWindow,
	windowDirectory,
} from "./window-runtime";

const name = "张三";
const summary = "我是一名前端工程师，熟悉 React 与 TypeScript。";
const company = "北风实验室";

afterAll(() => {
	stopWindow();
	killLeftoverWindows();
});

const createResume = async (page: Page, withSampleData: boolean) => {
	const created = await page.request.post(`http://127.0.0.1:${desktopPort}/api/openapi/resumes`, {
		data: { name: "窗口回归", tags: [], withSampleData },
	});
	expect(created.status()).toBe(200);
	return (await created.json()) as string;
};

const reportRuntimeBesideExecutable = () => {
	const executableDirectory = dirname(desktopExecutable);
	const leftover = ["node", "server", "web"].filter((name) => existsSync(join(executableDirectory, name)));
	if (leftover.length === 0) return;
	console.warn(`[window] a runtime already sat beside the executable (${leftover.join(", ")}); the app ignored it`);
};

const prepareResume = async (page: Page, resumeId: string) => {
	const response = await page.request.get(`http://127.0.0.1:${desktopPort}/api/openapi/resumes/${resumeId}`);
	expect(response.status()).toBe(200);
	const { data } = (await response.json()) as { data: Record<string, unknown> };
	const metadata = data.metadata as {
		typography: { body: { fontFamily: string }; heading: { fontFamily: string } };
	};
	const picture = data.picture as { hidden: boolean };
	const basics = data.basics as { name: string };
	const summarySection = data.summary as { content: string };
	picture.hidden = true;
	basics.name = name;
	summarySection.content = `<p>${summary}</p>`;
	metadata.typography.body.fontFamily = "IBM Plex Serif";
	metadata.typography.heading.fontFamily = "IBM Plex Serif";
	const updated = await page.request.put(`http://127.0.0.1:${desktopPort}/api/openapi/resumes/${resumeId}`, {
		data: { data },
	});
	expect(updated.status()).toBe(200);
};

const openBuilder = async (page: Page, resumeId: string) => {
	await page.goto(`http://127.0.0.1:${desktopPort}/builder/${resumeId}`);
	await page.waitForURL(/\/builder\/.+/);
	await expectPage(page.getByRole("textbox", { name: "Full name", exact: true })).toHaveValue(name, {
		timeout: 180_000,
	});
};

const expandSection = async (page: Page, section: string) => {
	const row = page.locator(`#sidebar-${section.toLowerCase()}`).getByRole("button", { name: section, exact: true });
	if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
};

const openEntry = async (entry: ReturnType<Page["locator"]>) => {
	const toggle = entry.getByRole("button", { name: /entry \d+ of \d+/ });
	if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
};

it("opens the app from the staged runtime rather than whatever sits beside the executable", async () => {
	const directory = windowDirectory("opens");
	const session = await openDesktopWindow({ appDirectory: directory, debugPort: 9321 });

	try {
		expect(existsSync(desktopExecutable)).toBe(true);
		expect(new URL(session.page.url()).pathname).not.toBe("/desktop/enter");
		await expectPage(session.page.getByRole("heading", { name: "Documents" })).toBeVisible({ timeout: 180_000 });
		expect(existsSync(join(desktopDataDirectory(directory), "pglite"))).toBe(true);

		reportRuntimeBesideExecutable();
	} finally {
		await session.close();
	}
});

it("keeps the edited resume in the app data directory across a restart", async () => {
	const directory = windowDirectory("restart");
	const fontCache = join(directory, "font-cache");
	await seedPreparedFontCache(fontCache);
	const first = await openDesktopWindow({ appDirectory: directory, debugPort: 9324, fontCache });
	let resumeId = "";

	try {
		resumeId = await createResume(first.page, true);
		await prepareResume(first.page, resumeId);
		await openBuilder(first.page, resumeId);
		await expandSection(first.page, "Experience");
		const entry = first.page.locator("#sidebar-experience [data-entry-id]").first();
		await openEntry(entry);
		await entry.getByRole("textbox", { name: "Company" }).fill(company);
		await expectPage(first.page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({ timeout: 180_000 });
	} finally {
		await first.close();
	}

	expect(existsSync(join(desktopDataDirectory(directory), "pglite"))).toBe(true);

	const second = await openDesktopWindow({ appDirectory: directory, debugPort: 9325, fontCache });
	try {
		await openBuilder(second.page, resumeId);
		await expandSection(second.page, "Experience");
		const entry = second.page.locator("#sidebar-experience [data-entry-id]").first();
		await openEntry(entry);
		await expectPage(entry.getByRole("textbox", { name: "Company" })).toHaveValue(company);
	} finally {
		await second.close();
	}
});
