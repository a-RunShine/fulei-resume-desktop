// @vitest-environment happy-dom

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../public");
const variants = ["light", "dark"] as const;
const brandFiles = [...variants.map((variant) => `icon/${variant}.svg`), "favicon.svg"];

const read = (relative: string) => fs.readFileSync(path.join(publicDir, relative), "utf8");
const parse = (source: string) => new DOMParser().parseFromString(source, "image/svg+xml");

describe("shipped brand artwork", () => {
	it.each(brandFiles)("parses %s as well-formed markup", (relative) => {
		const document = parse(read(relative));

		expect(document.querySelector("parsererror")).toBeNull();
		expect(document.documentElement.tagName.toLowerCase()).toBe("svg");
	});

	it.each(brandFiles)("carries a complete accessible label on %s", (relative) => {
		const document = parse(read(relative));
		const label = document.documentElement.getAttribute("aria-label") ?? "";

		expect(label.length).toBeGreaterThan(0);
		expect(label).not.toMatch(/\uFFFD/);
		expect(label).toBe(label.trim());
		expect(label).toBe("Fulei Resume");
	});

	it.each(brandFiles)("keeps the label attribute closed and quote-free on %s", (relative) => {
		const source = read(relative);
		const closing = source.match(/aria-label="([^"]*)"/);

		expect(closing).not.toBeNull();
		expect(closing?.[1]).not.toContain("<");
		expect(closing?.[1]).not.toContain('"');
	});

	it("ships a mark for every surface that asks for one", () => {
		for (const variant of variants) {
			expect(fs.existsSync(path.join(publicDir, "icon", `${variant}.svg`))).toBe(true);
			expect(fs.existsSync(path.join(publicDir, "logo", `${variant}.svg`))).toBe(true);
		}
	});

	it("keeps the light and dark marks identical so neither theme renders blank", () => {
		expect(read("icon/light.svg")).toBe(read("icon/dark.svg"));
	});
});
