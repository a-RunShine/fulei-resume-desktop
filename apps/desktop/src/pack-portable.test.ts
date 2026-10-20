import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { componentHashes, stageNodeExecutable, stageServer, stageWebApp } from "../scripts/pack-portable.mjs";

function temporaryDirectory() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "rr-pack-"));
}

it("stages only the node executable, the built web app, and external server files", () => {
	const root = temporaryDirectory();
	const nodeSource = path.join(root, "node-source");
	fs.mkdirSync(nodeSource);
	fs.writeFileSync(path.join(nodeSource, "node.exe"), "node-runtime");
	fs.writeFileSync(path.join(nodeSource, "npm"), "npm-cli");
	fs.writeFileSync(path.join(nodeSource, "npx"), "npx-cli");
	fs.writeFileSync(path.join(nodeSource, "corepack"), "corepack-cli");
	fs.writeFileSync(path.join(nodeSource, "node.h"), "dev-header");

	const dist = path.join(root, "dist");
	const prerender = path.join(root, "dist-prerender");
	fs.mkdirSync(dist);
	fs.mkdirSync(prerender);
	fs.writeFileSync(path.join(dist, "index.html"), "built-app");
	fs.writeFileSync(path.join(prerender, "index.html"), "marketing-page");

	const bundle = path.join(root, "bundle");
	const modules = path.join(root, "modules");
	const migrations = path.join(root, "migrations");
	fs.mkdirSync(bundle);
	fs.mkdirSync(modules);
	fs.mkdirSync(migrations);
	fs.writeFileSync(path.join(bundle, "desktop-host.mjs"), "import { PGlite } from '@electric-sql/pglite';\n");
	fs.writeFileSync(path.join(migrations, "0001.sql"), "select 1;");
	fs.mkdirSync(path.join(modules, "hono"));
	fs.writeFileSync(path.join(modules, "hono", "index.js"), "export const hono = true;\n");
	const wasmDir = path.join(modules, "@electric-sql", "pglite", "dist");
	fs.mkdirSync(wasmDir, { recursive: true });
	fs.writeFileSync(path.join(wasmDir, "index.js"), "export class PGlite {}\n");
	fs.writeFileSync(path.join(wasmDir, "pglite.wasm"), "wasm-bytes");
	const nativeDir = path.join(modules, "@img", "sharp-win32-x64");
	fs.mkdirSync(nativeDir, { recursive: true });
	fs.writeFileSync(path.join(nativeDir, "sharp.node"), "native-bytes");
	fs.mkdirSync(path.join(modules, "sharp"));
	fs.writeFileSync(path.join(modules, "sharp", "index.js"), "export default {};\n");

	const staging = path.join(root, "staging");
	stageNodeExecutable(nodeSource, path.join(staging, "node"));
	stageWebApp(dist, prerender, path.join(staging, "web"));
	stageServer({
		bundleDir: bundle,
		modulesDir: modules,
		migrationsDir: migrations,
		destination: path.join(staging, "server"),
	});

	expect(fs.readdirSync(path.join(staging, "node")).sort()).toEqual(["node.exe"]);
	expect(fs.readFileSync(path.join(staging, "node", "node.exe"), "utf8")).toBe("node-runtime");
	expect(fs.readFileSync(path.join(staging, "web", "dist", "index.html"), "utf8")).toBe("built-app");
	expect(fs.existsSync(path.join(staging, "web", "dist-prerender"))).toBe(false);
	expect(fs.readFileSync(path.join(staging, "server", "desktop-host.mjs"), "utf8")).toContain("@electric-sql/pglite");
	expect(fs.readFileSync(path.join(staging, "server", "migrations", "0001.sql"), "utf8")).toBe("select 1;");
	expect(fs.existsSync(path.join(staging, "server", "node_modules", "hono"))).toBe(false);
	expect(
		fs.readFileSync(
			path.join(staging, "server", "node_modules", "@electric-sql", "pglite", "dist", "pglite.wasm"),
			"utf8",
		),
	).toBe("wasm-bytes");
	expect(fs.existsSync(path.join(staging, "server", "node_modules", "sharp"))).toBe(true);
	expect(
		fs.readFileSync(path.join(staging, "server", "node_modules", "@img", "sharp-win32-x64", "sharp.node"), "utf8"),
	).toBe("native-bytes");

	fs.writeFileSync(path.join(staging, "server", "desktop-host.mjs"), "server-a");
	fs.writeFileSync(path.join(staging, "web", "dist", "index.html"), "web-a");
	fs.mkdirSync(path.join(staging, "webview2"));
	fs.writeFileSync(path.join(staging, "webview2", "msedgewebview2.exe"), "webview-a");
	const first = componentHashes(staging);
	fs.writeFileSync(path.join(staging, "node", "node.exe"), "node-b");
	const second = componentHashes(staging);
	expect(second.node).not.toBe(first.node);
	expect(second.server).toBe(first.server);
	expect(second.web).toBe(first.web);
	expect(second.webview2).toBe(first.webview2);
	expect(new Set([second.node, second.server, second.web, second.webview2]).size).toBe(4);

	fs.rmSync(root, { recursive: true, force: true });
});
