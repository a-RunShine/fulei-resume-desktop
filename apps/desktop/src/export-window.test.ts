import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { chromium } from "@playwright/test";
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

const visualStudioCommand = () => {
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
	return `call "${vcvars}" >nul && set PATH=C:\\Users\\Administrator\\.cargo\\bin;%PATH% && pnpm exec tauri dev`;
};

afterAll(() => {
	stopWindow();
});

const pdfText = async (bytes: Uint8Array) => {
	const document = await getDocument({ data: bytes, verbosity: 0 }).promise;
	const page = await document.getPage(1);
	const content = await page.getTextContent();
	return content.items.map((item) => ("str" in item ? item.str : "")).join("");
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

	const port = 9223;
	const logs: string[] = [];
	const pageErrors: string[] = [];
	windowProcess = spawn(visualStudioCommand(), {
		cwd: desktopRoot,
		shell: true,
		env: {
			...process.env,
			PATH: `C:\\Users\\Administrator\\.cargo\\bin;${process.env.PATH ?? ""}`,
			REACTIVE_RESUME_FONT_CACHE: cacheDirectory,
			REACTIVE_RESUME_EXPORT_DIR: exportDirectory,
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
			context.pages().find((candidate) => candidate.url().includes("1420")) ??
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
		await page.waitForURL("**127.0.0.1:1420/**", { timeout: 180_000 });

		await page.getByLabel("Name").fill(name);
		await page.getByLabel("Summary").fill(summary);
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
