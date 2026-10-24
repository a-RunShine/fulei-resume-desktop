import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { stageRuntime, verifyRuntimeLayout } from "../scripts/pack-installer.mjs";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const runRoot = join(tmpdir(), "reactive-resume-window-runtime");
const runtimeDir = join(runRoot, "runtime");
const deployDir = join(runRoot, "server-deploy");
const webDist = join(repoRoot, "apps", "web", "dist");
const webIndex = join(webDist, "index.html");
const serverBundle = join(repoRoot, "apps", "server", "dist");
const serverEntry = join(serverBundle, "desktop-host.mjs");
const migrationsDir = join(repoRoot, "migrations");

export const desktopPort = 47821;
export const desktopExecutable = join(desktopRoot, "src-tauri", "target", "debug", "reactive-resume-desktop.exe");

type RuntimeTiming = {
	webBuildMs: number;
	serverBuildMs: number;
	deployMs: number;
	stageMs: number;
	reused: boolean;
};

const run = (command: string, args: string[]) =>
	new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { cwd: repoRoot, stdio: "inherit", shell: true });
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
		});
	});

const timed = async (body: () => Promise<void> | void) => {
	const started = Date.now();
	await body();
	return Date.now() - started;
};

const fingerprint = (files: string[]) =>
	JSON.stringify(
		files.map((file) => {
			const stats = statSync(file);
			return [file, stats.size, stats.mtimeMs];
		}),
	);

const stampMatches = (directory: string, stamp: string) => {
	const file = join(directory, ".stamp");
	return existsSync(file) && readFileSync(file, "utf8") === stamp;
};

const deployStamp = () =>
	fingerprint([join(repoRoot, "pnpm-lock.yaml"), join(repoRoot, "apps", "server", "package.json")]);

const runtimeStamp = () =>
	fingerprint([
		webIndex,
		serverEntry,
		join(repoRoot, "apps", "server", "package.json"),
		join(repoRoot, "apps", "desktop", "scripts", "pack-installer.mjs"),
	]);

const prepareBuilds = async (timing: RuntimeTiming) => {
	if (!existsSync(webIndex)) timing.webBuildMs = await timed(() => run("pnpm", ["--filter", "web", "build"]));
	if (!existsSync(serverEntry)) {
		timing.serverBuildMs = await timed(() =>
			run("pnpm", ["--filter", "server", "exec", "tsdown", "--config", "tsdown.desktop.config.ts"]),
		);
	}
};

const prepareDeploy = async (timing: RuntimeTiming) => {
	const stamp = deployStamp();
	if (stampMatches(deployDir, stamp)) return;
	timing.deployMs = await timed(async () => {
		rmSync(deployDir, { recursive: true, force: true });
		await run("pnpm", ["--filter", "server", "deploy", "--prod", "--node-linker", "hoisted", deployDir]);
	});
	writeFileSync(join(deployDir, ".stamp"), stamp);
};

const stage = async () => {
	const timing: RuntimeTiming = { webBuildMs: 0, serverBuildMs: 0, deployMs: 0, stageMs: 0, reused: false };
	mkdirSync(runRoot, { recursive: true });
	await prepareBuilds(timing);
	await prepareDeploy(timing);

	const stamp = runtimeStamp();
	if (stampMatches(runtimeDir, stamp)) {
		try {
			verifyRuntimeLayout(runtimeDir);
			timing.reused = true;
			return { directory: runtimeDir, timing };
		} catch {
			rmSync(runtimeDir, { recursive: true, force: true });
		}
	}

	timing.stageMs = await timed(() => {
		stageRuntime({
			runtimeDir,
			nodeSource: dirname(process.execPath),
			distDir: webDist,
			bundleDir: serverBundle,
			modulesDir: join(deployDir, "node_modules"),
			migrationsDir,
		});
	});
	writeFileSync(join(runtimeDir, ".stamp"), stamp);
	return { directory: runtimeDir, timing };
};

let staged: Promise<{ directory: string }> | undefined;

export const stageWindowRuntime = () => {
	staged ??= stage().then(({ directory, timing }) => {
		const parts = [`runtime ${directory}`, timing.reused ? "reused" : "staged", `stage ${timing.stageMs}ms`];
		if (timing.webBuildMs > 0) parts.push(`web build ${timing.webBuildMs}ms`);
		if (timing.serverBuildMs > 0) parts.push(`server build ${timing.serverBuildMs}ms`);
		if (timing.deployMs > 0) parts.push(`server deploy ${timing.deployMs}ms`);
		const summary = `[${process.pid}] ${parts.join(", ")}`;
		appendFileSync(join(runRoot, "staging.log"), `${summary}\n`);
		console.log(`[window-runtime] ${summary}`);
		return { directory };
	});
	return staged;
};

const cargoPath = `${join(process.env.CARGO_HOME ?? join(homedir(), ".cargo"), "bin")};${process.env.PATH ?? ""}`;

