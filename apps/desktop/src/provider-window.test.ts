import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { afterAll, expect, it } from "vitest";
import { expect as expectPage } from "@playwright/test";
import {
	blockExternal,
	desktopDataDirectory,
	desktopPort,
	filesUnder,
	killLeftoverWindows,
	openDesktopWindow,
	stopWindow,
	windowDirectory,
} from "./window-runtime";

const reply = "Lead with the interface work.";
const model = "desktop-stub";
const apiKey = "sk-desktop-window-provider-key";

afterAll(() => {
	stopWindow();
	killLeftoverWindows();
});

type ProviderRequest = { url: string; body: string; authorization: string | undefined };

const startProvider = async () => {
	const requests: ProviderRequest[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const streamed = body.includes('"stream":true');
			const host = request.headers.host ?? "";
			requests.push({
				url: `http://${host}${request.url ?? ""}`,
				body,
				authorization: request.headers.authorization,
			});
			if (!streamed) {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						id: "chatcmpl-window",
						object: "chat.completion",
						created: 0,
						model,
						choices: [{ index: 0, message: { role: "assistant", content: "1" }, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}),
				);
				return;
			}
			response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
			const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
				response.write(
					`data: ${JSON.stringify({ id: "chatcmpl-window", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
				);
			chunk({ role: "assistant", content: "" });
			for (const word of reply.split(" ")) chunk({ content: `${word} ` });
			chunk({}, "stop");
			response.end("data: [DONE]\n\n");
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
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
};

const createBlankResume = async (page: Page) => {
	const created = await page.request.post(`http://127.0.0.1:${desktopPort}/api/openapi/resumes`, {
		data: { name: "助手会话", tags: [], withSampleData: true },
	});
	expect(created.status()).toBe(200);
	return (await created.json()) as string;
};

const openAssistant = async (page: Page) => {
	await page.getByRole("button", { name: "Assistant", exact: true }).click();
	const assistant = page.getByRole("region", { name: "Assistant" });
	await expectPage(assistant).toBeVisible({ timeout: 180_000 });
	return assistant;
};

const connectProvider = async (assistant: ReturnType<Page["getByRole"]>, baseUrl: string) => {
	await assistant.getByRole("button", { name: "Other · OpenAI-compatible" }).click();
	await assistant.getByLabel("Base URL").fill(baseUrl);
	await assistant.getByLabel("API key").fill(apiKey);
	await assistant.getByLabel("Model").fill(model);
	await assistant.getByRole("button", { name: "Connect" }).click();
	await expectPage(assistant.getByLabel("Message the assistant")).toBeVisible({ timeout: 180_000 });
};

const chatRequests = (requests: ProviderRequest[]) =>
	requests.filter((request) => request.body.includes('"stream":true'));

const ask = async (
	page: Page,
	assistant: ReturnType<Page["getByRole"]>,
	provider: { requests: ProviderRequest[] },
	expected: number,
) => {
	const composer = assistant.getByLabel("Message the assistant");
	await composer.fill("How should my summary open?");
	await composer.press("Enter");
	await expectPage.poll(() => chatRequests(provider.requests).length, { timeout: 180_000 }).toBe(expected);
	await expectPage(page.getByText(reply).last()).toBeVisible({ timeout: 180_000 });
};

it("answers through the provider the window saved, and the key never reaches the resume store", async () => {
	const directory = windowDirectory("provider");
	const provider = await startProvider();
	const first = await openDesktopWindow({
		appDirectory: directory,
		debugPort: 9331,
		environment: { FLAG_ALLOW_UNSAFE_AI_BASE_URL: "true" },
	});

	try {
		await blockExternal(first.page);
		const resumeId = await createBlankResume(first.page);
		await first.page.goto(`http://127.0.0.1:${desktopPort}/builder/${resumeId}`);
		await first.page.waitForURL(/\/builder\/.+/);
		await expectPage(first.page.getByRole("textbox", { name: "Full name", exact: true })).toBeVisible({
			timeout: 180_000,
		});

		const assistant = await openAssistant(first.page);
		await connectProvider(assistant, provider.baseUrl);
		await ask(first.page, assistant, provider, 1);

		const sent = chatRequests(provider.requests);
		expect(sent).toHaveLength(1);
		const request = sent[0];
		if (!request) throw new Error("the provider received no chat request");
		expect(request.url).toBe(`${provider.baseUrl}/chat/completions`);
		expect((JSON.parse(request.body) as { model?: string }).model).toBe(model);
		expect(request.authorization).toBe(`Bearer ${apiKey}`);
	} finally {
		await first.close();
	}

	const stored = filesUnder(desktopDataDirectory(directory));
	expect(stored.length).toBeGreaterThan(0);
	for (const path of stored) expect(readFileSync(path).includes(apiKey)).toBe(false);

	const second = await openDesktopWindow({
		appDirectory: directory,
		debugPort: 9332,
		environment: { FLAG_ALLOW_UNSAFE_AI_BASE_URL: "true" },
	});
	try {
		await blockExternal(second.page);
		await second.page.goto(`http://127.0.0.1:${desktopPort}/dashboard`);
		await expectPage(second.page.getByRole("heading", { name: "Documents" })).toBeVisible({ timeout: 180_000 });
		await second.page.getByRole("link", { name: "助手会话", exact: true }).first().click();
		await second.page.waitForURL(/\/builder\/.+/);
		const assistant = await openAssistant(second.page);
		await expectPage(assistant.getByLabel("Message the assistant")).toBeVisible({ timeout: 180_000 });
		await ask(second.page, assistant, provider, 2);
		const [secondRequest] = chatRequests(provider.requests).slice(-1);
		if (!secondRequest) throw new Error("the provider received no second chat request");
		expect(secondRequest.url).toBe(`${provider.baseUrl}/chat/completions`);
		expect(secondRequest.authorization).toBe(`Bearer ${apiKey}`);
	} finally {
		await second.close();
	}
});
