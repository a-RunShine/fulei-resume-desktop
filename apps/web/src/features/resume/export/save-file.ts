import { downloadWithAnchor } from "@reactive-resume/utils/file";

export type SaveTarget = {
	suggestedName: string;
	blob: Blob;
};

export type SaveDestination = "desktop" | "browser";

export const detectionRuntime = (scope: unknown): SaveDestination =>
	typeof scope === "object" && scope !== null && "__TAURI_INTERNALS__" in scope ? "desktop" : "browser";

const isCancellation = (error: unknown) => error instanceof Error && /cancel|abort|user denied/i.test(error.message);

const saveThroughDialog = async ({ suggestedName, blob }: SaveTarget) => {
	const [{ save }, { writeFile }] = await Promise.all([
		import("@tauri-apps/plugin-dialog"),
		import("@tauri-apps/plugin-fs"),
	]);
	const path = await save({ defaultPath: suggestedName });
	if (!path) return;
	await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
};

export async function saveFile(
	target: SaveTarget,
	destination: SaveDestination,
	dialog: (target: SaveTarget) => Promise<void> = saveThroughDialog,
) {
	if (destination === "browser") {
		downloadWithAnchor(target.blob, target.suggestedName);
		return;
	}

	try {
		await dialog(target);
	} catch (error) {
		if (isCancellation(error)) return;
		throw error;
	}
}