const tauriDevCommand = () => {
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
	const cli = join(desktopRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
	return `call "${vcvars}" >nul && node "${cli}" dev --no-dev-server-wait`;
};

export const isExternalHost = (url: URL) => {
	const hostname = url.hostname;
	if (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost")) return false;
	return !["tauri:", "ipc:", "asset:", "data:", "blob:"].includes(url.protocol);
};

const waitForDebuggingPort = async (port: number, exited: Promise<number>) => {
	const deadline = Date.now() + 900_000;
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

const waitForDesktopPortToClose = async () => {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			await fetch(`http://127.0.0.1:${desktopPort}/api/health`, { signal: AbortSignal.timeout(500) });
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
};

let windowProcess: ChildProcess | undefined;

export const stopWindow = () => {
	const pid = windowProcess?.pid;
	if (!pid) return;
	windowProcess = undefined;
	try {
		execFileSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
	} catch {
		return;
	}
};

export type WindowSession = {
	page: Page;
	context: BrowserContext;
	logs: string[];
	pageErrors: string[];
	close: () => Promise<void>;
};

export type WindowOptions = {
	appDirectory: string;
	debugPort: number;
	fontCache?: string;
	environment?: Record<string, string>;
};

export const localAppDataDirectory = (appDirectory: string) => join(appDirectory, "local-app-data");
export const desktopDataDirectory = (appDirectory: string) =>
	join(localAppDataDirectory(appDirectory), "Fulei Resume", "data");

export const openDesktopWindow = async (options: WindowOptions): Promise<WindowSession> => {
	const runtime = await stageWindowRuntime();
	const userDataDirectory = join(options.appDirectory, `webview-${options.debugPort}`);
	const localAppData = localAppDataDirectory(options.appDirectory);
	mkdirSync(userDataDirectory, { recursive: true });
	mkdirSync(localAppData, { recursive: true });

	const logs: string[] = [];
	const pageErrors: string[] = [];

	windowProcess = spawn(tauriDevCommand(), {
		cwd: desktopRoot,
		shell: true,
		env: {
			...process.env,
			PATH: cargoPath,
			REACTIVE_RESUME_RUNTIME_DIR: runtime.directory,
			REACTIVE_RESUME_DEBUG_PORT: String(options.debugPort),
			WEBVIEW2_USER_DATA_FOLDER: userDataDirectory,
			LOCALAPPDATA: localAppData,
			...(options.fontCache ? { REACTIVE_RESUME_FONT_CACHE: options.fontCache } : {}),
			...options.environment,
		},
	});
	const exited = new Promise<number>((resolve) => {
		windowProcess?.on("exit", (code) => resolve(code ?? 1));
	});
	windowProcess.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
	windowProcess.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));

	let browser: Browser | undefined;
	try {
		await waitForDebuggingPort(options.debugPort, exited);
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${options.debugPort}`);
		const context = browser.contexts()[0];
		if (!context) throw new Error("desktop window has no page");
		const page = context.pages()[0] ?? (await context.waitForEvent("page", { timeout: 300_000 }));
		page.setDefaultTimeout(180_000);
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("console", (message) => {
			if (message.type() === "error") pageErrors.push(message.text());
		});
		await page.waitForURL(`**127.0.0.1:${desktopPort}/**`, { timeout: 300_000 });
		const landing = new URL(page.url()).pathname;
		if (landing === "/desktop/enter") throw new Error("desktop window stayed on /desktop/enter");
		const sessionBrowser = browser;
		return {
			page,
			context,
			logs,
			pageErrors,
			close: async () => {
				await sessionBrowser.close().catch(() => undefined);
				stopWindow();
				await waitForDesktopPortToClose();
			},
		};
	} catch (error) {
		if (browser) await browser.close().catch(() => undefined);
		stopWindow();
		await waitForDesktopPortToClose();
		const detail = [...pageErrors, logs.join("")].join("\n").slice(-4000);
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`);
	}
};

export const blockExternal = async (page: Page) => {
	const blocked: string[] = [];
	await page.route(isExternalHost, (route) => {
		blocked.push(route.request().url());
		return route.abort();
	});
	return blocked;
};

export const watchFontCacheReads = (context: BrowserContext) => {
	const reads: string[] = [];
	context.on("response", (response) => {
		const url = new URL(response.url());
		if (url.hostname !== "fontcache.localhost") return;
		if (response.status() !== 200) return;
		reads.push(decodeURIComponent(url.pathname));
	});
	return () => [...reads];
};

export const seedPreparedFontCache = async (directory: string) => {
	mkdirSync(directory, { recursive: true });
	const faces = [
		{
			file: "Noto Serif SC-400-false.ttf",
			url: "https://fonts.gstatic.com/s/notoserifsc/v35/H4cyBXePl9DZ0Xe7gG9cyOj7uK2-n-D2rd4FY7SCqyWv847hdDWC.ttf",
		},
		{
			file: "Noto Serif SC-700-false.ttf",
			url: "https://fonts.gstatic.com/s/notoserifsc/v35/H4cyBXePl9DZ0Xe7gG9cyOj7uK2-n-D2rd4FY7RlrCWv847hdDWC.ttf",
		},
	];
	for (const face of faces) {
		const target = join(directory, face.file);
		if (existsSync(target)) continue;
		const response = await fetch(face.url);
		if (!response.ok) throw new Error(`could not prepare ${face.file}`);
		writeFileSync(target, Buffer.from(await response.arrayBuffer()));
	}
};

export const windowDirectory = (name: string) => {
	const directory = join(runRoot, "runs", `${name}-${process.pid}`);
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(directory, { recursive: true });
	return directory;
};

export const filesUnder = (directory: string) => {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { encoding: "utf8", recursive: true })
		.map((entry) => join(directory, entry))
		.filter((path) => statSync(path).isFile());
};

export const killLeftoverWindows = () => {
	const escaped = runRoot.replaceAll("\\", "\\\\");
	try {
		execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-Command",
				`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${escaped}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
			],
			{ stdio: "ignore" },
		);
	} catch {
		return;
	}
};
