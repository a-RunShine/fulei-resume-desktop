import { spawn } from "node:child_process";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const desktopDir = path.join(repoRoot, "apps", "desktop");
const cacheDir = path.join(desktopDir, ".cache");
const installerCacheDir = path.join(cacheDir, "installer");
const runtimeDir = path.join(installerCacheDir, "runtime");
const deployDir = path.join(cacheDir, "server-deploy");

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: repoRoot,
			stdio: "inherit",
			shell: true,
			...options,
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
		});
	});
}

function copyChildren(source, destination) {
	fs.mkdirSync(destination, { recursive: true });
	for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
		const from = path.join(source, entry.name);
		const to = path.join(destination, entry.name);
		if (entry.isDirectory()) fs.cpSync(from, to, { recursive: true, dereference: true, force: true });
		else fs.copyFileSync(from, to);
	}
}

function packageName(specifier) {
	if (
		specifier.startsWith(".") ||
		specifier.startsWith("/") ||
		specifier.startsWith("#") ||
		specifier.startsWith("file:") ||
		isBuiltin(specifier)
	) {
		return null;
	}
	if (specifier.startsWith("@")) {
		const [scope, name] = specifier.split("/");
		if (!scope || !name) return null;
		const fullName = `${scope}/${name}`;
		return /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(fullName) ? fullName : null;
	}
	const name = specifier.split("/")[0];
	return /^[a-z0-9-~][a-z0-9-._~]*$/i.test(name ?? "") ? name : null;
}

function withoutComments(text) {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

export function importedPackages(directory) {
	const names = new Set();
	const pending = [directory];
	while (pending.length > 0) {
		const current = pending.pop();
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const entryPath = path.join(current, entry.name);
			if (entry.name === "node_modules") continue;
			if (entry.isDirectory()) {
				pending.push(entryPath);
				continue;
			}
			if (!entry.name.endsWith(".mjs") && !entry.name.endsWith(".js")) continue;
			const text = withoutComments(fs.readFileSync(entryPath, "utf8"));
			const patterns = [
				/(?:^|[;\n])\s*(?:export\s+)?import(?:\s+type)?\s+(?:[^"'()]+from\s+)?["']([^"']+)["']/g,
				/(?:^|[;\n])\s*export\s+\*\s+from\s+["']([^"']+)["']/g,
			];
			for (const pattern of patterns) {
				for (const match of text.matchAll(pattern)) {
					const name = packageName(match[1]);
					if (name) names.add(name);
				}
			}
		}
	}
	return names;
}

export const namedExternalPackages = new Set(["@electric-sql/pglite", "sharp", "css-tree", "mdn-data"]);

export const installerExcludedPackages = new Set(["next"]);

export function installerExcludesPackage(name) {
	return installerExcludedPackages.has(name) || name.startsWith("@next/");
}

function containsRuntimeAsset(directory) {
	const pending = [directory];
	while (pending.length > 0) {
		const current = pending.pop();
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.name === "node_modules") continue;
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) pending.push(entryPath);
			else if (entry.name.endsWith(".wasm") || entry.name.endsWith(".node")) return true;
		}
	}
	return false;
}

export function shipsExternally(name, directory) {
	if (installerExcludesPackage(name)) return false;
	return namedExternalPackages.has(name) || name.startsWith("@img/") || containsRuntimeAsset(directory);
}

function packageDirectory(modulesDir, name) {
	const directory = path.join(modulesDir, ...name.split("/"));
	return fs.existsSync(directory) ? directory : null;
}

function packageDependencyNames(directory) {
	const packageJson = path.join(directory, "package.json");
	if (!fs.existsSync(packageJson)) return [];
	const packageInfo = JSON.parse(fs.readFileSync(packageJson, "utf8"));
	return [...Object.keys(packageInfo.dependencies ?? {}), ...Object.keys(packageInfo.optionalDependencies ?? {})];
}

export function externalPackageNames(modulesDir) {
	if (!fs.existsSync(modulesDir)) return [];
	const roots = [];
	for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === ".bin") continue;
		if (entry.name.startsWith("@")) {
			const scopeDir = path.join(modulesDir, entry.name);
			for (const child of fs.readdirSync(scopeDir, { withFileTypes: true })) {
				if (!child.isDirectory()) continue;
				const name = `${entry.name}/${child.name}`;
				if (shipsExternally(name, path.join(scopeDir, child.name))) roots.push(name);
			}
			continue;
		}
		if (shipsExternally(entry.name, path.join(modulesDir, entry.name))) roots.push(entry.name);
	}
	const names = new Set(roots);
	const pending = [...roots];
	while (pending.length > 0) {
		const name = pending.pop();
		const directory = packageDirectory(modulesDir, name);
		if (!directory) continue;
		for (const dependency of packageDependencyNames(directory)) {
			if (names.has(dependency) || installerExcludesPackage(dependency)) continue;
			if (!packageDirectory(modulesDir, dependency)) continue;
			names.add(dependency);
			pending.push(dependency);
		}
	}
	return [...names];
}

