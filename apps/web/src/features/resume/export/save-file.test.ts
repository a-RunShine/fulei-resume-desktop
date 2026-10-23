import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectionRuntime, saveFile } from "./save-file";

const download = vi.hoisted(() => vi.fn());

vi.mock("@reactive-resume/utils/file", () => ({ downloadWithAnchor: download }));

const target = () => ({
	blob: new Blob(["payload"], { type: "application/pdf" }),
	suggestedName: "Sam-Taylor-Resume.pdf",
});

describe("detectionRuntime", () => {
	it("reports the desktop runtime when the Tauri bridge is present", () => {
		expect(detectionRuntime({ __TAURI_INTERNALS__: {} })).toBe("desktop");
	});

	it("reports the browser runtime otherwise", () => {
		expect(detectionRuntime({})).toBe("browser");
		expect(detectionRuntime(undefined)).toBe("browser");
		expect(detectionRuntime({ __TAURI_INTERNALS__: undefined })).toBe("desktop");
	});
});

describe("saveFile", () => {
	beforeEach(() => download.mockReset());

	it("asks the browser to download without opening a dialog", async () => {
		const dialog = vi.fn();
		await saveFile(target(), "browser", dialog);

		expect(dialog).not.toHaveBeenCalled();
		expect(download).toHaveBeenCalledWith(expect.any(Blob), "Sam-Taylor-Resume.pdf");
	});

	it("opens the desktop dialog and skips the browser download", async () => {
		const dialog = vi.fn(async () => undefined);
		await saveFile(target(), "desktop", dialog);

		expect(dialog).toHaveBeenCalledOnce();
		expect(download).not.toHaveBeenCalled();
	});

	it("treats a cancelled dialog as nothing to report", async () => {
		const dialog = vi.fn(async () => {
			throw new Error("dialog cancelled by the user");
		});

		await expect(saveFile(target(), "desktop", dialog)).resolves.toBeUndefined();
		expect(download).not.toHaveBeenCalled();
	});

	it("reports a real dialog failure", async () => {
		const dialog = vi.fn(async () => {
			throw new Error("permission denied");
		});

		await expect(saveFile(target(), "desktop", dialog)).rejects.toThrow(/permission denied/);
	});
});
