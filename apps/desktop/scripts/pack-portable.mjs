import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const desktopDir = path.join(repoRoot, "apps", "desktop");
const cacheDir = path.join(desktopDir, ".cache");
const stagingDir = path.join(cacheDir, "portable-staging");
const serverDir = path.join(stagingDir, "server");
const outputDir = path.join(desktopDir, "portable");
const releaseExe = path.join(desktopDir, "src-tauri", "target", "release", "reactive-resume-desktop.exe");
const outputExe = path.join(outputDir, "Reactive Resume.exe");
const webview2Version = "155.0.4283.45";
const webview2Url =
	"https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/01b0fbd9-6ea3-4e12-818a-a71f73f3855b/Microsoft.WebView2.FixedVersionRuntime.155.0.4283.45.x64.cab";
const trailerMagic = Buffer.from("RRPORTABLE!!!!!\n", "ascii");

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

function findNamed(directory, fileName) {
	if (!fs.existsSync(directory)) return null;
	const pending = [directory];
	while (pending.length > 0) {
		const current = pending.pop();
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) pending.push(entryPath);
			else if (entry.name === fileName) return entryPath;
		}
	}
	return null;
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

const namedExternalPackages = new Set(["@electric-sql/pglite", "sharp", "css-tree", "mdn-data"]);

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

function shipsExternally(name, directory) {
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

function externalPackageNames(modulesDir) {
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
			if (names.has(dependency) || !packageDirectory(modulesDir, dependency)) continue;
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

export function stageWebApp(distDir, prerenderDir, destination) {
	fs.rmSync(destination, { recursive: true, force: true });
	fs.mkdirSync(destination, { recursive: true });
	fs.cpSync(distDir, path.join(destination, "dist"), { recursive: true, dereference: true });
	if (fs.existsSync(prerenderDir))
		fs.rmSync(path.join(destination, "dist-prerender"), { recursive: true, force: true });
}

function expandPackageClosure(modulesDir, roots) {
	const names = new Set(roots);
	const pending = [...roots];
	while (pending.length > 0) {
		const name = pending.pop();
		const directory = packageDirectory(modulesDir, name);
		if (!directory) continue;
		for (const dependency of packageDependencyNames(directory)) {
			if (names.has(dependency) || !packageDirectory(modulesDir, dependency)) continue;
			names.add(dependency);
			pending.push(dependency);
		}
	}
	return [...names];
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
}

function hashDirectory(directory) {
	const hash = createHash("sha256");
	const files = [];
	const pending = [directory];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!fs.existsSync(current)) continue;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) pending.push(entryPath);
			else files.push(entryPath);
		}
	}
	files.sort();
	for (const file of files) {
		hash.update(path.relative(directory, file).replaceAll("\\", "/"));
		hash.update("\0");
		hash.update(fs.readFileSync(file));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function componentHashes(stagingDir) {
	return {
		node: hashDirectory(path.join(stagingDir, "node")),
		server: hashDirectory(path.join(stagingDir, "server")),
		web: hashDirectory(path.join(stagingDir, "web")),
		webview2: hashDirectory(path.join(stagingDir, "webview2")),
	};
}

export function writeComponentManifest(stagingDir) {
	fs.writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(componentHashes(stagingDir)));
}

function collectFiles(root) {
	const files = [];
	const pending = [""];
	while (pending.length > 0) {
		const relative = pending.pop();
		const directory = relative ? path.join(root, relative) : root;
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) pending.push(child);
			else files.push(child.replaceAll("\\", "/"));
		}
	}
	files.sort();
	return files;
}

export function writeStoredZip(sourceDir, destFile) {
	fs.mkdirSync(path.dirname(destFile), { recursive: true });
	const fd = fs.openSync(destFile, "w");
	const central = [];
	try {
		for (const name of collectFiles(sourceDir)) {
			const nameBytes = Buffer.from(name, "utf8");
			const localOffset = fs.fstatSync(fd).size;
			const header = Buffer.alloc(30);
			header.writeUInt32LE(0x04034b50, 0);
			header.writeUInt16LE(20, 4);
			header.writeUInt16LE(nameBytes.length, 26);
			fs.writeSync(fd, header);
			fs.writeSync(fd, nameBytes);
			let crc = 0;
			let size = 0;
			const input = fs.openSync(path.join(sourceDir, name), "r");
			const chunk = Buffer.alloc(1024 * 1024);
			try {
				for (;;) {
					const read = fs.readSync(input, chunk, 0, chunk.length, size);
					if (read === 0) break;
					const slice = chunk.subarray(0, read);
					crc = crc32(slice, crc);
					fs.writeSync(fd, slice);
					size += read;
				}
			} finally {
				fs.closeSync(input);
			}
			if (size > 0xffffffff) throw new Error(`zip entry too large: ${name}`);
			header.writeUInt32LE(crc >>> 0, 14);
			header.writeUInt32LE(size, 18);
			header.writeUInt32LE(size, 22);
			fs.writeSync(fd, header.subarray(14, 26), 0, 12, localOffset + 14);
			central.push({ nameBytes, crc: crc >>> 0, size, localOffset });
		}
		if (central.length > 0xffff) throw new Error("too many zip entries");
		const centralStart = fs.fstatSync(fd).size;
		for (const entry of central) {
			const record = Buffer.alloc(46);
			record.writeUInt32LE(0x02014b50, 0);
			record.writeUInt16LE(20, 4);
			record.writeUInt16LE(20, 6);
			record.writeUInt32LE(entry.crc, 16);
			record.writeUInt32LE(entry.size, 20);
			record.writeUInt32LE(entry.size, 24);
			record.writeUInt16LE(entry.nameBytes.length, 28);
			record.writeUInt32LE(entry.localOffset, 42);
			fs.writeSync(fd, record);
			fs.writeSync(fd, entry.nameBytes);
		}
		const end = Buffer.alloc(22);
		end.writeUInt32LE(0x06054b50, 0);
		end.writeUInt16LE(central.length, 8);
		end.writeUInt16LE(central.length, 10);
		end.writeUInt32LE(fs.fstatSync(fd).size - centralStart, 12);
		end.writeUInt32LE(centralStart, 16);
		fs.writeSync(fd, end);
	} finally {
		fs.closeSync(fd);
	}
}

