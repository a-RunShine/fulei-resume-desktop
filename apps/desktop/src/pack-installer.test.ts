import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import * as packInstaller from "../scripts/pack-installer.mjs";
import {
	externalPackageNames,
	importedPackages,
	missingExternalPackages,
	stageNodeExecutable,
	stageRuntime,
	stageServer,
	stageWebApp,
	verifyRuntimeLayout,
} from "../scripts/pack-installer.mjs";

type RuntimeFixture = {
	root: string;
	runtime: string;
	nodeSource: string;
	distDir: string;
	bundleDir: string;
	modulesDir: string;
	migrationsDir: string;
};

function createFixture(): RuntimeFixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "rr-installer-"));
	const nodeSource = path.join(root, "node-source");
	fs.mkdirSync(nodeSource);
	fs.writeFileSync(path.join(nodeSource, "node.exe"), "node-runtime");
	fs.writeFileSync(path.join(nodeSource, "npm"), "npm-cli");
	fs.writeFileSync(path.join(nodeSource, "npx"), "npx-cli");
	fs.writeFileSync(path.join(nodeSource, "corepack"), "corepack-cli");
	fs.writeFileSync(path.join(nodeSource, "node.h"), "dev-header");

	const distDir = path.join(root, "dist");
	fs.mkdirSync(distDir);
	fs.writeFileSync(path.join(distDir, "index.html"), "built-app");

	const bundleDir = path.join(root, "bundle");
	const modulesDir = path.join(root, "modules");
	const migrationsDir = path.join(root, "migrations");
	fs.mkdirSync(bundleDir);
	fs.mkdirSync(modulesDir);
	fs.mkdirSync(migrationsDir);
	fs.writeFileSync(path.join(bundleDir, "desktop-host.mjs"), "import { PGlite } from '@electric-sql/pglite';\n");
	fs.writeFileSync(path.join(migrationsDir, "0001.sql"), "select 1;");

	fs.mkdirSync(path.join(modulesDir, "hono"));
	fs.writeFileSync(path.join(modulesDir, "hono", "index.js"), "export const hono = true;\n");

	const wasmDir = path.join(modulesDir, "@electric-sql", "pglite", "dist");
	fs.mkdirSync(wasmDir, { recursive: true });
	fs.writeFileSync(path.join(wasmDir, "index.js"), "export class PGlite {}\n");
	fs.writeFileSync(path.join(wasmDir, "pglite.wasm"), "wasm-bytes");

	const nativeDir = path.join(modulesDir, "@img", "sharp-win32-x64");
	fs.mkdirSync(nativeDir, { recursive: true });
	fs.writeFileSync(path.join(nativeDir, "sharp.node"), "native-bytes");

	fs.mkdirSync(path.join(modulesDir, "sharp"));
	fs.writeFileSync(
		path.join(modulesDir, "sharp", "package.json"),
		JSON.stringify({
			name: "sharp",
			dependencies: { "detect-libc": "^2.1.2" },
			optionalDependencies: { "@img/sharp-win32-x64": "0.35.5" },
		}),
	);
	fs.writeFileSync(path.join(modulesDir, "sharp", "index.js"), "export default {};\n");

	fs.mkdirSync(path.join(modulesDir, "detect-libc"));
	fs.writeFileSync(path.join(modulesDir, "detect-libc", "package.json"), JSON.stringify({ name: "detect-libc" }));
	fs.writeFileSync(path.join(modulesDir, "detect-libc", "index.js"), "export const family = 'glibc';\n");

	fs.mkdirSync(path.join(modulesDir, "css-tree"));
	fs.writeFileSync(path.join(modulesDir, "css-tree", "package.json"), JSON.stringify({ name: "css-tree" }));
	fs.mkdirSync(path.join(modulesDir, "mdn-data"));
	fs.writeFileSync(path.join(modulesDir, "mdn-data", "package.json"), JSON.stringify({ name: "mdn-data" }));

	return {
		root,
		runtime: path.join(root, "runtime"),
		nodeSource,
		distDir,
		bundleDir,
		modulesDir,
		migrationsDir,
	};
}

