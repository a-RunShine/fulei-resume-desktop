import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { chromium, expect as expectPage, type Locator, type Page } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const name = "张三";
const summary = "我是一名前端工程师，熟悉 React 与 TypeScript。";

const cjkFaces = [
	{
		file: "Noto Serif SC-400-false.ttf",
		url: "https://fonts.gstatic.com/s/notoserifsc/v35/H4cyBXePl9DZ0Xe7gG9cyOj7uK2-n-D2rd4FY7SCqyWv847hdDWC.ttf",
	},
	{
		file: "Noto Serif SC-700-false.ttf",
		url: "https://fonts.gstatic.com/s/notoserifsc/v35/H4cyBXePl9DZ0Xe7gG9cyOj7uK2-n-D2rd4FY7RlrCWv847hdDWC.ttf",
	},
];

const seedPreparedFontCache = async (directory: string) => {
	mkdirSync(directory, { recursive: true });
	const store = join(desktopRoot, ".cache", "fonts");
	mkdirSync(store, { recursive: true });
	for (const face of cjkFaces) {
		const stored = join(store, face.file);
		if (!existsSync(stored) || readFileSync(stored).byteLength < 1000) {
			const response = await fetch(face.url);
			if (!response.ok) throw new Error(`could not prepare ${face.file}`);
			writeFileSync(stored, Buffer.from(await response.arrayBuffer()));
		}
		copyFileSync(stored, join(directory, face.file));
	}
};

let windowProcess: ChildProcess | undefined;

const stopWindow = () => {
	const pid = windowProcess?.pid;
	if (!pid) return;
	windowProcess = undefined;
	try {
		execFileSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
	} catch {
		return;
	}
};

const devPort = 1474;

const visualStudioCommand = (configPath: string) => {
	const vswhere = join(
		process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
		"Microsoft Visual Studio",
		"Installer",
		"vswhere.exe",
	);
	const installation = execFileSync(
		vswhere,
		[
			"-latest",
			"-products",
			"*",
			"-requires",
			"Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
			"-property",
			"installationPath",
		],
		{ encoding: "utf8" },
	).trim();
	const vcvars = join(installation, "VC", "Auxiliary", "Build", "vcvars64.bat");
	return `call "${vcvars}" >nul && set PATH=C:\\Users\\Administrator\\.cargo\\bin;%PATH% && pnpm exec tauri dev --config "${configPath}"`;
};

const writeDevServerConfig = (directory: string, port = devPort) => {
	const configPath = join(directory, "tauri.dev.json");
	writeFileSync(configPath, JSON.stringify({ build: { devUrl: `http://127.0.0.1:${port}` } }));
	return configPath;
};

afterAll(() => {
	stopWindow();
});

const visiblePageText = async (region: Locator) => region.evaluate((node) => node.textContent ?? "");

const textLeft = async (region: Locator, needle: string) =>
	region.evaluate((node, sample) => {
		const spans = [...node.querySelectorAll("span")].filter((span) => {
			const text = span.textContent ?? "";
			return text.length > 0 && sample.includes(text);
		});
		if (spans.length === 0) return -1;
		return Math.min(...spans.map((span) => span.getBoundingClientRect().left));
	}, needle);

const pdfText = async (bytes: Uint8Array) => {
	const document = await getDocument({ data: bytes, verbosity: 0 }).promise;
	const page = await document.getPage(1);
	const content = await page.getTextContent();
	return content.items.map((item) => ("str" in item ? item.str : "")).join("");
};

const pdfPage = async (bytes: Uint8Array) => {
	const document = await getDocument({ data: bytes, verbosity: 0 }).promise;
	const page = await document.getPage(1);
	const content = await page.getTextContent();
	const text = content.items.map((item) => ("str" in item ? item.str : "")).join("");
	const view = page.view;
	return { text, width: view[2] ?? 0, height: view[3] ?? 0 };
};

