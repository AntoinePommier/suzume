import * as ExpoFileSystem from "expo-file-system/legacy";
import { extractEpubCover } from "./extractEpubCover";

const coverCacheDirectory = `${ExpoFileSystem.cacheDirectory}book-covers/`;
const coverMetadataExtension = "json";

type CachedCoverMetadata = {
	assetFingerprint: string;
	extension: string;
};

function getSafeCacheKey(bookId: string) {
	return bookId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getCoverMetadataUri(bookId: string) {
	return `${coverCacheDirectory}${getSafeCacheKey(bookId)}.${coverMetadataExtension}`;
}

function getCoverFileUri(bookId: string, extension: string) {
	return `${coverCacheDirectory}${getSafeCacheKey(bookId)}.${extension}`;
}

async function ensureCoverCacheDirectory() {
	await ExpoFileSystem.makeDirectoryAsync(coverCacheDirectory, {
		intermediates: true,
	});
}

async function readCachedCoverMetadata(bookId: string) {
	try {
		const metadata = await ExpoFileSystem.readAsStringAsync(
			getCoverMetadataUri(bookId),
		);

		return JSON.parse(metadata) as CachedCoverMetadata;
	} catch {
		return null;
	}
}

async function getCachedCoverUri(bookId: string, assetFingerprint: string) {
	const metadata = await readCachedCoverMetadata(bookId);

	if (!metadata || metadata.assetFingerprint !== assetFingerprint) {
		return null;
	}

	const coverUri = getCoverFileUri(bookId, metadata.extension);
	const coverInfo = await ExpoFileSystem.getInfoAsync(coverUri);

	return coverInfo.exists ? coverUri : null;
}

async function writeCachedCover(
	bookId: string,
	bookBase64: string,
	assetFingerprint: string,
) {
	const cover = await extractEpubCover(bookBase64);

	if (!cover) {
		return null;
	}

	const coverUri = getCoverFileUri(bookId, cover.extension);

	await ExpoFileSystem.writeAsStringAsync(coverUri, cover.base64, {
		encoding: "base64",
	});
	await ExpoFileSystem.writeAsStringAsync(
		getCoverMetadataUri(bookId),
		JSON.stringify({
			assetFingerprint,
			extension: cover.extension,
		} satisfies CachedCoverMetadata),
	);

	return coverUri;
}

export async function getCachedOrExtractedEpubCoverUri({
	assetFingerprint,
	bookBase64,
	bookId,
}: {
	assetFingerprint: string;
	bookBase64: string;
	bookId: string;
}) {
	await ensureCoverCacheDirectory();

	const cachedCoverUri = await getCachedCoverUri(bookId, assetFingerprint);

	if (cachedCoverUri) {
		return cachedCoverUri;
	}

	return writeCachedCover(bookId, bookBase64, assetFingerprint);
}
