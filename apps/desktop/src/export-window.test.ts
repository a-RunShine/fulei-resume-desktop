import type { Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { expect as expectPage } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
	blockExternal,
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

const readPdf = async (bytes: Uint8Array) => {
	const document = await getDocument({ data: bytes, verbosity: 0 }).promise;
	const page = await document.getPage(1);
	const content = await page.getTextContent();
	return content.items.map((item) => ("str" in item ? item.str : "")).join("");
};

const downloadPdf = async (page: Page) => {
	const downloaded = page.waitForEvent("download", { timeout: 300_000 });
	await page.getByRole("button", { name: "Download PDF", exact: true }).click();
	const download = await downloaded;
	expect(await download.failure()).toBeNull();
	const path = await download.path();
	if (!path) throw new Error("the window did not save the exported PDF");
	return new Uint8Array(readFileSync(path));
};

it("opens the app from a staged runtime while the debug executable has no runtime beside it", async () => {
	const directory = windowDirectory("opens");
	const session = await openDesktopWindow({ appDirectory: directory, debugPort: 9321 });

	try {
		expect(existsSync(desktopExecutable)).toBe(true);
		const executableDirectory = dirname(desktopExecutable);
		expect(existsSync(join(executableDirectory, "node"))).toBe(false);
		expect(existsSync(join(executableDirectory, "server"))).toBe(false);

		expect(new URL(session.page.url()).pathname).not.toBe("/desktop/enter");
		await expectPage(session.page.getByRole("heading", { name: "Documents" })).toBeVisible({ timeout: 180_000 });
		expect(existsSync(join(desktopDataDirectory(directory), "pglite"))).toBe(true);
	} finally {
		await session.close();
	}
});

it("exports a Chinese resume as a parseable PDF without downloading its fallback face", async () => {
	const directory = windowDirectory("export");
	const session = await openDesktopWindow({ appDirectory: directory, debugPort: 9322 });
	const page = session.page;
	const blocked = await blockExternal(page);

	try {
		const resumeId = await createResume(page, true);
		await prepareResume(page, resumeId);
		await openBuilder(page, resumeId);
		await expandSection(page, "Experience");
		const entry = page.locator("#sidebar-experience [data-entry-id]").first();
		await openEntry(entry);
		await entry.getByRole("textbox", { name: "Company" }).fill(company);
		await expectPage(page.getByText(company).filter({ visible: true }).first()).toBeVisible({ timeout: 180_000 });
		await expectPage(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({ timeout: 180_000 });

		const text = await readPdf(await downloadPdf(page));

		expect(text).toContain(name);
		expect(text).toContain(summary);
		expect(text).toContain(company);
		expect(blocked.some((url) => /fonts\.gstatic\.(com|cn)/.test(url))).toBe(false);
	} finally {
		await session.close();
	}
});

it("downloads a face the prepared cache does not carry instead of failing the export", async () => {
	const directory = windowDirectory("missing-fonts");
	const fontCache = join(directory, "font-cache");
	mkdirSync(fontCache, { recursive: true });
	const session = await openDesktopWindow({ appDirectory: directory, debugPort: 9323, fontCache });
	const page = session.page;
	const downloads: string[] = [];
	page.on("download", (download) => downloads.push(download.suggestedFilename()));

	try {
		const resumeId = await createResume(page, true);
		await prepareResume(page, resumeId);
		await openBuilder(page, resumeId);
		await downloadPdf(page);

		expect(downloads).not.toEqual([]);
		await expectPage(page.getByText(/Fonts could not be loaded/).first()).toBeHidden({ timeout: 30_000 });
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
