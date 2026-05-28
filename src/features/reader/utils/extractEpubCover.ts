import { loadEpubZip } from "./epubZip";

type ManifestItem = {
	href: string;
	id: string;
	mediaType: string;
	properties: string;
};

export type ExtractedEpubCover = {
	base64: string;
	extension: string;
	mimeType: string;
};

const imageMimeTypes: Record<string, string> = {
	gif: "image/gif",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	png: "image/png",
	svg: "image/svg+xml",
	webp: "image/webp",
};

function decodeXmlEntities(value: string) {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}

function getTagAttributes(tag: string) {
	const attributes = new Map<string, string>();
	const attributePattern = /([\w:-]+)\s*=\s*["']([^"']*)["']/g;
	let match = attributePattern.exec(tag);

	while (match) {
		attributes.set(match[1].toLowerCase(), decodeXmlEntities(match[2]));
		match = attributePattern.exec(tag);
	}

	return attributes;
}

function getOpfDirectory(opfPath: string) {
	const parts = opfPath.split("/");
	parts.pop();

	return parts.join("/");
}

function resolveEpubPath(baseDirectory: string, href: string) {
	const parts = `${baseDirectory}/${href}`.split("/");
	const normalizedParts: string[] = [];

	for (const part of parts) {
		if (!part || part === ".") {
			continue;
		}

		if (part === "..") {
			normalizedParts.pop();
			continue;
		}

		normalizedParts.push(part);
	}

	return normalizedParts.join("/");
}

function getMimeType(item: ManifestItem) {
	if (item.mediaType) {
		return item.mediaType;
	}

	const extension = item.href.split(".").pop()?.toLowerCase() ?? "";

	return imageMimeTypes[extension] ?? "image/jpeg";
}

function getImageExtension(mimeType: string, href: string) {
	const hrefExtension = href.split(".").pop()?.toLowerCase();

	if (hrefExtension && imageMimeTypes[hrefExtension]) {
		return hrefExtension === "jpeg" ? "jpg" : hrefExtension;
	}

	if (mimeType === "image/png") {
		return "png";
	}

	if (mimeType === "image/gif") {
		return "gif";
	}

	if (mimeType === "image/webp") {
		return "webp";
	}

	if (mimeType === "image/svg+xml") {
		return "svg";
	}

	return "jpg";
}

function getManifestItems(opf: string) {
	const items: ManifestItem[] = [];
	const itemPattern = /<item\b[^>]*>/gi;
	let match = itemPattern.exec(opf);

	while (match) {
		const attributes = getTagAttributes(match[0]);
		const id = attributes.get("id") ?? "";
		const href = attributes.get("href") ?? "";

		if (id && href) {
			items.push({
				id,
				href,
				mediaType: attributes.get("media-type") ?? "",
				properties: attributes.get("properties") ?? "",
			});
		}

		match = itemPattern.exec(opf);
	}

	return items;
}

function getCoverId(opf: string) {
	const metaPattern = /<meta\b[^>]*>/gi;
	let match = metaPattern.exec(opf);

	while (match) {
		const attributes = getTagAttributes(match[0]);

		if (attributes.get("name")?.toLowerCase() === "cover") {
			return attributes.get("content") ?? null;
		}

		match = metaPattern.exec(opf);
	}

	return null;
}

function findCoverItem(opf: string) {
	const manifestItems = getManifestItems(opf);
	const coverId = getCoverId(opf);

	return (
		(coverId ? manifestItems.find((item) => item.id === coverId) : undefined) ??
		manifestItems.find((item) =>
			item.properties.toLowerCase().split(/\s+/).includes("cover-image"),
		) ??
		manifestItems.find(
			(item) =>
				item.mediaType.startsWith("image/") &&
				/\bcover\b/i.test(`${item.id} ${item.href}`),
		) ??
		null
	);
}

export async function extractEpubCover(bookBase64: string) {
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

	const coverItem = findCoverItem(opf);

	if (!coverItem) {
		return null;
	}

	const coverPath = resolveEpubPath(getOpfDirectory(opfPath), coverItem.href);
	const coverBase64 = await zip.file(coverPath)?.async("base64");

	if (!coverBase64) {
		return null;
	}

	const mimeType = getMimeType(coverItem);

	return {
		base64: coverBase64,
		extension: getImageExtension(mimeType, coverItem.href),
		mimeType,
	} satisfies ExtractedEpubCover;
}