async function download(url, destination) {
	if (fs.existsSync(destination) && fs.statSync(destination).size > 1_000_000) return;
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	const temporary = `${destination}.partial`;
	const response = await fetch(url);
	if (!response.ok || !response.body) throw new Error(`download failed ${response.status} ${url}`);
	await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
	fs.renameSync(temporary, destination);
}

async function main() {
	fs.mkdirSync(cacheDir, { recursive: true });
	const cabPath = path.join(cacheDir, "webview2", `Microsoft.WebView2.FixedVersionRuntime.${webview2Version}.x64.cab`);
	const webviewExtract = path.join(cacheDir, "webview2", webview2Version);
	const cargoPath = `C:\\Users\\Administrator\\.cargo\\bin;${process.env.PATH ?? ""}`;

	const deployDir = path.join(cacheDir, "server-deploy");
	fs.rmSync(deployDir, { recursive: true, force: true });
	await Promise.all([
		run("pnpm", ["--filter", "web", "build"]),
		run("pnpm", ["--filter", "server", "exec", "tsdown", "--config", "tsdown.desktop.config.ts"]),
		run("pnpm", ["--filter", "server", "deploy", "--prod", "--node-linker", "hoisted", deployDir]),
		run("cargo", ["build", "--release"], {
			cwd: path.join(desktopDir, "src-tauri"),
			env: { ...process.env, PATH: cargoPath },
		}),
		(async () => {
			await download(webview2Url, cabPath);
			if (!findNamed(webviewExtract, "msedgewebview2.exe")) {
				fs.rmSync(webviewExtract, { recursive: true, force: true });
				fs.mkdirSync(webviewExtract, { recursive: true });
				await run("expand.exe", [cabPath, "-F:*", webviewExtract]);
			}
		})(),
	]);

	stageServer({
		bundleDir: path.join(repoRoot, "apps", "server", "dist"),
		modulesDir: path.join(deployDir, "node_modules"),
		migrationsDir: path.join(repoRoot, "migrations"),
		destination: serverDir,
	});
	const missing = [...importedPackages(serverDir)].filter(
		(name) => !fs.existsSync(path.join(serverDir, "node_modules", name)),
	);
	if (missing.length > 0) throw new Error(`portable server is missing packages: ${missing.sort().join(", ")}`);

	stageNodeExecutable(path.dirname(process.execPath), path.join(stagingDir, "node"));
	stageWebApp(
		path.join(repoRoot, "apps", "web", "dist"),
		path.join(repoRoot, "apps", "web", "dist-prerender"),
		path.join(stagingDir, "web"),
	);

	const webviewDestination = path.join(stagingDir, "webview2");
	fs.rmSync(webviewDestination, { recursive: true, force: true });
	if (!findNamed(webviewExtract, "msedgewebview2.exe")) throw new Error("WebView2 runtime did not expand");
	fs.cpSync(webviewExtract, webviewDestination, { recursive: true, dereference: true });
	writeComponentManifest(stagingDir);
	await sealPortable();
}

export async function sealPortable() {
	const payloadZip = path.join(cacheDir, "portable-payload.zip");
	fs.rmSync(payloadZip, { force: true });
	writeStoredZip(stagingDir, payloadZip);
	await appendPortablePayload();
}

export async function appendPortablePayload() {
	const payloadZip = path.join(cacheDir, "portable-payload.zip");
	const zipSize = fs.statSync(payloadZip).size;
	const hash = createHash("sha256");
	const versionBytes = Buffer.alloc(56);
	const zipLen = Buffer.alloc(8);
	fs.mkdirSync(outputDir, { recursive: true });
	fs.rmSync(outputExe, { force: true });
	await pipeline(fs.createReadStream(releaseExe), fs.createWriteStream(outputExe));
	const output = fs.openSync(outputExe, "a");
	const payload = fs.openSync(payloadZip, "r");
	const buffer = Buffer.alloc(1024 * 1024);
	let copied = 0;
	while (copied < zipSize) {
		const read = fs.readSync(payload, buffer, 0, buffer.length, copied);
		if (read === 0) break;
		hash.update(buffer.subarray(0, read));
		fs.writeSync(output, buffer, 0, read);
		copied += read;
	}
	fs.closeSync(payload);
	if (copied !== zipSize) throw new Error(`payload copy stopped at ${copied} of ${zipSize}`);
	versionBytes.write(hash.digest("hex").slice(0, 16), "utf8");
	zipLen.writeBigUInt64LE(BigInt(zipSize));
	fs.writeSync(output, Buffer.concat([trailerMagic, zipLen, versionBytes]));
	fs.closeSync(output);
	console.log(`portable exe ${outputExe}`);
}

if (process.argv[1] && path.basename(process.argv[1]) === "pack-portable.mjs" && !process.env.VITEST) {
	await main();
}