function stageFixture(fixture: RuntimeFixture) {
	return stageRuntime({
		runtimeDir: fixture.runtime,
		nodeSource: fixture.nodeSource,
		distDir: fixture.distDir,
		bundleDir: fixture.bundleDir,
		modulesDir: fixture.modulesDir,
		migrationsDir: fixture.migrationsDir,
	});
}

it("stages node, server, and web as sibling runtime directories", () => {
	const fixture = createFixture();
	stageFixture(fixture);

	const entries = fs.readdirSync(fixture.runtime).sort();
	expect(entries).toEqual(["node", "server", "web"]);

	expect(fs.readdirSync(path.join(fixture.runtime, "node")).sort()).toEqual(["node.exe"]);
	expect(fs.readFileSync(path.join(fixture.runtime, "node", "node.exe"), "utf8")).toBe("node-runtime");

	expect(fs.readFileSync(path.join(fixture.runtime, "web", "dist", "index.html"), "utf8")).toBe("built-app");
	expect(fs.existsSync(path.join(fixture.runtime, "web", "dist-prerender"))).toBe(false);

	expect(fs.readFileSync(path.join(fixture.runtime, "server", "desktop-host.mjs"), "utf8")).toContain(
		"@electric-sql/pglite",
	);
	expect(fs.readFileSync(path.join(fixture.runtime, "server", "migrations", "0001.sql"), "utf8")).toBe("select 1;");
	expect(JSON.parse(fs.readFileSync(path.join(fixture.runtime, "server", "package.json"), "utf8"))).toMatchObject({
		private: true,
		type: "module",
	});

	const serverModules = path.join(fixture.runtime, "server", "node_modules");
	expect(fs.existsSync(path.join(serverModules, "hono"))).toBe(false);
	expect(fs.existsSync(path.join(serverModules, "@electric-sql", "pglite", "dist", "pglite.wasm"))).toBe(true);
	expect(fs.existsSync(path.join(serverModules, "sharp"))).toBe(true);
	expect(fs.existsSync(path.join(serverModules, "detect-libc"))).toBe(true);
	expect(fs.existsSync(path.join(serverModules, "@img", "sharp-win32-x64", "sharp.node"))).toBe(true);
	expect(fs.existsSync(path.join(serverModules, "css-tree"))).toBe(true);
	expect(fs.existsSync(path.join(serverModules, "mdn-data"))).toBe(true);

	expect(fs.existsSync(path.join(fixture.runtime, "manifest.json"))).toBe(false);
	expect(fs.existsSync(path.join(fixture.runtime, ".complete"))).toBe(false);
	expect(fs.existsSync(path.join(fixture.runtime, "webview2"))).toBe(false);
	expect(fs.readdirSync(fixture.runtime).some((name) => name.endsWith(".zip"))).toBe(false);

	fs.rmSync(fixture.root, { recursive: true, force: true });
});

it("drops files left behind by a previous staging run", () => {
	const fixture = createFixture();
	stageFixture(fixture);

	fs.writeFileSync(path.join(fixture.runtime, "server", "stale-host.mjs"), "stale");
	fs.mkdirSync(path.join(fixture.runtime, "webview2"));
	fs.writeFileSync(path.join(fixture.runtime, "webview2", "msedgewebview2.exe"), "browser");
	fs.writeFileSync(path.join(fixture.runtime, "manifest.json"), "{}");
	fs.writeFileSync(path.join(fixture.runtime, ".complete"), "done");

	stageFixture(fixture);

	expect(fs.existsSync(path.join(fixture.runtime, "server", "stale-host.mjs"))).toBe(false);
	expect(fs.existsSync(path.join(fixture.runtime, "webview2"))).toBe(false);
	expect(fs.existsSync(path.join(fixture.runtime, "manifest.json"))).toBe(false);
	expect(fs.existsSync(path.join(fixture.runtime, ".complete"))).toBe(false);

	fs.rmSync(fixture.root, { recursive: true, force: true });
});

