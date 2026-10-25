import type { Page } from "@playwright/test";
import { expect, it } from "vitest";
import { expect as expectPage } from "@playwright/test";
import {
	blockExternal,
	desktopPort,
	killLeftoverWindows,
	openDesktopWindow,
	stopWindow,
	windowDirectory,
} from "./window-runtime";

const baseUrl = () => `http://127.0.0.1:${desktopPort}`;

type Surface = {
	page: Page;
	close: () => Promise<void>;
};

const openSurface = async (name: string, debugPort: number): Promise<Surface> => {
	const directory = windowDirectory(name);
	const session = await openDesktopWindow({ appDirectory: directory, debugPort });
	await expectPage(session.page.getByRole("heading", { name: "Documents" })).toBeVisible({ timeout: 180_000 });
	return { page: session.page, close: session.close };
};

const createViaApi = async (page: Page, withSampleData: boolean, label: string) => {
	const created = await page.request.post(`${baseUrl()}/api/openapi/resumes`, {
		data: { name: label, tags: [], withSampleData },
	});
	expect(created.status()).toBe(200);
	return (await created.json()) as string;
};

const readViaApi = async (page: Page, id: string) => {
	const response = await page.request.get(`${baseUrl()}/api/openapi/resumes/${id}`);
	expect(response.status()).toBe(200);
	return (await response.json()) as { data: Record<string, unknown>; name?: string };
};

const openBuilder = async (page: Page, id: string) => {
	await page.goto(`${baseUrl()}/builder/${id}`);
	await expectPage(page.locator("#sidebar-basics")).toBeVisible({ timeout: 180_000 });
};

const settleUntil = async <T>(read: () => Promise<T>, matches: (value: T) => boolean, what: string) => {
	let latest = await read();
	await expectPage
		.poll(
			async () => {
				latest = await read();
				return matches(latest);
			},
			{ timeout: 180_000, message: `waiting for ${what}` },
		)
		.toBe(true);
	return latest;
};

const toggleSection = async (page: Page, section: string) => {
	const row = page.locator(`#sidebar-${section}`);
	await expectPage(row).toBeVisible({ timeout: 60_000 });
	const toggle = row.locator("button[aria-expanded]").first();
	const wasOpen = (await toggle.getAttribute("aria-expanded")) === "true";
	await toggle.click();
	await expectPage(toggle).toHaveAttribute("aria-expanded", wasOpen ? "false" : "true", { timeout: 60_000 });
};

const closeSurface = async (surface: Surface) => {
	await surface.close();
	stopWindow();
	killLeftoverWindows();
};

it("creates, renames and trashes a resume from the dashboard", async () => {
	const surface = await openSurface("resume-crud", 9341);
	const page = surface.page;

	try {
		const id = await createViaApi(page, true, "CRUD 原始名");
		await page.goto(`${baseUrl()}/dashboard`);
		await expectPage(page.getByText("CRUD 原始名")).toBeVisible({ timeout: 180_000 });

		await page.getByRole("button", { name: "Options for CRUD 原始名" }).click();
		await page.getByRole("menuitem", { name: "Rename" }).click();

		const nameField = page.getByRole("textbox", { name: "Name" });
		await expectPage(nameField).toBeVisible({ timeout: 60_000 });
		await nameField.fill("CRUD 新名字");
		await nameField.press("Enter");

		await settleUntil(
			() => readViaApi(page, id),
			(resume) => resume.name === "CRUD 新名字",
			"the rename to reach the store",
		);

		await page.getByRole("button", { name: "Options for CRUD 新名字" }).click();
		await page.getByRole("menuitem", { name: "Move to Trash" }).click();

		await page.goto(`${baseUrl()}/dashboard/trash`);
		await expectPage(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 180_000 });
		await expectPage(page.getByText("CRUD 新名字")).toBeVisible({ timeout: 180_000 });
	} finally {
		await closeSurface(surface);
	}
}, 900_000);

it("edits basics and an experience entry in the builder", async () => {
	const surface = await openSurface("builder-edit", 9342);
	const page = surface.page;

	try {
		const id = await createViaApi(page, true, "编辑回归");
		await openBuilder(page, id);

		await page.getByRole("textbox", { name: "Full name", exact: true }).fill("李四");
		await settleUntil(
			() => readViaApi(page, id),
			(resume) => (resume.data.basics as { name: string }).name === "李四",
			"the name to reach the store",
		);

		const row = page.locator("#sidebar-experience");
		const toggle = row.locator("button[aria-expanded]").first();
		if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();

		const entry = page.locator("#sidebar-experience [data-entry-id]").first();
		const entryToggle = entry.getByRole("button", { name: /entry \d+ of \d+/ });
		if ((await entryToggle.getAttribute("aria-expanded")) !== "true") await entryToggle.click();
		await entry.getByRole("textbox", { name: "Company" }).fill("回归实验室");

		await settleUntil(
			() => readViaApi(page, id),
			(resume) =>
				((resume.data.sections as { experience?: { items?: { company?: string }[] } }).experience?.items ?? []).some(
					(item) => item.company === "回归实验室",
				),
			"the company to reach the store",
		);
	} finally {
		await closeSurface(surface);
	}
}, 900_000);

