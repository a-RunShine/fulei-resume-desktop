import { downloadWithAnchor } from "@reactive-resume/utils/file";
import { detectionRuntime } from "@/libs/desktop-runtime";

export type SaveTarget = {
	suggestedName: string;
	blob: Blob;
};

export type SaveDestination = "desktop" | "browser";

export { detectionRuntime };

const saveThroughDialog = async ({ suggestedName, blob }: SaveTarget) => {
	const [{ save }, { writeFile }, { downloadDir, join }] = await Promise.all([
		import("@tauri-apps/plugin-dialog"),
		import("@tauri-apps/plugin-fs"),
		import("@tauri-apps/api/path"),
	]);
	const directory = await downloadDir().catch(() => null);
	const defaultPath = directory ? await join(directory, suggestedName) : suggestedName;
	const path = await save({ defaultPath });
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

	await dialog(target);
}

export async function downloadFile(target: SaveTarget, dialog?: (target: SaveTarget) => Promise<void>) {
	await saveFile(target, detectionRuntime(globalThis), dialog);
}
