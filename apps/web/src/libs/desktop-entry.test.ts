// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { desktopEntryRedirect } from "./desktop-entry";
import { detectionRuntime } from "./desktop-runtime";

describe("desktopEntryRedirect", () => {
	it("sends the desktop window back to its own entry point", () => {
		expect(desktopEntryRedirect({ __TAURI_INTERNALS__: {} })).toEqual({
			href: "/desktop/enter",
			reloadDocument: true,
			replace: true,
		});
	});

	it("leaves the browser alone so the web login page still works", () => {
		expect(desktopEntryRedirect({})).toBeUndefined();
		expect(desktopEntryRedirect(globalThis)).toBeUndefined();
	});

	it("reads the same runtime signal the export path uses", () => {
		expect(detectionRuntime({ __TAURI_INTERNALS__: {} })).toBe("desktop");
		expect(detectionRuntime({})).toBe("browser");
	});
});
