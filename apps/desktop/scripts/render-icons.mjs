import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceDir = path.join(repoRoot, "apps", "desktop", "icons-src");
const targetDir = path.join(repoRoot, "apps", "desktop", "src-tauri", "icons");

const FULL_MARK_MIN = 48;

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

const PNG_TARGETS = [
	["16x16.png", 16],
	["24x24.png", 24],
	["32x32.png", 32],
	["48x48.png", 48],
	["64x64.png", 64],
	["128x128.png", 128],
	["128x128@2x.png", 256],
	["icon.png", 512],
	["StoreLogo.png", 50],
	["Square30x30Logo.png", 30],
	["Square44x44Logo.png", 44],
	["Square71x71Logo.png", 71],
	["Square89x89Logo.png", 89],
	["Square107x107Logo.png", 107],
	["Square142x142Logo.png", 142],
	["Square150x150Logo.png", 150],
	["Square284x284Logo.png", 284],
	["Square310x310Logo.png", 310],
];

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const ICNS_TYPES = [
	["icp4", 16],
	["icp5", 32],
	["icp6", 64],
	["ic07", 128],
	["ic08", 256],
	["ic09", 512],
];

const cache = new Map();

async function render(size) {
	if (cache.has(size)) return cache.get(size);

	const variant = size >= FULL_MARK_MIN ? "desktop-large.svg" : "desktop-small.svg";
	const markup = fs.readFileSync(path.join(sourceDir, variant), "utf8");
	const buffer = await sharp(Buffer.from(markup))
		.resize(size, size, { fit: "contain" })
		.png({ compressionLevel: 9 })
		.toBuffer();

	cache.set(size, buffer);
	return buffer;
}

function ico(images) {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);

	const directory = Buffer.alloc(16 * images.length);
	let offset = 6 + 16 * images.length;

	for (const [index, { size, buffer }] of images.entries()) {
		const at = index * 16;
		const dimension = size >= 256 ? 0 : size;
		directory.writeUInt8(dimension, at);
		directory.writeUInt8(dimension, at + 1);
		directory.writeUInt8(0, at + 2);
		directory.writeUInt8(0, at + 3);
		directory.writeUInt16LE(1, at + 4);
		directory.writeUInt16LE(32, at + 6);
		directory.writeUInt32LE(buffer.length, at + 8);
		directory.writeUInt32LE(offset, at + 12);
		offset += buffer.length;
	}

	return Buffer.concat([header, directory, ...images.map((image) => image.buffer)]);
}

function icns(chunks) {
	const body = Buffer.concat(
		chunks.flatMap(([type, buffer]) => {
			const header = Buffer.alloc(8);
			header.write(type, 0, 4, "ascii");
			header.writeUInt32BE(buffer.length + 8, 4);
			return [header, buffer];
		}),
	);

	const header = Buffer.alloc(8);
	header.write("icns", 0, 4, "ascii");
	header.writeUInt32BE(body.length + 8, 4);
	return Buffer.concat([header, body]);
}

const rendered = new Map();
for (const size of SIZES) rendered.set(size, await render(size));

fs.mkdirSync(targetDir, { recursive: true });

for (const [name, size] of PNG_TARGETS) {
	const buffer = rendered.get(size) ?? (await render(size));
	fs.writeFileSync(path.join(targetDir, name), buffer);
	console.log(`wrote ${name} (${size}px, ${buffer.length} bytes)`);
}

const icoImages = ICO_SIZES.map((size) => ({ size, buffer: rendered.get(size) }));
const icoBuffer = ico(icoImages);
fs.writeFileSync(path.join(targetDir, "icon.ico"), icoBuffer);
console.log(`wrote icon.ico (${icoBuffer.length} bytes)`);

const icnsBuffer = icns(ICNS_TYPES.map(([type, size]) => [type, rendered.get(size)]));
fs.writeFileSync(path.join(targetDir, "icon.icns"), icnsBuffer);
console.log(`wrote icon.icns (${icnsBuffer.length} bytes)`);
