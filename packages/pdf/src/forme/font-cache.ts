import type { PdfFontRequest } from "../hooks/use-register-fonts";
import ibmPlexSerif400 from "../../font-cache/ibm-plex-serif-400.ttf?url";
import ibmPlexSerif500 from "../../font-cache/ibm-plex-serif-500.ttf?url";
import ibmPlexSerif600 from "../../font-cache/ibm-plex-serif-600.ttf?url";
import ibmPlexSerif700 from "../../font-cache/ibm-plex-serif-700.ttf?url";
import notoSerif400 from "../../font-cache/noto-serif-400.ttf?url";
import notoSerif700 from "../../font-cache/noto-serif-700.ttf?url";
import notoSerifSc400 from "../../font-cache/noto-serif-sc-400.ttf?url";
import notoSerifSc700 from "../../font-cache/noto-serif-sc-700.ttf?url";

const shippedFonts = new Map<string, string>([
	["IBM Plex Serif:400:false", ibmPlexSerif400],
	["IBM Plex Serif:500:false", ibmPlexSerif500],
	["IBM Plex Serif:600:false", ibmPlexSerif600],
	["IBM Plex Serif:700:false", ibmPlexSerif700],
	["Noto Serif:400:false", notoSerif400],
	["Noto Serif:700:false", notoSerif700],
	["Noto Serif SC:400:false", notoSerifSc400],
	["Noto Serif SC:700:false", notoSerifSc700],
]);

const faceKey = (request: PdfFontRequest) => `${request.family}:${request.weight}:${request.italic}`;

const preparedFontUrl = (request: PdfFontRequest) =>
	`http://fontcache.localhost/${encodeURIComponent(request.family)}/${request.weight}/${request.italic}`;

const readPreparedFont = async (request: PdfFontRequest): Promise<Uint8Array | null> => {
	try {
		const response = await fetch(preparedFontUrl(request), { signal: AbortSignal.timeout(2_000) });
		if (!response.ok) return null;
		return new Uint8Array(await response.arrayBuffer());
	} catch {
		return null;
	}
};

export const readShippedFont = async (request: PdfFontRequest): Promise<Uint8Array | null> => {
	const url = shippedFonts.get(faceKey(request));
	if (url) {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Font ${request.family} could not be loaded.`);
		return new Uint8Array(await response.arrayBuffer());
	}
	return readPreparedFont(request);
};
