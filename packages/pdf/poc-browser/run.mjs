import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "../../../apps/web/node_modules/vite/dist/node/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const outDir = resolve(repo, "poc-out/browser");
mkdirSync(outDir, { recursive: true });

const port = 5199;
const origin = `http://localhost:${port}`;
const server = await createServer({
	root: here,
	configFile: false,
	logLevel: "warn",
	server: { port, strictPort: true, fs: { allow: [repo] } },
});
await server.listen();

const bundle = (name) => {
	const dir = resolve(repo, `poc-out/${name}`);
	const manifestPath = resolve(dir, "manifest.json");
	return { dir, manifestPath };
};

const scenario = async (name, { path, allowExternal, onGstatic }) => {
	const browser = await chromium.launch();
	const page = await browser.newPage();
	const errors = [];
	const blocked = [];
	let gstatic = 0;
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/*", (route) => {
		const url = route.request().url();
		if (url.startsWith(origin)) return route.continue();
		if (/gstatic/.test(url)) {
			gstatic += 1;
			return onGstatic(route);
		}
		if (allowExternal) return route.continue();
		blocked.push(url);
		return route.abort();
	});
	await page.goto(`${origin}${path}`);
	await page.waitForFunction(() => window.__poc !== undefined, null, { timeout: 180_000 });
	const result = await page.evaluate(() => window.__poc);
	await browser.close();
	if (result.state === "ok") {
		writeFileSync(resolve(outDir, `${name}.pdf`), Buffer.from(result.base64, "base64"));
	}
	console.log(
		`[${name}] ${result.state} ${result.state === "ok" ? `${result.size} bytes` : result.message}` +
			` | gstatic requests: ${gstatic} | blocked external: ${blocked.length}` +
			(errors.length ? ` | pageerrors: ${errors.slice(0, 3).join(" / ")}` : ""),
	);
	if (blocked.length) console.log("  blocked sample:", blocked.slice(0, 3));
	return result;
};

const recordFonts = (name) => {
	const { dir, manifestPath } = bundle(name);
	mkdirSync(dir, { recursive: true });
	const manifest = {};
	const onGstatic = async (route) => {
		const response = await route.fetch();
		if (!response.ok()) return route.abort();
		const body = await response.body();
		const pathname = new URL(route.request().url()).pathname;
		if (!manifest[pathname]) {
			const file = `font-${Object.keys(manifest).length}.bin`;
			manifest[pathname] = file;
			writeFileSync(resolve(dir, file), body);
			writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
		}
		return route.fulfill({
			status: 200,
			contentType: "font/ttf",
			headers: { "access-control-allow-origin": "*" },
			body,
		});
	};
	return onGstatic;
};

const serveBundled = (name) => {
	const { dir, manifestPath } = bundle(name);
	if (!existsSync(manifestPath)) throw new Error(`no bundle at ${manifestPath}`);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	return (route) => {
		const file = manifest[new URL(route.request().url()).pathname];
		if (!file) return route.abort();
		return route.fulfill({
			status: 200,
			contentType: "application/octet-stream",
			headers: { "access-control-allow-origin": "*" },
			body: readFileSync(resolve(dir, file)),
		});
	};
};

const refuse = (route) => route.abort();

try {
	const mode = process.argv[2] ?? "all";

	if (mode === "all" || mode === "latin") {
		await scenario("online", { path: "/", allowExternal: true, onGstatic: recordFonts("fonts-latin") });
		await scenario("offline-no-bundled-fonts", { path: "/", allowExternal: false, onGstatic: refuse });
		await scenario("offline-bundled-fonts", {
			path: "/",
			allowExternal: false,
			onGstatic: serveBundled("fonts-latin"),
		});
	}

	if (mode === "all" || mode === "cjk") {
		await scenario("cjk-online", {
			path: "/?zh=1",
			allowExternal: true,
			onGstatic: recordFonts("fonts-cjk"),
		});
		await scenario("cjk-offline-no-bundled-fonts", { path: "/?zh=1", allowExternal: false, onGstatic: refuse });
		await scenario("cjk-offline-bundled-fonts", {
			path: "/?zh=1",
			allowExternal: false,
			onGstatic: serveBundled("fonts-cjk"),
		});
	}
} finally {
	await server.close();
}
