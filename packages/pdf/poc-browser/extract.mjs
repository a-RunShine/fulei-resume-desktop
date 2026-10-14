import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../../../poc-out/browser");

for (const name of ["online", "cjk-online", "cjk-offline-bundled-fonts"]) {
	const data = new Uint8Array(readFileSync(resolve(dir, `${name}.pdf`)));
	const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
	const page = await doc.getPage(1);
	const content = await page.getTextContent();
	const text = content.items
		.map((item) => item.str)
		.join(" ")
		.replace(/\s+/g, " ");
	console.log(`[${name}] pages=${doc.numPages} :: ${text.slice(0, 220)}`);
}
