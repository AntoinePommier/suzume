import type { ReadingDirection } from "../types";
import { loadEpubZip } from "./epubZip";

export async function detectReadingDirection(
	bookBase64: string,
): Promise<ReadingDirection> {
	const zip = await loadEpubZip(bookBase64);
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
