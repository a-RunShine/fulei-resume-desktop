export type Runtime = "desktop" | "browser";

export const detectionRuntime = (scope: unknown): Runtime =>
	typeof scope === "object" && scope !== null && "__TAURI_INTERNALS__" in scope ? "desktop" : "browser";
