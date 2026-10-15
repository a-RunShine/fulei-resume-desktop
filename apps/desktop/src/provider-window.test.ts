import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { chromium, type Page } from "@playwright/test";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const name = "Ada Lovelace";
const summary = "Builds reliable interfaces.";
const model = "desktop-stub";
const apiKey = "sk-desktop-provider-test-key";
const reply = "Lead with the interface work.";
const debugPort = 9337;

type ProviderRequest = {
	url: string;
	body: string;
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

const isExternalHost = (url: URL) => {
	const hostname = url.hostname;
	if (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost")) return false;
	return url.protocol !== "tauri:" && url.protocol !== "ipc:" && url.protocol !== "asset:";
};

const relevantLog = (chunks: string[]) =>
	chunks
		.join("")
		.replaceAll("\r", "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("Compiling ") && !line.includes("Building ["))
		.slice(-80)
		.join("\n");

const waitForAppTarget = async (port: number, exited: Promise<number>) => {
	const deadline = Date.now() + 600_000;
	let lastError = "desktop window did not open";
	let foreignSince = 0;
	while (Date.now() < deadline) {
		const exit = await Promise.race([
			exited.then((code) => code),
			new Promise<undefined>((resolve) => setTimeout(resolve, 0)),
		]);
		if (exit !== undefined) throw new Error(`desktop window exited (${exit})`);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/list`);
			if (response.ok) {
				const targets = (await response.json()) as { url?: string }[];
				const urls = targets.map((target) => target.url ?? "").filter((url) => url.length > 0);
				if (urls.some((url) => url.includes("127.0.0.1:1420"))) return;
				const foreign = urls.filter((url) => url.startsWith("http") && !url.includes("127.0.0.1:1420"));
				if (foreign.length > 0) {
					if (foreignSince === 0) foreignSince = Date.now();
					lastError = `desktop opened ${foreign.join(", ")} instead of 1420`;
					if (Date.now() - foreignSince > 30_000) throw new Error(lastError);
				} else {
					foreignSince = 0;
					lastError = urls.length > 0 ? `debugging targets: ${urls.join(", ")}` : "desktop page has no url yet";
				}
			} else {
				foreignSince = 0;
				lastError = `debugging port status ${response.status}`;
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("desktop opened")) throw error;
			foreignSince = 0;
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(lastError);
};

const waitForPortToClose = async (port: number, path: string) => {
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		try {
			await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(400) });
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
};

const headerValue = (value: IncomingMessage["headers"]["authorization"]) => (Array.isArray(value) ? value[0] : value);

const startProvider = async () => {
	const requests: ProviderRequest[] = [];
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const host = headerValue(request.headers.host) ?? "";
			requests.push({
				url: `http://${host}${request.url ?? ""}`,
				body: Buffer.concat(chunks).toString("utf8"),
			});
			if (headerValue(request.headers.authorization) !== `Bearer ${apiKey}`) {
				const authorization = headerValue(request.headers.authorization);
				const reason = authorization ? "authorization header did not match" : "no authorization header";
				response.writeHead(401, { "Content-Type": "text/plain" });
				response.end(reason);
				return;
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
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

const openDesktop = async (userDataDirectory: string, dataDirectory: string) => {
	mkdirSync(userDataDirectory, { recursive: true });
	mkdirSync(dataDirectory, { recursive: true });
	const logs: string[] = [];
	const pageErrors: string[] = [];
	windowProcess = spawn(visualStudioCommand(), {
		cwd: desktopRoot,
		shell: true,
		env: {
			...process.env,
			PATH: `C:\\Users\\Administrator\\.cargo\\bin;${process.env.PATH ?? ""}`,
			REACTIVE_RESUME_DATA_DIR: dataDirectory,
			WEBVIEW2_USER_DATA_FOLDER: userDataDirectory,
			REACTIVE_RESUME_DEBUG_PORT: String(debugPort),
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
		await waitForPortToClose(debugPort, "/json/version");
		await waitForPortToClose(1420, "/");
	};
	try {
		await waitForAppTarget(debugPort, exited);
		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
		const pageDeadline = Date.now() + 30_000;
		let page: Page | undefined;
		while (Date.now() < pageDeadline) {
			page = browser
				.contexts()
				.flatMap((context) => context.pages())
				.find((candidate) => candidate.url().includes("127.0.0.1:1420"));
			if (page) break;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		if (!page) {
			const urls = browser
				.contexts()
				.flatMap((context) => context.pages())
				.map((candidate) => candidate.url());
			throw new Error(`desktop window has no resume page: ${urls.join(", ")}`);
		}
		page.setDefaultTimeout(60_000);
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("console", (message) => {
			if (message.type() === "error") pageErrors.push(message.text());
		});
		await page.route(isExternalHost, (route) => route.abort());
		await page.waitForURL("**127.0.0.1:1420/**", { timeout: 180_000 });
		return {
			page,
			logs,
			pageErrors,
			close: async () => {
				try {
					await browser.close();
				} finally {
					await close();
				}
			},
		};
	} catch (error) {
		try {
			await close();
		} catch {
			stopWindow();
		}
		const detail = [...pageErrors, relevantLog(logs)].join("\n").slice(-4000);
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`);
	}
};

const storedDocuments = (directory: string) =>
	readdirSync(directory, { encoding: "utf8", recursive: true }).filter((entry) =>
		statSync(join(directory, entry)).isFile(),
	);

const askAndShowReply = async (page: Page, requests: ProviderRequest[]) => {
	await page.getByRole("button", { name: "Ask Assistant" }).click();
	try {
		await page.getByText(reply).waitFor();
	} catch (error) {
		const shown = await page.locator("#reply").innerText();
		const providerState = await page.locator("#provider-status").innerText();
		const urls = requests.map((request) => request.url).join(", ");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nreply: ${shown}\nprovider: ${providerState}\nrequests: ${urls}`,
			{ cause: error },
		);
	}
};

it("shows the configured provider reply and keeps the api key out of the stored resume", async () => {
	const runDirectory = join(tmpdir(), `reactive-resume-provider-${process.pid}`);
	rmSync(runDirectory, { recursive: true, force: true });
	const dataDirectory = join(runDirectory, "data");
	const provider = await startProvider();
	const detailFor = (logs: string[], pageErrors: string[]) =>
		[...pageErrors, relevantLog(logs)].join("\n").slice(-4000);

	try {
		const first = await openDesktop(join(runDirectory, "webview-a"), dataDirectory);
		try {
			await first.page.getByRole("button", { name: "New Resume" }).click();
			await first.page.getByLabel("Name").fill(name);
			await first.page.getByRole("button", { name: "Summary", exact: true }).click();
			await first.page.getByRole("textbox", { name: "Summary" }).fill(summary);
			await first.page.getByLabel("Provider").fill(provider.baseUrl);
			await first.page.getByLabel("Model").fill(model);
			await first.page.getByLabel("API key").fill(apiKey);
			expect(await first.page.getByLabel("API key").inputValue()).toBe(apiKey);
			await first.page.getByRole("button", { name: "Save Provider" }).click();
			await first.page.getByText("Provider saved").waitFor();
			await first.page.getByLabel("API key").fill("");
			await askAndShowReply(first.page, provider.requests);

			const firstRequest = provider.requests[0];
			if (!firstRequest) throw new Error("provider received no assistant request");
			expect(provider.requests.map((request) => request.url)).toEqual([`${provider.baseUrl}/chat/completions`]);
			expect((JSON.parse(firstRequest.body) as { model?: string }).model).toBe(model);

			const storedResume = readFileSync(join(dataDirectory, "resume.json"), "utf8");
			expect(storedResume).toContain(name);
			expect(storedResume).toContain(summary);
			expect(storedResume).not.toContain(apiKey);
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}\n${detailFor(first.logs, first.pageErrors)}`,
			);
		} finally {
			await first.close();
		}

		const second = await openDesktop(join(runDirectory, "webview-b"), dataDirectory);
		try {
			await expect
				.poll(async () => second.page.getByLabel("Provider").inputValue(), { timeout: 30_000 })
				.toBe(provider.baseUrl);
			await expect.poll(async () => second.page.getByLabel("Model").inputValue(), { timeout: 30_000 }).toBe(model);
			await expect.poll(async () => second.page.getByLabel("API key").inputValue(), { timeout: 30_000 }).toBe("");
			await askAndShowReply(second.page, provider.requests);

			expect(provider.requests.map((request) => request.url)).toEqual([
				`${provider.baseUrl}/chat/completions`,
				`${provider.baseUrl}/chat/completions`,
			]);
			expect(provider.requests.map((request) => (JSON.parse(request.body) as { model?: string }).model)).toEqual([
				model,
				model,
			]);
			const documents = storedDocuments(dataDirectory);
			expect(documents.length).toBeGreaterThan(0);
			for (const documentName of documents) {
				expect(readFileSync(join(dataDirectory, documentName), "utf8")).not.toContain(apiKey);
			}
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}\n${detailFor(second.logs, second.pageErrors)}`,
			);
		} finally {
			await second.close();
		}
	} finally {
		await provider.close();
		stopWindow();
	}
});
