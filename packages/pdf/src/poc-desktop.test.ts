import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sampleResumeData } from "@reactive-resume/schema/resume/sample";
import { createResumePdfFile } from "./server";

const outDir = resolve(__dirname, "../../../poc-out");
const fontDir = resolve(outDir, "fonts");
const manifestPath = resolve(fontDir, "manifest.json");

const isGstatic = (href: string) => href.includes("gstatic");

const save = async (name: string) => {
	const file = await createResumePdfFile({ data: sampleResumeData, filename: name });
	mkdirSync(outDir, { recursive: true });
	writeFileSync(resolve(outDir, name), Buffer.from(await file.arrayBuffer()));
	return file;
};

afterEach(() => {
	vi.unstubAllGlobals();
});

it("renders online and caches Google fonts to disk", async () => {
	const realFetch = globalThis.fetch;
	const manifest: Record<string, string> = {};
	mkdirSync(fontDir, { recursive: true });
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const response = await realFetch(input, init);
		if (isGstatic(href) && response.ok) {
			const url = new URL(href);
			const file = `font-${Object.keys(manifest).length}.bin`;
			manifest[url.pathname] = file;
			writeFileSync(resolve(fontDir, file), Buffer.from(await response.clone().arrayBuffer()));
		}
		return response;
	});
	const file = await save("online.pdf");
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
	expect(file.size).toBeGreaterThan(1000);
	expect(Object.keys(manifest).length).toBeGreaterThan(0);
}, 120_000);

it("renders offline using fonts bundled on disk", async () => {
	expect(existsSync(manifestPath)).toBe(true);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, string>;
	const realFetch = globalThis.fetch;
	vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!isGstatic(href)) return realFetch(input, init);
		const file = manifest[new URL(href).pathname];
		if (!file) return Promise.reject(new TypeError(`no bundled font for ${href}`));
		return Promise.resolve(new Response(readFileSync(resolve(fontDir, file))));
	});
	const file = await save("offline-bundled-fonts.pdf");
	expect(file.size).toBeGreaterThan(1000);
}, 120_000);

it("fails offline when Google fonts are not bundled", async () => {
	const realFetch = globalThis.fetch;
	vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (isGstatic(href)) return Promise.reject(new TypeError("offline"));
		return realFetch(input, init);
	});
	await expect(save("should-not-exist.pdf")).rejects.toThrow(/Fonts could not be loaded/);
}, 120_000);