it("switches template and the stored template follows", async () => {
	const surface = await openSurface("design", 9343);
	const page = surface.page;

	try {
		const id = await createViaApi(page, true, "设计回归");
		await openBuilder(page, id);
		const before = ((await readViaApi(page, id)).data.metadata as { template?: string }).template;

		await page.getByRole("tab", { name: "Design" }).click();
		const applied = page.locator('button[aria-pressed="true"]');
		await expectPage(applied.first()).toBeVisible({ timeout: 60_000 });

		const candidates = page.locator('button[aria-pressed="false"]');
		expect(await candidates.count()).toBeGreaterThan(0);

		let stored = before;
		for (let index = 0; index < (await candidates.count()) && stored === before; index += 1) {
			await candidates.nth(index).click();
			stored = await settleUntil(
				() => readViaApi(page, id).then((resume) => (resume.data.metadata as { template?: string }).template),
				(template) => template !== before,
				"a template change to reach the store",
			).catch(() => stored);
		}

		expect(stored).not.toBe(before);

		await page.getByRole("tab", { name: "Write" }).click();
		await expectPage(page.locator("#sidebar-basics")).toBeVisible({ timeout: 60_000 });
	} finally {
		await closeSurface(surface);
	}
}, 900_000);

it("moves between sidebar sections and toggles the picture", async () => {
	const surface = await openSurface("picture-sidebar", 9344);
	const page = surface.page;

	try {
		const id = await createViaApi(page, true, "照片回归");
		await openBuilder(page, id);

		for (const section of ["summary", "profiles", "experience", "education"]) {
			await toggleSection(page, section);
		}

		const before = (await readViaApi(page, id)).data.picture as { hidden: boolean };
		await page.locator("#sidebar-picture").getByRole("button", { name: "Edit" }).click();
		await page.getByRole("button", { name: before.hidden ? "Show picture" : "Hide picture" }).click();

		await settleUntil(
			() => readViaApi(page, id).then((resume) => (resume.data.picture as { hidden: boolean }).hidden),
			(hidden) => hidden !== before.hidden,
			"the picture toggle to reach the store",
		);
	} finally {
		await closeSurface(surface);
	}
}, 900_000);

it("keeps the page canvas mounted while switching modes", async () => {
	const surface = await openSurface("mode-switch", 9345);
	const page = surface.page;

	try {
		const id = await createViaApi(page, true, "模式回归");
		await openBuilder(page, id);

		const canvas = page.locator("[data-page-id], .page-canvas, main").first();
		const seenWhileWriting = await canvas.count();

		await page.getByRole("tab", { name: "Design" }).click();
		await expectPage(page.getByRole("tab", { name: "Design" })).toHaveAttribute("aria-selected", "true", {
			timeout: 60_000,
		});

		await page.getByRole("tab", { name: "Check" }).click();
		await expectPage(page.getByRole("tab", { name: "Check" })).toHaveAttribute("aria-selected", "true", {
			timeout: 60_000,
		});

		await page.getByRole("tab", { name: "Write" }).click();
		await expectPage(page.locator("#sidebar-basics")).toBeVisible({ timeout: 60_000 });
		expect(seenWhileWriting).toBeGreaterThan(0);
	} finally {
		await closeSurface(surface);
	}
}, 900_000);

it("keeps working with every other host blocked", async () => {
	const surface = await openSurface("offline", 9346);
	const page = surface.page;

	try {
		const blocked = await blockExternal(page);
		const id = await createViaApi(page, true, "离线回归");
		await openBuilder(page, id);

		await page.getByRole("textbox", { name: "Full name", exact: true }).fill("离线可用");
		await settleUntil(
			() => readViaApi(page, id),
			(resume) => (resume.data.basics as { name: string }).name === "离线可用",
			"the edit to reach the store while external hosts are blocked",
		);

		expect(blocked.length).toBeGreaterThan(0);
	} finally {
		await closeSurface(surface);
	}
}, 900_000);
