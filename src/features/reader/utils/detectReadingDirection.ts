import type { ReadingDirection } from "../types";
import jszipSource from "@epubjs-react-native/core/lib/module/jszip";

let JSZipConstructor: any;

function getJSZipConstructor() {
	if (JSZipConstructor) {
		return JSZipConstructor;
	}

	const scope: { JSZip?: any } = {};
	const source =
		typeof jszipSource === "string"
			? jszipSource
			: (jszipSource as { default?: string }).default;

	if (!source) {
		throw new Error("Unable to load EPUB metadata parser source");
	}

	const createJSZip = new Function(
		"scope",
		`
			var window = scope;
			var global = scope;
			var self = scope;
			var module = { exports: undefined };
			var exports = module.exports;

			${source}

			return module.exports || scope.JSZip;
		`,
	);

	JSZipConstructor = createJSZip(scope);

	if (!JSZipConstructor) {
		throw new Error("Unable to initialize EPUB metadata parser");
	}

	return JSZipConstructor;
}

export async function detectReadingDirection(
	bookBase64: string,
): Promise<ReadingDirection> {
	const JSZip = getJSZipConstructor();
	const zip = await JSZip.loadAsync(bookBase64, { base64: true });
	const container = await zip.file("META-INF/container.xml")?.async("text");
	const opfPath = container?.match(
		/<rootfile\b[^>]*\bfull-path=["']([^"']+)/i,
	)?.[1];

	if (!opfPath) {
		return "ltr";
	}

	const opf = await zip.file(opfPath)?.async("text");

	if (!opf) {
		return "ltr";
	}

	const pageProgressionDirection = opf
		.match(/<spine\b[^>]*\bpage-progression-direction=["']([^"']+)/i)?.[1]
		?.toLowerCase();

	if (pageProgressionDirection === "rtl") {
		return "rtl";
	}

	if (pageProgressionDirection === "ltr") {
		return "ltr";
	}

	const primaryWritingMode = opf
		.match(
			/<meta\b[^>]*\bname=["']primary-writing-mode["'][^>]*\bcontent=["']([^"']+)/i,
		)?.[1]
		?.toLowerCase();

	return primaryWritingMode === "vertical-rl" ? "rtl" : "ltr";
}
