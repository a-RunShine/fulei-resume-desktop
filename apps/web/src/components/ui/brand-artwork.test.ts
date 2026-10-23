// @vitest-environment happy-dom

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../public");
const brandFiles = ["icon/light.svg", "icon/dark.svg", "favicon.svg"];

describe("shipped brand artwork", () => {
	it.each(brandFiles)("parses %s as well-formed markup", (relative) => {
		const document = new DOMParser().parseFromString(
			fs.readFileSync(path.join(publicDir, relative), "utf8"),
			"image/svg+xml",
		);

		expect(document.querySelector("parsererror")).toBeNull();
		expect(document.documentElement.tagName.toLowerCase()).toBe("svg");
	});

	it.each(brandFiles)("carries a complete accessible label on %s", (relative) => {
		const document = new DOMParser().parseFromString(
			fs.readFileSync(path.join(publicDir, relative), "utf8"),
			"image/svg+xml",
		);
		const label = document.documentElement.getAttribute("aria-label") ?? "";

		expect(label.length).toBeGreaterThan(0);
		expect(label).not.toMatch(/\uFFFD/);
		expect(label).toBe(label.trim());
	});

	it("keeps the light and dark marks identical so neither theme renders blank", () => {
		const read = (name: string) => fs.readFileSync(path.join(publicDir, "icon", `${name}.svg`), "utf8");

		expect(read("light")).toBe(read("dark"));
	});
});
