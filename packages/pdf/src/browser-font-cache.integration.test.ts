import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { act } from "react";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { createResumePdfBlob } from "./browser";

const resume = () => {
	const data = structuredClone(defaultResumeData);
	data.picture.hidden = true;
	data.picture.url = "";
	data.basics.name = "David Kowalski";
	data.summary.content = "<p>Builds reliable desktop software.</p>";
	data.metadata.layout.pages = [{ fullWidth: true, main: ["summary"], sidebar: [] }];
	return data;
};

const requestHref = (input: RequestInfo | URL) => {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
};

const pdfRoot = fileURLToPath(new URL("..", import.meta.url));

const localFile = (href: string) => {
	const path = decodeURIComponent(href.split("?")[0] ?? "");
	if (path.startsWith("/@fs/")) return path.slice("/@fs/".length);
	if (path.startsWith("/")) return join(pdfRoot, path.slice(1));
	return null;
};

const blockNonLocalHosts = () => {
	const realFetch = globalThis.fetch.bind(globalThis);
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
		const href = requestHref(input);
		const file = localFile(href);
		if (file) {
			const type = file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
			return Promise.resolve(new Response(readFileSync(file), { headers: { "content-type": type } }));
		}
		const hostname = new URL(href).hostname;
		const local = hostname === "localhost" || hostname === "127.0.0.1";
		if (!local) return Promise.reject(new TypeError(`blocked non-local host ${hostname}`));
		return realFetch(input, init);
	});
};

const pdfText = async (blob: Blob) => {
	const document = await getDocument({ data: new Uint8Array(await blob.arrayBuffer()), verbosity: 0 }).promise;
	const page = await document.getPage(1);
	const content = await page.getTextContent();
	return content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
};

afterEach(() => {
	vi.unstubAllGlobals();
});

it("exports the default template while non-local hosts are blocked", { timeout: 60_000 }, async () => {
	blockNonLocalHosts();
	let blob: Blob | undefined;
	await act(async () => {
		blob = await createResumePdfBlob({ data: resume() });
	});
	if (!blob) throw new Error("export returned no PDF");
	vi.unstubAllGlobals();
	const text = await pdfText(blob);
	expect(text).toContain("David Kowalski");
	expect(text).toContain("Builds reliable desktop software.");
});

it("names the missing font and returns no PDF when the cache does not have it", async () => {
	blockNonLocalHosts();
	const data = resume();
	data.metadata.typography.body.fontFamily = "Roboto";
	data.metadata.typography.heading.fontFamily = "Roboto";

	await expect(act(async () => createResumePdfBlob({ data }))).rejects.toThrow(
		"Fonts could not be loaded: Roboto, Noto Sans",
	);
});
