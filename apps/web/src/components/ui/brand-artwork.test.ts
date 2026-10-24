// @vitest-environment happy-dom

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../public");
const variants = ["light", "dark"] as const;
const marks = ["icon", "logo"] as const;
const brandFiles = [...marks.flatMap((mark) => variants.map((variant) => `${mark}/${variant}.svg`)), "favicon.svg"];

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
		const closing = read(relative).match(/aria-label="([^"]*)"/);

		expect(closing).not.toBeNull();
		expect(closing?.[1]).not.toContain("<");
		expect(closing?.[1]).not.toContain('"');
	});

	it.each(brandFiles)("draws no text, so a missing font cannot break %s", (relative) => {
		expect(read(relative)).not.toContain("<text");
	});

	it.each(brandFiles)("declares a viewBox so the mark scales without a width hint", (relative) => {
		expect(parse(read(relative)).documentElement.getAttribute("viewBox")).toBeTruthy();
	});

	it("ships every variant the component asks for", () => {
		for (const mark of marks) {
			for (const variant of variants) {
				expect(fs.existsSync(path.join(publicDir, mark, `${variant}.svg`))).toBe(true);
			}
		}
	});

	it("gives each theme its own ink so neither variant renders blank", () => {
		expect(read("icon/light.svg")).not.toBe(read("icon/dark.svg"));
		expect(read("logo/light.svg")).not.toBe(read("logo/dark.svg"));
	});

	it("fills the dark variants with a light ink that reads on a dark surface", () => {
		expect(read("icon/dark.svg")).toContain("#FAFAFA");
		expect(read("logo/dark.svg")).toContain("#FAFAFA");
		expect(read("icon/light.svg")).toContain("#111111");
		expect(read("logo/light.svg")).toContain("#111111");
	});

	it("puts the FL wordmark on the favicon tile rather than a lone glyph", () => {
		const source = read("favicon.svg");

		expect(source).toContain("<rect");
		expect(source).toContain("<path");
	});
});
