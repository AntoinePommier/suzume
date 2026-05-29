import { loadEpubZip } from "./epubZip";

export type ExtractedEpubMetadata = {
	creator: string | null;
	identifier: string | null;
	title: string | null;
};

function decodeXmlEntities(value: string) {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}

function stripXmlTags(value: string) {
	return value.replace(/<[^>]+>/g, "").trim();
}

function getFirstXmlTagText(xml: string, tagName: string) {
	const escapedTagName = tagName.replace(":", "\\:");
	const pattern = new RegExp(
		`<${escapedTagName}\\b[^>]*>([\\s\\S]*?)<\\/${escapedTagName}>`,
		"i",
	);
	const match = xml.match(pattern)?.[1];

	return match ? decodeXmlEntities(stripXmlTags(match)) || null : null;
}

export async function extractEpubMetadata(
	bookBase64: string,
): Promise<ExtractedEpubMetadata | null> {
	const zip = await loadEpubZip(bookBase64);
	const container = await zip.file("META-INF/container.xml")?.async("text");
	const opfPath = container?.match(
		/<rootfile\b[^>]*\bfull-path=["']([^"']+)/i,
	)?.[1];

	if (!opfPath) {
		return null;
	}

	const opf = await zip.file(opfPath)?.async("text");

	if (!opf) {
		return null;
	}

	return {
		creator: getFirstXmlTagText(opf, "dc:creator"),
		identifier: getFirstXmlTagText(opf, "dc:identifier"),
		title: getFirstXmlTagText(opf, "dc:title"),
	};
}
