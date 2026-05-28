import { Asset } from "expo-asset";
import * as ExpoFileSystem from "expo-file-system/legacy";
import { useEffect, useState } from "react";
import type { Book } from "@/books";
import { getCachedOrExtractedEpubCoverUri } from "../utils/epubCoverCache";

const coverCache = new Map<string, Promise<string | null>>();

function getAssetFingerprint(asset: Asset) {
	return [asset.hash, asset.name, asset.type].filter(Boolean).join("-") || "v1";
}

async function loadBookCover(book: Book) {
	const cachedCover = coverCache.get(book.id);

	if (cachedCover) {
		return cachedCover;
	}

	const coverPromise = (async () => {
		const bookAsset = Asset.fromModule(book.asset);
		await bookAsset.downloadAsync();

		if (!bookAsset.localUri) {
			return null;
		}

		const bookBase64 = await ExpoFileSystem.readAsStringAsync(
			bookAsset.localUri,
			{
				encoding: "base64",
			},
		);

		return getCachedOrExtractedEpubCoverUri({
			assetFingerprint: getAssetFingerprint(bookAsset),
			bookBase64,
			bookId: book.id,
		});
	})();

	coverCache.set(book.id, coverPromise);

	return coverPromise;
}

export function useBookCovers(books: Book[]) {
	const [coverUris, setCoverUris] = useState<Record<string, string | null>>({});

	useEffect(() => {
		let isMounted = true;

		for (const book of books) {
			loadBookCover(book)
				.then((coverUri) => {
					if (!isMounted) {
						return;
					}

					setCoverUris((currentCoverUris) => ({
						...currentCoverUris,
						[book.id]: coverUri,
					}));
				})
				.catch(() => {
					if (!isMounted) {
						return;
					}

					setCoverUris((currentCoverUris) => ({
						...currentCoverUris,
						[book.id]: null,
					}));
				});
		}

		return () => {
			isMounted = false;
		};
	}, [books]);

	return coverUris;
}