export function expandPackageClosure(modulesDir, roots) {
	const names = new Set(roots);
	const pending = [...roots];
	while (pending.length > 0) {
		const name = pending.pop();
		const directory = packageDirectory(modulesDir, name);
		if (!directory) continue;
		for (const dependency of packageDependencyNames(directory)) {
			if (names.has(dependency) || installerExcludesPackage(dependency)) continue;
			if (!packageDirectory(modulesDir, dependency)) continue;
			names.add(dependency);
			pending.push(dependency);
		}
	}
	return [...names];
}

export function stageNodeExecutable(source, destination) {
	fs.rmSync(destination, { recursive: true, force: true });
	fs.mkdirSync(destination, { recursive: true });
	for (const name of ["node.exe", "node"]) {
		const from = path.join(source, name);
		if (fs.existsSync(from) && fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(destination, name));
	}
}

export function stageWebApp(distDir, destination) {
	fs.rmSync(destination, { recursive: true, force: true });
	fs.mkdirSync(destination, { recursive: true });
	fs.cpSync(distDir, path.join(destination, "dist"), { recursive: true, dereference: true });
}

export function stageServer({ bundleDir, modulesDir, migrationsDir, destination }) {
	fs.rmSync(destination, { recursive: true, force: true });
	fs.mkdirSync(destination, { recursive: true });
	copyChildren(bundleDir, destination);
	copyChildren(migrationsDir, path.join(destination, "migrations"));
	fs.writeFileSync(
		path.join(destination, "package.json"),
		JSON.stringify({ name: "reactive-resume-desktop-server", private: true, type: "module" }),
	);
	const names = expandPackageClosure(modulesDir, [
		...externalPackageNames(modulesDir),
		...importedPackages(destination),
	]);
	for (const name of names) {
		const from = path.join(modulesDir, ...name.split("/"));
		const to = path.join(destination, "node_modules", ...name.split("/"));
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.cpSync(from, to, { recursive: true, dereference: true });
	}
	stageFormeEngine(modulesDir, destination);
}

const FORME_ENGINE_WASM = "forme_bg.wasm";

export function stageFormeEngine(modulesDir, destination) {
	const source = path.join(modulesDir, "@formepdf", "core", "pkg-node", FORME_ENGINE_WASM);
	fs.copyFileSync(source, path.join(destination, FORME_ENGINE_WASM));
}

export function missingExternalPackages(serverDir) {
	return [...importedPackages(serverDir)]
		.filter((name) => !fs.existsSync(path.join(serverDir, "node_modules", ...name.split("/"))))
		.sort();
}

export function verifyRuntimeLayout(destination) {
	const nodeExecutable = ["node.exe", "node"]
		.map((name) => path.join(destination, "node", name))
		.find((candidate) => fs.existsSync(candidate));
	const required = [
		nodeExecutable ?? path.join(destination, "node", "node.exe"),
		path.join(destination, "server", "desktop-host.mjs"),
		path.join(destination, "server", FORME_ENGINE_WASM),
		path.join(destination, "web", "dist", "index.html"),
	];
	const missing = required.filter((candidate) => !fs.existsSync(candidate));
	if (missing.length > 0) throw new Error(`installer runtime is missing: ${missing.join(", ")}`);
}

export function stageRuntime({ runtimeDir: destination, nodeSource, distDir, bundleDir, modulesDir, migrationsDir }) {
	fs.rmSync(destination, { recursive: true, force: true });
	fs.mkdirSync(destination, { recursive: true });
	stageNodeExecutable(nodeSource, path.join(destination, "node"));
	stageServer({
		bundleDir,
		modulesDir,
		migrationsDir,
		destination: path.join(destination, "server"),
	});
	stageWebApp(distDir, path.join(destination, "web"));
	verifyRuntimeLayout(destination);
	const missing = missingExternalPackages(path.join(destination, "server"));
	if (missing.length > 0) throw new Error(`installer server is missing packages: ${missing.join(", ")}`);
	return destination;
}

function cargoPath() {
	const cargoHome = process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo");
	return `${path.join(cargoHome, "bin")}${path.delimiter}${process.env.PATH ?? ""}`;
}

async function main() {
	fs.rmSync(runtimeDir, { recursive: true, force: true });
	fs.rmSync(deployDir, { recursive: true, force: true });
	fs.mkdirSync(installerCacheDir, { recursive: true });

	await Promise.all([
		run("pnpm", ["--filter", "web", "build"]),
		run("pnpm", ["--filter", "server", "exec", "tsdown", "--config", "tsdown.desktop.config.ts"]),
		run("pnpm", ["--filter", "server", "deploy", "--prod", "--node-linker", "hoisted", deployDir]),
	]);

	stageRuntime({
		runtimeDir,
		nodeSource: path.dirname(process.execPath),
		distDir: path.join(repoRoot, "apps", "web", "dist"),
		bundleDir: path.join(repoRoot, "apps", "server", "dist"),
		modulesDir: path.join(deployDir, "node_modules"),
		migrationsDir: path.join(repoRoot, "migrations"),
	});

	await run("pnpm", ["exec", "tauri", "build"], {
		cwd: desktopDir,
		env: { ...process.env, PATH: cargoPath(), REACTIVE_RESUME_PACKAGING: "1" },
	});

	console.log(`installer runtime ${runtimeDir}`);
}

if (process.argv[1] && path.basename(process.argv[1]) === "pack-installer.mjs" && !process.env.VITEST) {
	await main();
}