const isExternalHost = (url: URL) => {
	const hostname = url.hostname;
	if (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost")) return false;
	return url.protocol !== "tauri:" && url.protocol !== "ipc:" && url.protocol !== "asset:";
};

const waitForDebuggingPort = async (port: number, exited: Promise<number>) => {
	const deadline = Date.now() + 600_000;
	let lastError = "desktop window did not open";
	while (Date.now() < deadline) {
		const exit = await Promise.race([
			exited.then((code) => code),
			new Promise<undefined>((resolve) => setTimeout(resolve, 0)),
		]);
		if (exit !== undefined) throw new Error(`desktop window exited (${exit})`);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (response.ok) return;
			lastError = `debugging port status ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(lastError);
};

it("exports a Chinese resume from the desktop window while external hosts are blocked", async () => {
	const runDirectory = join(tmpdir(), `reactive-resume-export-${process.pid}`);
	rmSync(runDirectory, { recursive: true, force: true });
	const cacheDirectory = join(runDirectory, "font-cache");
	const exportDirectory = join(runDirectory, "export");
	const userDataDirectory = join(runDirectory, "webview");
	mkdirSync(exportDirectory, { recursive: true });
	mkdirSync(userDataDirectory, { recursive: true });
	await seedPreparedFontCache(cacheDirectory);
	const devConfig = writeDevServerConfig(runDirectory);

	const port = 9223;
	const logs: string[] = [];
	const pageErrors: string[] = [];
	windowProcess = spawn(visualStudioCommand(devConfig), {
		cwd: desktopRoot,
		shell: true,
		env: {
			...process.env,
			PATH: `C:\\Users\\Administrator\\.cargo\\bin;${process.env.PATH ?? ""}`,
			REACTIVE_RESUME_FONT_CACHE: cacheDirectory,
			REACTIVE_RESUME_EXPORT_DIR: exportDirectory,
			REACTIVE_RESUME_DEV_PORT: String(devPort),
			WEBVIEW2_USER_DATA_FOLDER: userDataDirectory,
			REACTIVE_RESUME_DEBUG_PORT: String(port),
		},
	});
	const exited = new Promise<number>((resolve) => {
		windowProcess?.on("exit", (code) => resolve(code ?? 1));
	});
	windowProcess.stdout?.on("data", (chunk: Buffer) => {
		logs.push(chunk.toString());
	});
	windowProcess.stderr?.on("data", (chunk: Buffer) => {
		logs.push(chunk.toString());
	});

	try {
		await waitForDebuggingPort(port, exited);
		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
		const context = browser.contexts()[0];
		if (!context) throw new Error("desktop window has no page");
		const page =
			context.pages().find((candidate) => candidate.url().includes(String(devPort))) ??
			context.pages()[0] ??
			(await context.waitForEvent("page", { timeout: 180_000 }));
		page.setDefaultTimeout(180_000);
		const blocked: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("console", (message) => {
			if (message.type() === "error") pageErrors.push(message.text());
		});
		await page.route(isExternalHost, (route) => {
			blocked.push(route.request().url());
			return route.abort();
		});
		await page.waitForURL(`**127.0.0.1:${devPort}/**`, { timeout: 180_000 });

		await page.getByRole("button", { name: "New Resume" }).click();
		await page.getByLabel("Name", { exact: true }).fill(name);
		await openSection(page, "Summary");
		await page.getByRole("textbox", { name: "Summary" }).fill(summary);
		await page.getByRole("button", { name: "Export PDF" }).click();
		await page.getByText(/^Exported /).waitFor({ timeout: 120_000 });
		const status = await page.getByText(/^Exported /).innerText();
		const pdfPath = status.replace(/^Exported\s+/, "").trim();
		const text = await pdfText(new Uint8Array(readFileSync(pdfPath)));

		expect(blocked.some((url) => /fonts\.gstatic\.(com|cn)/.test(url))).toBe(false);
		expect(text).toContain(name);
		expect(text).toContain(summary);
		await browser.close();
	} catch (error) {
		const detail = [...pageErrors, logs.join("")].join("\n").slice(-4000);
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`);
	} finally {
		stopWindow();
	}
});

type DesktopSession = {
	page: Page;
	close: () => Promise<void>;
};

const launchDesktop = async (options: {
	port: number;
	directory: string;
	databasePath: string;
	fresh?: boolean;
	fonts?: boolean;
	dataDirectory?: string;
	devPort?: number;
}): Promise<DesktopSession> => {
	if (options.fresh !== false) rmSync(options.directory, { recursive: true, force: true });
	const exportDirectory = join(options.directory, "export");
	const userDataDirectory = join(options.directory, `webview-${options.port}`);
	mkdirSync(exportDirectory, { recursive: true });
	mkdirSync(userDataDirectory, { recursive: true });
	const cacheDirectory = join(options.directory, "font-cache");
	if (options.fonts) await seedPreparedFontCache(cacheDirectory);
	const serverPort = options.devPort ?? devPort;

	const logs: string[] = [];
	const pageErrors: string[] = [];
	const devConfig = writeDevServerConfig(options.directory, serverPort);
	windowProcess = spawn(visualStudioCommand(devConfig), {
		cwd: desktopRoot,
		shell: true,
		env: {
			...process.env,
			PATH: `C:\\Users\\Administrator\\.cargo\\bin;${process.env.PATH ?? ""}`,
			REACTIVE_RESUME_FONT_CACHE: cacheDirectory,
			REACTIVE_RESUME_EXPORT_DIR: exportDirectory,
			REACTIVE_RESUME_DEV_PORT: String(serverPort),
			REACTIVE_RESUME_DB: options.databasePath,
			...(options.dataDirectory ? { REACTIVE_RESUME_DATA_DIR: options.dataDirectory } : {}),
			WEBVIEW2_USER_DATA_FOLDER: userDataDirectory,
			REACTIVE_RESUME_DEBUG_PORT: String(options.port),
		},
	});
	const exited = new Promise<number>((resolve) => {
		windowProcess?.on("exit", (code) => resolve(code ?? 1));
	});
	windowProcess.stdout?.on("data", (chunk: Buffer) => {
		logs.push(chunk.toString());
	});
	windowProcess.stderr?.on("data", (chunk: Buffer) => {
		logs.push(chunk.toString());
	});

	const close = async () => {
		stopWindow();
	};

	try {
		await waitForDebuggingPort(options.port, exited);
		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${options.port}`);
		const context = browser.contexts()[0];
		if (!context) throw new Error("desktop window has no page");
		const page =
			context.pages().find((candidate) => candidate.url().includes(String(serverPort))) ??
			context.pages()[0] ??
			(await context.waitForEvent("page", { timeout: 180_000 }));
		page.setDefaultTimeout(30_000);
		await page.waitForURL(`**127.0.0.1:${serverPort}/**`, { timeout: 180_000 });
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("console", (message) => {
			if (message.type() === "error") pageErrors.push(message.text());
		});
		return {
			page,
			close: async () => {
				await browser.close();
				stopWindow();
			},
		};
	} catch (error) {
		await close();
		const detail = [...pageErrors, logs.join("")].join("\n").slice(-4000);
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`);
	}
};

it("lists a Resume after creating one", async () => {
	const directory = join(tmpdir(), `reactive-resume-list-${process.pid}`);
	const session = await launchDesktop({
		port: 9224,
		directory,
		databasePath: join(directory, "resumes.sqlite"),
	});
	try {
		await session.page.getByRole("button", { name: "New Resume" }).click();
		await session.page.getByRole("button", { name: "Untitled resume" }).waitFor();
	} finally {
		await session.close();
	}
});

it("renames a Resume in the list", async () => {
	const directory = join(tmpdir(), `reactive-resume-rename-${process.pid}`);
	const session = await launchDesktop({
		port: 9225,
		directory,
		databasePath: join(directory, "resumes.sqlite"),
	});
	try {
		await session.page.getByRole("button", { name: "New Resume" }).click();
		await session.page.getByRole("button", { name: "Untitled resume" }).waitFor();
		await session.page.getByLabel("Title").fill("张三的简历");
		await session.page.getByRole("button", { name: "张三的简历" }).waitFor();
	} finally {
		await session.close();
	}
});

it("deletes a Resume from the list", async () => {
	const directory = join(tmpdir(), `reactive-resume-delete-${process.pid}`);
	const session = await launchDesktop({
		port: 9226,
		directory,
		databasePath: join(directory, "resumes.sqlite"),
	});
	try {
		await session.page.getByRole("button", { name: "New Resume" }).click();
		await session.page.getByLabel("Title").fill("保留");
		await session.page.getByRole("button", { name: "保留" }).waitFor();
		await session.page.getByRole("button", { name: "New Resume" }).click();
		await session.page.getByRole("button", { name: "Untitled resume" }).waitFor();
		await session.page.getByRole("button", { name: "Delete" }).click();
		await session.page.getByRole("button", { name: "Untitled resume" }).waitFor({ state: "detached" });
		await session.page.getByRole("button", { name: "保留" }).waitFor();
	} finally {
		await session.close();
	}
});

it("edits Basics, Summary, and a Section Item", async () => {
	const directory = join(tmpdir(), `reactive-resume-edit-${process.pid}`);
	const session = await launchDesktop({
		port: 9227,
		directory,
		databasePath: join(directory, "resumes.sqlite"),
	});
	const page = session.page;
	const basicsName = "张三";
	const summary = "我是一名前端工程师，熟悉 React 与 TypeScript。";
	const company = "北风实验室";
	const position = "前端工程师";
	try {
		await page.getByRole("button", { name: "New Resume" }).click();
		await page.getByLabel("Title").fill("中文简历");
		await page.getByRole("button", { name: "中文简历" }).waitFor();
		await page.getByLabel("Name", { exact: true }).fill(basicsName);
		await openSection(page, "Summary");
		await page.getByRole("textbox", { name: "Summary" }).fill(summary);
		await openSection(page, "Experience");
		await page.getByRole("button", { name: "Add Item" }).click();
		await page.getByLabel("Company").fill(company);
		await page.getByLabel("Position").fill(position);
		await expectPage(page.getByText("Saved", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "New Resume" }).click();
		await expectPage(page.getByLabel("Name", { exact: true })).toHaveValue("");
		await page.getByRole("button", { name: "中文简历" }).click();
		await expectPage(page.getByLabel("Name", { exact: true })).toHaveValue(basicsName);
		await expectPage(page.getByRole("textbox", { name: "Summary", includeHidden: true })).toHaveValue(summary);
		await expectPage(page.getByLabel("Company")).toHaveValue(company);
		await expectPage(page.getByLabel("Position")).toHaveValue(position);
	} finally {
		await session.close();
	}
});

it("chooses a Template and Letter paper", async () => {
	const directory = join(tmpdir(), `reactive-resume-template-${process.pid}`);
	const session = await launchDesktop({
		port: 9228,
		directory,
		databasePath: join(directory, "resumes.sqlite"),
	});
	const page = session.page;
	try {
		await page.getByRole("button", { name: "New Resume" }).click();
		await page.getByLabel("Title").fill("版式");
		await page.getByRole("button", { name: "版式" }).waitFor();
		await page.getByLabel("Template").selectOption("Bronzor");
		await page.getByLabel("Paper").selectOption("Letter");
		await expectPage(page.getByText("Saved", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "New Resume" }).click();
		await expectPage(page.getByLabel("Template")).toHaveValue("onyx");
		await expectPage(page.getByLabel("Paper")).toHaveValue("a4");
		await page.getByRole("button", { name: "版式" }).click();
		await expectPage(page.getByLabel("Template")).toHaveValue("bronzor");
		await expectPage(page.getByLabel("Paper")).toHaveValue("letter");
	} finally {
		await session.close();
	}
});

it("opens the same Resume, including Chinese, after a restart", async () => {
	const directory = join(tmpdir(), `reactive-resume-restart-${process.pid}`);
	const databasePath = join(directory, "resumes.sqlite");
	const basicsName = "张三";
	const summary = "我是一名前端工程师，熟悉 React 与 TypeScript。";
	const company = "北风实验室";
	const position = "前端工程师";
	const title = "张三的简历";
	const first = await launchDesktop({ port: 9229, directory, databasePath });
	try {
		await first.page.getByRole("button", { name: "New Resume" }).click();
		await first.page.getByLabel("Title").fill(title);
		await first.page.getByRole("button", { name: title }).waitFor();
		await first.page.getByLabel("Name", { exact: true }).fill(basicsName);
		await openSection(first.page, "Summary");
		await first.page.getByRole("textbox", { name: "Summary" }).fill(summary);
		await openSection(first.page, "Experience");
		await first.page.getByRole("button", { name: "Add Item" }).click();
		await first.page.getByLabel("Company").fill(company);
		await first.page.getByLabel("Position").fill(position);
		await first.page.getByLabel("Template").selectOption("Bronzor");
		await first.page.getByLabel("Paper").selectOption("Letter");
		await expectPage(first.page.getByText("Saved", { exact: true })).toBeVisible();
	} finally {
		await first.close();
	}

	const second = await launchDesktop({ port: 9230, directory, databasePath, fresh: false });
	try {
		await second.page.getByRole("button", { name: title }).click();
		await expectPage(second.page.getByLabel("Title")).toHaveValue(title);
		await expectPage(second.page.getByLabel("Name", { exact: true })).toHaveValue(basicsName);
		await expectPage(second.page.getByRole("textbox", { name: "Summary", includeHidden: true })).toHaveValue(summary);
		await expectPage(second.page.getByLabel("Company")).toHaveValue(company);
		await expectPage(second.page.getByLabel("Position")).toHaveValue(position);
		await expectPage(second.page.getByLabel("Template")).toHaveValue("bronzor");
		await expectPage(second.page.getByLabel("Paper")).toHaveValue("letter");
	} finally {
		await second.close();
	}
});

it("exports a PDF in the selected Template and paper size", async () => {
	const directory = join(tmpdir(), `reactive-resume-template-pdf-${process.pid}`);
	const session = await launchDesktop({
		port: 9231,
		directory,
		databasePath: join(directory, "resumes.sqlite"),
		fonts: true,
	});
	const page = session.page;
	const blocked: string[] = [];
	await page.route(isExternalHost, (route) => {
		blocked.push(route.request().url());
		return route.abort();
	});
	const basicsName = "张三";
	const summary = "我是一名前端工程师，熟悉 React 与 TypeScript。";
	const company = "北风实验室";
	const skill = "排版";
	try {
		await page.getByRole("button", { name: "New Resume" }).click();
		await page.getByLabel("Name", { exact: true }).fill(basicsName);
		await openSection(page, "Summary");
		await page.getByRole("textbox", { name: "Summary" }).fill(summary);
		await openSection(page, "Experience");
		await page.getByRole("button", { name: "Add Item" }).click();
		await page.getByLabel("Company").fill(company);
		await page.getByLabel("Skill").fill(skill);
		await page.getByLabel("Template").selectOption("Bronzor");
		await page.getByLabel("Paper").selectOption("Letter");
		page.setDefaultTimeout(180_000);
		await page.getByRole("button", { name: "Export PDF" }).click();
		await page.getByText(/^Exported /).waitFor();
		const pdfPath = (await page.getByText(/^Exported /).innerText()).replace(/^Exported\s+/, "").trim();
		const exported = await pdfPage(new Uint8Array(readFileSync(pdfPath)));

		expect(blocked.some((url) => /fonts\.gstatic\.(com|cn)/.test(url))).toBe(false);
		expect(exported.text).toContain(basicsName);
		expect(exported.text).toContain(summary);
		expect(exported.text).toContain(company);
		expect(exported.text.indexOf("Skills")).toBeGreaterThanOrEqual(0);
		expect(exported.text.indexOf("Skills")).toBeLessThan(exported.text.indexOf("Summary"));
		expect(exported.width).toBeCloseTo(612, 0);
		expect(exported.height).toBeCloseTo(792, 0);
	} finally {
		await session.close();
	}
});

const headerValue = (value: IncomingMessage["headers"]["authorization"]) => (Array.isArray(value) ? value[0] : value);

const startSessionProvider = async (replyText: string) => {
	const requests: { url: string; body: string }[] = [];
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const host = headerValue(request.headers.host) ?? "";
			requests.push({ url: `http://${host}${request.url ?? ""}`, body: Buffer.concat(chunks).toString("utf8") });
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ choices: [{ message: { content: replyText } }] }));
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("provider stub has no port");
	return {
		requests,
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
};

const filesUnder = (directory: string) => {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { encoding: "utf8", recursive: true })
		.map((entry) => join(directory, entry))
		.filter((path) => statSync(path).isFile());
};

const blockExternal = async (page: Page) => {
	const blocked: string[] = [];
	await page.route(isExternalHost, (route) => {
		blocked.push(route.request().url());
		return route.abort();
	});
	return blocked;
};

it("runs the offline desktop session", async () => {
	const sessionName = "张三";
	const sessionSummary = "我是一名前端工程师，熟悉 React 与 TypeScript。";
	const sessionTitle = "张三的简历";
	const apiKey = "sk-session-key-not-in-resume";
	const replyText = "会话回复";
	const missingDirectory = join(tmpdir(), `reactive-resume-session-missing-${process.pid}`);
	const missing = await launchDesktop({
		port: 9242,
		directory: missingDirectory,
		databasePath: join(missingDirectory, "resumes.sqlite"),
	});
	await blockExternal(missing.page);
	try {
		await missing.page.getByRole("button", { name: "New Resume" }).click();
		await missing.page.getByLabel("Name", { exact: true }).fill(sessionName);
		await openSection(missing.page, "Summary");
		await missing.page.getByRole("textbox", { name: "Summary" }).fill(sessionSummary);
		await missing.page.getByRole("button", { name: "Export PDF" }).click();
		await missing.page.getByText(/Fonts could not be loaded/).waitFor();
		await expectPage(missing.page.locator("#status")).toContainText("Noto Serif SC");
		expect(existsSync(join(missingDirectory, "export", "resume.pdf"))).toBe(false);
	} finally {
		await missing.close();
	}

	const directory = join(tmpdir(), `reactive-resume-session-${process.pid}`);
	const databasePath = join(directory, "resumes.sqlite");
	const dataDirectory = join(directory, "data");
	const first = await launchDesktop({
		port: 9243,
		directory,
		databasePath,
		dataDirectory,
		fonts: true,
	});
	const blocked = await blockExternal(first.page);
	try {
		await first.page.getByRole("button", { name: "New Resume" }).click();
		await first.page.getByLabel("Title").fill(sessionTitle);
		await first.page.getByRole("button", { name: sessionTitle }).waitFor();
		await first.page.getByLabel("Name", { exact: true }).fill(sessionName);
		await openSection(first.page, "Summary");
		await first.page.getByRole("textbox", { name: "Summary" }).fill(sessionSummary);
		await first.page.getByLabel("Template").selectOption("Bronzor");
		first.page.setDefaultTimeout(180_000);
		await first.page.getByRole("button", { name: "Export PDF" }).click();
		await first.page.getByText(/^Exported /).waitFor();
		const pdfPath = (await first.page.getByText(/^Exported /).innerText()).replace(/^Exported\s+/, "").trim();
		const exported = await pdfText(new Uint8Array(readFileSync(pdfPath)));
		expect(exported).toContain(sessionName);
		expect(exported).toContain(sessionSummary);
		expect(blocked.some((url) => /fonts\.gstatic\.(com|cn)/.test(url))).toBe(false);
	} finally {
		await first.close();
	}

	const provider = await startSessionProvider(replyText);
	const second = await launchDesktop({
		port: 9244,
		directory,
		databasePath,
		dataDirectory,
		fonts: true,
		fresh: false,
	});
	await blockExternal(second.page);
	try {
		await second.page.getByRole("button", { name: sessionTitle }).click();
		await expectPage(second.page.getByLabel("Name", { exact: true })).toHaveValue(sessionName);
		await expectPage(second.page.getByRole("textbox", { name: "Summary", includeHidden: true })).toHaveValue(
			sessionSummary,
		);
		await expectPage(second.page.getByLabel("Template")).toHaveValue("bronzor");
		second.page.setDefaultTimeout(180_000);
		await second.page.getByRole("button", { name: "Export PDF" }).click();
		await second.page.getByText(/^Exported /).waitFor();

		await second.page.getByLabel("Provider").fill(provider.baseUrl);
		await second.page.getByLabel("Model").fill("desktop-stub");
		await second.page.getByLabel("API key").fill(apiKey);
		await second.page.getByRole("button", { name: "Save Provider" }).click();
		await second.page.getByText("Provider saved").waitFor();
		await second.page.getByRole("button", { name: "Ask Assistant" }).click();
		await second.page.getByText(replyText).waitFor();
		expect(provider.requests.map((request) => request.url)).toEqual([`${provider.baseUrl}/chat/completions`]);

		const stored = [databasePath, ...filesUnder(dataDirectory)];
		expect(stored.length).toBeGreaterThan(1);
		for (const path of stored) {
			expect(readFileSync(path).includes(apiKey)).toBe(false);
		}
	} finally {
		await second.close();
		await provider.close();
	}
});

it("shows the Page before any export and updates it when the name and Summary change", async () => {
	const directory = join(tmpdir(), `reactive-resume-preview-${process.pid}`);
	const session = await launchDesktop({
		port: 9245,
		directory,
		databasePath: join(directory, "resumes.sqlite"),
		fonts: true,
	});
	const page = session.page;
	const blocked = await blockExternal(page);
	const basicsName = "张三";
	const summary = "我是一名前端工程师，熟悉 React 与 TypeScript。";
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") pageErrors.push(message.text());
	});
	page.setDefaultTimeout(180_000);
	try {
		await page.getByRole("button", { name: "New Resume" }).click();
		const resumePage = page.getByRole("region", { name: "Page" });
		await expectPage(resumePage).toBeVisible({ timeout: 180_000 });
		expect(readdirSync(join(directory, "export")).filter((entry) => entry.endsWith(".pdf"))).toEqual([]);
		await expectPage(page.getByText(/^Exported /)).toHaveCount(0);

		await page.getByLabel("Name", { exact: true }).fill(basicsName);
		await expectPage.poll(async () => visiblePageText(resumePage), { timeout: 180_000 }).toContain(basicsName);

		await openSection(page, "Summary");
		await page.getByRole("textbox", { name: "Summary" }).fill(summary);
		await expectPage.poll(async () => visiblePageText(resumePage), { timeout: 180_000 }).toContain(summary);
		expect(await visiblePageText(resumePage)).toContain(basicsName);
		expect(blocked.some((url) => /fonts\.gstatic\.(com|cn)/.test(url))).toBe(false);
	} catch (error) {
		const detail = pageErrors.join("\n").slice(-4000);
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`);
	} finally {
		await session.close();
	}
});

const leftRailSections = ["Picture", "Basics", "Summary", "Profiles", "Experience", "Education"] as const;

const openSection = async (page: Page, name: (typeof leftRailSections)[number]) => {
	await page.getByRole("button", { name, exact: true }).click();
};

it("switches the left rail among Picture, Basics, Summary, Profiles, Experience, and Education", async () => {
	const directory = join(tmpdir(), `reactive-resume-rail-${process.pid}`);
	const session = await launchDesktop({
		port: 9246,
		directory,
		databasePath: join(directory, "resumes.sqlite"),
	});
	const page = session.page;
	await blockExternal(page);
	try {
		await page.getByRole("button", { name: "New Resume" }).click();
		for (const section of leftRailSections) {
			await page.getByRole("button", { name: section, exact: true }).click();
			const current = page.getByRole("region", { name: section });
			await expectPage(current).toBeVisible();
			if (section === "Picture") await expectPage(current.getByLabel("Picture URL")).toBeVisible();
			if (section === "Basics") await expectPage(current.getByLabel("Name", { exact: true })).toBeVisible();
			if (section === "Summary") await expectPage(current.getByRole("textbox", { name: "Summary" })).toBeVisible();
			if (section === "Profiles" || section === "Experience" || section === "Education") {
				await expectPage(current.getByRole("button", { name: "Add Item" })).toBeVisible();
			}
			for (const other of leftRailSections) {
				if (other === section) continue;
				const hiddenSection = page.getByRole("region", { name: other, includeHidden: true });
				await expectPage(hiddenSection).toBeAttached();
				await expectPage(hiddenSection).toBeHidden();
			}
		}
	} finally {
		await session.close();
	}
});

it("adds and removes an Experience Item on the Page", async () => {
	const directory = join(tmpdir(), `reactive-resume-experience-${process.pid}`);
	const session = await launchDesktop({
		port: 9247,
		directory,
		databasePath: join(directory, "resumes.sqlite"),
		fonts: true,
	});
	const page = session.page;
	const blocked = await blockExternal(page);
	const company = "北风实验室";
	page.setDefaultTimeout(180_000);
	try {
		await page.getByRole("button", { name: "New Resume" }).click();
		const resumePage = page.getByRole("region", { name: "Page" });
		await expectPage(resumePage).toBeVisible();
		await page.getByRole("button", { name: "Experience", exact: true }).click();
		await page.getByRole("button", { name: "Add Item" }).click();
		await page.getByLabel("Company").fill(company);
		await expectPage.poll(async () => visiblePageText(resumePage)).toContain(company);
		await page.getByRole("button", { name: "Remove Item" }).click();
		await expectPage.poll(async () => visiblePageText(resumePage)).not.toContain(company);
		expect(blocked.some((url) => /fonts\.gstatic\.(com|cn)/.test(url))).toBe(false);
	} finally {
		await session.close();
	}
});

const bluePng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEElEQVR4nGNgYPiPAw0pCQCpcD/BFMrqcwAAAABJRU5ErkJggg==",
	"base64",
);

const startPictureHost = async () => {
	const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
		response.writeHead(200, {
			"Content-Type": "image/png",
			"Access-Control-Allow-Origin": "*",
			"Cache-Control": "no-store",
		});
		response.end(bluePng);
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("picture host has no port");
	return {
		url: `http://127.0.0.1:${address.port}/blue.png`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
};

const pageHasBlue = async (region: Locator) =>
	region.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
		const context = canvas.getContext("2d");
		if (!context) return false;
		const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
		for (let index = 0; index < pixels.length; index += 4) {
			const red = pixels[index] ?? 0;
			const green = pixels[index + 1] ?? 0;
			const blue = pixels[index + 2] ?? 0;
			if (blue > 200 && red < 40 && green < 40) return true;
		}
		return false;
	});

it("shows and hides the Picture on the Page", async () => {
	const directory = join(tmpdir(), `reactive-resume-picture-${process.pid}`);
	const picture = await startPictureHost();
	const session = await launchDesktop({
		port: 9248,
		directory,
		databasePath: join(directory, "resumes.sqlite"),
		fonts: true,
	});
	const page = session.page;
	const blocked = await blockExternal(page);
	page.setDefaultTimeout(180_000);
	try {
		await page.getByRole("button", { name: "New Resume" }).click();
		const resumePage = page.getByRole("region", { name: "Page" });
		await expectPage(resumePage).toBeVisible();
		await page.getByRole("button", { name: "Picture", exact: true }).click();
		await page.getByLabel("Picture URL").fill(picture.url);
		await expectPage.poll(async () => pageHasBlue(resumePage)).toBe(false);
		await page.getByLabel("Show picture").check();
		await expectPage.poll(async () => pageHasBlue(resumePage)).toBe(true);
		await page.getByLabel("Show picture").uncheck();
		await expectPage.poll(async () => pageHasBlue(resumePage)).toBe(false);
		expect(blocked.some((url) => /fonts\.gstatic\.(com|cn)/.test(url))).toBe(false);
	} finally {
		await session.close();
		await picture.close();
	}
});

it("keeps Experience and Picture after a restart", async () => {
	const directory = join(tmpdir(), `reactive-resume-rail-restart-${process.pid}`);
	const databasePath = join(directory, "resumes.sqlite");
	const picture = await startPictureHost();
	const company = "北风实验室";
	const title = "左栏简历";
	try {
		const first = await launchDesktop({
			port: 9249,
			directory,
			databasePath,
			fonts: true,
		});
		const blocked = await blockExternal(first.page);
		first.page.setDefaultTimeout(180_000);
		try {
			await first.page.getByRole("button", { name: "New Resume" }).click();
			await first.page.getByLabel("Title").fill(title);
			await first.page.getByRole("button", { name: title }).waitFor();
			await first.page.getByRole("button", { name: "Experience", exact: true }).click();
			await first.page.getByRole("button", { name: "Add Item" }).click();
			await first.page.getByLabel("Company").fill(company);
			await first.page.getByRole("button", { name: "Picture", exact: true }).click();
			await first.page.getByLabel("Picture URL").fill(picture.url);
			await first.page.getByLabel("Show picture").check();
			const resumePage = first.page.getByRole("region", { name: "Page" });
			await expectPage.poll(async () => visiblePageText(resumePage)).toContain(company);
			await expectPage.poll(async () => pageHasBlue(resumePage)).toBe(true);
			await expectPage(first.page.getByText("Saved", { exact: true })).toBeVisible();
			expect(blocked.some((url) => /fonts\.gstatic\.(com|cn)/.test(url))).toBe(false);
		} finally {
			await first.close();
		}

		const second = await launchDesktop({
			port: 9250,
			directory,
			databasePath,
			fonts: true,
			fresh: false,
		});
		await blockExternal(second.page);
		second.page.setDefaultTimeout(180_000);
		try {
			await second.page.getByRole("button", { name: title }).click();
			const resumePage = second.page.getByRole("region", { name: "Page" });
			await expectPage(resumePage).toBeVisible();
			await expectPage.poll(async () => visiblePageText(resumePage)).toContain(company);
			await expectPage.poll(async () => pageHasBlue(resumePage)).toBe(true);
			await second.page.getByRole("button", { name: "Experience", exact: true }).click();
			await expectPage(second.page.getByLabel("Company")).toHaveValue(company);
			await second.page.getByRole("button", { name: "Picture", exact: true }).click();
			await expectPage(second.page.getByLabel("Picture URL")).toHaveValue(picture.url);
			await expectPage(second.page.getByLabel("Show picture")).toBeChecked();
		} finally {
			await second.close();
		}
	} finally {
		await picture.close();
	}
});

it("edits a Profile and an Education Item on the Page", async () => {
	const directory = join(tmpdir(), `reactive-resume-profile-education-${process.pid}`);
	const session = await launchDesktop({
		port: 9251,
		directory,
		databasePath: join(directory, "resumes.sqlite"),
		fonts: true,
	});
	const page = session.page;
	const blocked = await blockExternal(page);
	const network = "GitHub";
	const school = "北风大学";
	try {
		await page.getByRole("button", { name: "New Resume" }).click();
		const resumePage = page.getByRole("region", { name: "Page" });
		await expectPage(resumePage).toBeVisible();
		await openSection(page, "Profiles");
		await page.getByRole("button", { name: "Add Item" }).click();
		await page.getByLabel("Network").fill(network);
		await expectPage.poll(async () => visiblePageText(resumePage), { timeout: 180_000 }).toContain(network);
		await openSection(page, "Education");
		await page.getByRole("button", { name: "Add Item" }).click();
		await page.getByLabel("School").fill(school);
		await expectPage.poll(async () => visiblePageText(resumePage), { timeout: 180_000 }).toContain(school);
		expect(await visiblePageText(resumePage)).toContain(network);
		expect(blocked.some((url) => /fonts\.gstatic\.(com|cn)/.test(url))).toBe(false);
	} finally {
		await session.close();
	}
});

it("shows the current Template, filters the list, and updates the Page when the Template or Layout changes", async () => {
	const directory = join(tmpdir(), `reactive-resume-right-rail-${process.pid}`);
	const session = await launchDesktop({
		port: 9277,
		devPort: 1488,
		directory,
		databasePath: join(directory, "resumes.sqlite"),
		fonts: true,
	});
	const page = session.page;
	const blocked = await blockExternal(page);
	const summary = "我是一名前端工程师，熟悉 React 与 TypeScript。";
	const skill = "排版";
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") pageErrors.push(message.text());
	});
	page.setDefaultTimeout(180_000);
	try {
		await page.getByRole("button", { name: "New Resume" }).click();
		const rail = page.getByRole("complementary", { name: "Settings" });
		const resumePage = page.getByRole("region", { name: "Page" });
		await expectPage(rail.getByRole("heading", { name: "Onyx", exact: true })).toBeVisible();
		await expectPage(rail.getByRole("img", { name: "Onyx" })).toBeVisible();
		const templateOptions = rail.getByLabel("Template").locator("option");
		await expectPage(templateOptions.filter({ hasText: "Azurill" })).toHaveCount(1);
		await rail.getByRole("checkbox", { name: "Single-column" }).check();
		await expectPage(templateOptions.filter({ hasText: "Azurill" })).toHaveCount(0);
		await expectPage(templateOptions.filter({ hasText: "Onyx" })).toHaveCount(1);
		await rail.getByRole("checkbox", { name: "Single-column" }).uncheck();
		await expectPage(templateOptions.filter({ hasText: "Azurill" })).toHaveCount(1);
		await rail.getByRole("checkbox", { name: "ATS friendly" }).check();
		await expectPage(templateOptions.filter({ hasText: "Azurill" })).toHaveCount(0);
		await expectPage(templateOptions.filter({ hasText: "Onyx" })).toHaveCount(1);
		await rail.getByRole("checkbox", { name: "ATS friendly" }).uncheck();

		await openSection(page, "Summary");
		await page.getByRole("textbox", { name: "Summary" }).fill(summary);
		await page.getByLabel("Skill").fill(skill);
		await expectPage.poll(async () => visiblePageText(resumePage), { timeout: 180_000 }).toContain(skill);
		const onyxSkill = await textLeft(resumePage, skill);
		const onyxSummary = await textLeft(resumePage, summary);
		expect(onyxSkill).toBeGreaterThan(0);
		expect(Math.abs(onyxSummary - onyxSkill)).toBeLessThan(20);

		await rail.getByLabel("Template").selectOption("Azurill");
		await expectPage(rail.getByRole("heading", { name: "Azurill", exact: true })).toBeVisible();
		await expectPage(rail.getByRole("img", { name: "Azurill" })).toBeVisible();
		await expectPage
			.poll(
				async () => {
					const skillLeft = await textLeft(resumePage, skill);
					const summaryLeft = await textLeft(resumePage, summary);
					return summaryLeft - skillLeft;
				},
				{ timeout: 180_000 },
			)
			.toBeGreaterThan(24);

		const company = "北风实验室";
		await openSection(page, "Experience");
		await page.getByRole("button", { name: "Add Item" }).click();
		await page.getByLabel("Company").fill(company);
		await expectPage.poll(async () => visiblePageText(resumePage), { timeout: 180_000 }).toContain(company);
		const beforeOrder = await visiblePageText(resumePage);
		expect(beforeOrder.indexOf(summary)).toBeLessThan(beforeOrder.indexOf(company));
		const moveExperienceUp = rail.getByRole("button", { name: "Raise Experience" });
		await moveExperienceUp.click();
		await moveExperienceUp.click();
		await expectPage
			.poll(
				async () => {
					const text = await visiblePageText(resumePage);
					return text.includes(company) && text.indexOf(company) < text.indexOf(summary);
				},
				{ timeout: 180_000 },
			)
			.toBe(true);

		await rail.getByRole("button", { name: "Add Page" }).click({ timeout: 5_000 });
		await expectPage(rail.getByRole("heading", { name: "Page 2", exact: true })).toBeVisible({ timeout: 5_000 });
		await rail.getByRole("button", { name: "Onward overview" }).click();
		await expectPage.poll(async () => visiblePageText(resumePage), { timeout: 180_000 }).not.toContain(summary);
		await expectPage.poll(async () => page.locator("#page-status").innerText(), { timeout: 180_000 }).toBe("1 of 2");
		await page.getByRole("button", { name: "Next page" }).click();
		await expectPage.poll(async () => visiblePageText(resumePage), { timeout: 180_000 }).toContain(summary);
		await page.getByRole("button", { name: "Previous page" }).click();
		await expectPage
			.poll(
				async () => {
					const text = await visiblePageText(resumePage);
					return text.includes(company) && !text.includes(summary);
				},
				{ timeout: 180_000 },
			)
			.toBe(true);
		const beforeWidth = await textLeft(resumePage, company);
		expect(beforeWidth).toBeGreaterThan(0);
		await rail.getByLabel("Sidebar Width").fill("50", { timeout: 5_000 });
		await expectPage
			.poll(async () => (await textLeft(resumePage, company)) - beforeWidth, { timeout: 180_000 })
			.toBeGreaterThan(10);
		expect(blocked.some((url) => /fonts\.gstatic\.(com|cn)/.test(url))).toBe(false);
	} catch (error) {
		const detail = pageErrors.join("\n").slice(-4000);
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`);
	} finally {
		await session.close();
	}
});
