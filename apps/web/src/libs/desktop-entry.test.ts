import { describe, expect, it } from "vitest";
import { desktopEntryRedirect } from "./desktop-entry";
import { detectionRuntime } from "./desktop-runtime";

describe("detectionRuntime", () => {
	it("reports the desktop runtime when the Tauri bridge is present", () => {
		expect(detectionRuntime({ __TAURI_INTERNALS__: {} })).toBe("desktop");
	});

	it("reports the browser runtime otherwise", () => {
		expect(detectionRuntime({})).toBe("browser");
		expect(detectionRuntime(undefined)).toBe("browser");
		expect(detectionRuntime(null)).toBe("browser");
	});
});

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
});