it("checks the runtime layout the startup side requires", () => {
	const fixture = createFixture();
	stageFixture(fixture);
	expect(() => verifyRuntimeLayout(fixture.runtime)).not.toThrow();

	fs.rmSync(path.join(fixture.runtime, "node"), { recursive: true, force: true });
	expect(() => verifyRuntimeLayout(fixture.runtime)).toThrow(/node/);

	stageFixture(fixture);
	fs.rmSync(path.join(fixture.runtime, "server", "desktop-host.mjs"));
	expect(() => verifyRuntimeLayout(fixture.runtime)).toThrow(/desktop-host\.mjs/);

	stageFixture(fixture);
	fs.rmSync(path.join(fixture.runtime, "web", "dist", "index.html"));
	expect(() => verifyRuntimeLayout(fixture.runtime)).toThrow(/index\.html/);

	fs.rmSync(fixture.root, { recursive: true, force: true });
});

it("reports imported external packages missing from the server directory", () => {
	const fixture = createFixture();
	stageFixture(fixture);
	expect(missingExternalPackages(path.join(fixture.runtime, "server"))).toEqual([]);

	fs.rmSync(path.join(fixture.runtime, "server", "node_modules", "@electric-sql"), { recursive: true, force: true });
	expect(missingExternalPackages(path.join(fixture.runtime, "server"))).toEqual(["@electric-sql/pglite"]);

	fs.rmSync(fixture.root, { recursive: true, force: true });
});

it("keeps the external package rules and their runtime closure", () => {
	const fixture = createFixture();
	expect(externalPackageNames(fixture.modulesDir).sort()).toEqual(
		["@electric-sql/pglite", "@img/sharp-win32-x64", "css-tree", "detect-libc", "mdn-data", "sharp"].sort(),
	);

	const destination = path.join(fixture.root, "server-only");
	stageServer({
		bundleDir: fixture.bundleDir,
		modulesDir: fixture.modulesDir,
		migrationsDir: fixture.migrationsDir,
		destination,
	});
	expect(fs.existsSync(path.join(destination, "node_modules", "detect-libc"))).toBe(true);
	expect(fs.existsSync(path.join(destination, "node_modules", "hono"))).toBe(false);

	fs.rmSync(fixture.root, { recursive: true, force: true });
});

it("stages only the node executable and the built web app", () => {
	const fixture = createFixture();
	const prerender = path.join(fixture.root, "dist-prerender");
	fs.mkdirSync(prerender);
	fs.writeFileSync(path.join(prerender, "index.html"), "marketing-page");

	const nodeDestination = path.join(fixture.root, "node-only");
	const webDestination = path.join(fixture.root, "web-only");
	stageNodeExecutable(fixture.nodeSource, nodeDestination);
	stageWebApp(fixture.distDir, webDestination);

	expect(fs.readdirSync(nodeDestination).sort()).toEqual(["node.exe"]);
	expect(fs.readdirSync(webDestination).sort()).toEqual(["dist"]);
	expect(fs.existsSync(path.join(webDestination, "dist-prerender"))).toBe(false);

	fs.rmSync(fixture.root, { recursive: true, force: true });
});

it("reads runtime package imports and ignores comments and node builtins", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "rr-imports-"));
	fs.writeFileSync(
		path.join(root, "host.mjs"),
		[
			`import { PGlite } from "@electric-sql/pglite";`,
			`import { createServer } from "net";`,
			`import { join } from "node:path";`,
			`Buffer.from("AGFzbQEAAAABJwdgAX8Bf2ADf39");`,
			`throw new ORPCError("BAD_REQUEST", { message: "no" });`,
			`/** @type {import('kysely')} */`,
			`/* import { sql } from 'hono' */`,
			`try { require("@napi-rs/canvas"); } catch {}`,
			`await import("@opentelemetry/api");`,
		].join("\n"),
	);
	expect([...importedPackages(root)].sort()).toEqual(["@electric-sql/pglite"]);
	fs.rmSync(root, { recursive: true, force: true });
});

it("exposes no zip, trailer, or component manifest helpers", () => {
	const exported = Object.keys(packInstaller);
	for (const name of [
		"writeStoredZip",
		"appendPortablePayload",
		"sealPortable",
		"componentHashes",
		"writeComponentManifest",
		"hashDirectory",
		"collectFiles",
	]) {
		expect(exported).not.toContain(name);
	}
	expect(typeof packInstaller.stageRuntime).toBe("function");
});
