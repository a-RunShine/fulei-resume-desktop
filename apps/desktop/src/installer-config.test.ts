import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const srcTauriDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src-tauri");
const configPath = path.join(srcTauriDir, "tauri.conf.json");
const hooksPath = path.join(srcTauriDir, "windows", "hooks.nsh");

type BundleConfig = {
	active?: boolean;
	targets?: string[];
	resources?: Record<string, string>;
	windows?: {
		webviewInstallMode?: { type?: string };
		nsis?: { installMode?: string; installerHooks?: string };
	};
};

function readConfig() {
	return JSON.parse(fs.readFileSync(configPath, "utf8")) as {
		productName?: string;
		mainBinaryName?: string;
		build?: { beforeBuildCommand?: string; frontendDist?: string };
		bundle?: BundleConfig;
	};
}

it("targets only the NSIS installer for a per-machine install", () => {
	const config = readConfig();

	expect(config.bundle?.active).toBe(true);
	expect(config.bundle?.targets).toEqual(["nsis"]);
	expect(config.bundle?.windows?.nsis?.installMode).toBe("perMachine");
});

it("never bundles or downloads a WebView2 runtime", () => {
	const config = readConfig();

	expect(config.bundle?.windows?.webviewInstallMode).toEqual({ type: "skip" });
});

it("names the main binary like the product while keeping the frontend build", () => {
	const config = readConfig();

	expect(config.productName).toBe("Reactive Resume");
	expect(config.mainBinaryName).toBe("Reactive Resume");
	expect(config.build?.frontendDist).toBe("../../web/dist");
	expect(config.build?.beforeBuildCommand).toBeTruthy();
});

it("maps the staged runtime to the install root so node, server and web sit beside the executable", () => {
	const config = readConfig();
	const resources = config.bundle?.resources ?? {};

	expect(resources).toEqual({
		"../.cache/installer/runtime/node": "node",
		"../.cache/installer/runtime/server": "server",
		"../.cache/installer/runtime/web": "web",
	});

	for (const source of Object.keys(resources)) {
		expect(path.resolve(srcTauriDir, source)).toBe(
			path.join(path.dirname(srcTauriDir), ".cache", "installer", "runtime", path.basename(source)),
		);
	}

	for (const target of Object.values(resources)) {
		expect(path.posix.normalize(target)).toBe(target);
		expect(target.includes("/")).toBe(false);
		expect(target).not.toBe("");
		expect(target).not.toBe(".");
	}
});

it("creates the resource directories before the tauri build script validates them", () => {
	const buildScript = fs.readFileSync(path.join(srcTauriDir, "build.rs"), "utf8");
	const config = readConfig();

	for (const source of Object.keys(config.bundle?.resources ?? {})) {
		const name = path.basename(source);
		expect(buildScript).toContain(`"${name}"`);
	}

	expect(buildScript.indexOf("create_dir_all")).toBeLessThan(buildScript.indexOf("tauri_build::build"));
});

it("points the installer hook at the committed hooks script", () => {
	const config = readConfig();
	const hooks = config.bundle?.windows?.nsis?.installerHooks;

	expect(hooks).toBe("windows/hooks.nsh");
	expect(path.resolve(srcTauriDir, hooks ?? "")).toBe(hooksPath);
	expect(fs.existsSync(hooksPath)).toBe(true);
});

it("deletes the app data directory only when the uninstall checkbox is ticked outside an upgrade", () => {
	const hooks = fs.readFileSync(hooksPath, "utf8");

	expect(hooks).toContain("!macro NSIS_HOOK_POSTUNINSTALL");
	expect(hooks).toContain("!macroend");
	expect(hooks).toContain("$DeleteAppDataCheckboxState = 1");
	expect(hooks).toContain("$UpdateMode <> 1");
	expect(hooks).toContain('RMDir /r "$LOCALAPPDATA\\Reactive Resume"');
	expect(hooks).toContain("${AndIf}");

	const deleteIndex = hooks.indexOf('RMDir /r "$LOCALAPPDATA\\Reactive Resume"');
	expect(hooks.indexOf("$DeleteAppDataCheckboxState = 1")).toBeLessThan(deleteIndex);
	expect(hooks.indexOf("$UpdateMode <> 1")).toBeLessThan(deleteIndex);
});

it("removes nothing except the app data directory from the uninstall hook", () => {
	const hooks = fs.readFileSync(hooksPath, "utf8");
	const removalLines = hooks
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("RMDir") || line.startsWith("Delete"));

	expect(removalLines).toEqual(['RMDir /r "$LOCALAPPDATA\\Reactive Resume"']);
});
