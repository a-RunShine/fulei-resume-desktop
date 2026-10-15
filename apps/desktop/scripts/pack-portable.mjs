import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

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
		specifier.startsWith("node:") ||
		specifier.startsWith("#") ||
		specifier.startsWith("file:")
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

function importedPackages(directory) {
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
			const text = fs.readFileSync(entryPath, "utf8");
			for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
				const name = packageName(match[1]);
				if (name) names.add(name);
			}
			for (const match of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
				const name = packageName(match[1]);
				if (name) names.add(name);
			}
		}
	}
	return names;
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

	fs.rmSync(serverDir, { recursive: true, force: true });
	fs.mkdirSync(serverDir, { recursive: true });
	fs.cpSync(path.join(deployDir, "node_modules"), path.join(serverDir, "node_modules"), {
		recursive: true,
		dereference: true,
	});
	fs.writeFileSync(
		path.join(serverDir, "package.json"),
		JSON.stringify({ name: "reactive-resume-desktop-server", private: true, type: "module" }),
	);
	copyChildren(path.join(repoRoot, "apps", "server", "dist"), serverDir);
	copyChildren(path.join(repoRoot, "migrations"), path.join(serverDir, "migrations"));
	const missing = [...importedPackages(serverDir)].filter(
		(name) => !fs.existsSync(path.join(serverDir, "node_modules", name)),
	);
	if (missing.length > 0) throw new Error(`portable server is missing packages: ${missing.sort().join(", ")}`);

	const nodeSource = path.dirname(process.execPath);
	const nodeDestination = path.join(stagingDir, "node");
	fs.rmSync(nodeDestination, { recursive: true, force: true });
	fs.mkdirSync(nodeDestination, { recursive: true });
	for (const entry of fs.readdirSync(nodeSource, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		fs.copyFileSync(path.join(nodeSource, entry.name), path.join(nodeDestination, entry.name));
	}

	const webDestination = path.join(stagingDir, "web");
	fs.rmSync(webDestination, { recursive: true, force: true });
	fs.cpSync(path.join(repoRoot, "apps", "web", "dist"), path.join(webDestination, "dist"), {
		recursive: true,
		dereference: true,
	});
	const prerender = path.join(repoRoot, "apps", "web", "dist-prerender");
	if (fs.existsSync(prerender)) {
		fs.cpSync(prerender, path.join(webDestination, "dist-prerender"), { recursive: true, dereference: true });
	}

	const webviewDestination = path.join(stagingDir, "webview2");
	fs.rmSync(webviewDestination, { recursive: true, force: true });
	if (!findNamed(webviewExtract, "msedgewebview2.exe")) throw new Error("WebView2 runtime did not expand");
	fs.cpSync(webviewExtract, webviewDestination, { recursive: true, dereference: true });

	const payloadZip = path.join(cacheDir, "portable-payload.zip");
	fs.rmSync(payloadZip, { force: true });
	await run("tar.exe", ["-a", "-c", "-h", "-f", payloadZip, "-C", stagingDir, "."]);

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

await main();
