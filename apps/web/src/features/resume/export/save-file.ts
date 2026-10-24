import { downloadWithAnchor } from "@reactive-resume/utils/file";
import { detectionRuntime, type Runtime } from "@/libs/desktop-runtime";

export type SaveTarget = {
	suggestedName: string;
	blob: Blob;
};

export type SaveOutcome = "saved" | "cancelled";

const saveThroughDialog = async ({ suggestedName, blob }: SaveTarget): Promise<SaveOutcome> => {
	const [{ save }, { writeFile }, { downloadDir, join }] = await Promise.all([
		import("@tauri-apps/plugin-dialog"),
		import("@tauri-apps/plugin-fs"),
		import("@tauri-apps/api/path"),
	]);
	const directory = await downloadDir().catch(() => null);
	const defaultPath = directory ? await join(directory, suggestedName) : suggestedName;
	const path = await save({ defaultPath });
	if (!path) return "cancelled";
	await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
	return "saved";
};

export function saveFile(
	target: SaveTarget,
	destination: Runtime,
	dialog: (target: SaveTarget) => Promise<SaveOutcome> = saveThroughDialog,
): Promise<SaveOutcome> {
	if (destination === "browser") {
		downloadWithAnchor(target.blob, target.suggestedName);
		return Promise.resolve("saved");
	}

	return dialog(target);
}

export function downloadFile(target: SaveTarget, dialog?: (target: SaveTarget) => Promise<SaveOutcome>) {
	return saveFile(target, detectionRuntime(globalThis), dialog);
}
