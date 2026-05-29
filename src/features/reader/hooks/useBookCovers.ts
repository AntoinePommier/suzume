import { Asset } from "expo-asset";
import * as ExpoFileSystem from "expo-file-system/legacy";
import { useEffect, useState } from "react";
import type { Book } from "@/books";
import { getCachedOrExtractedEpubCoverUri } from "../utils/epubCoverCache";

const coverCache = new Map<string, Promise<string | null>>();

function getAssetFingerprint(asset: Asset) {
	return [asset.hash, asset.name, asset.type].filter(Boolean).join("-") || "v1";
}

function getBookCoverCacheKey(book: Book) {
	return book.source === "imported"
		? `${book.id}:${book.fingerprint}`
		: book.id;
}

async function loadBookCover(book: Book) {
	const cacheKey = getBookCoverCacheKey(book);
	const cachedCover = coverCache.get(cacheKey);

	if (cachedCover) {
		const cachedCoverUri = await cachedCover;

		if (!cachedCoverUri) {
			return null;
		}

		const cachedCoverInfo = await ExpoFileSystem.getInfoAsync(cachedCoverUri);

		if (cachedCoverInfo.exists && !cachedCoverInfo.isDirectory) {
			return cachedCoverUri;
		}

		coverCache.delete(cacheKey);

		return loadBookCover(book);
	}

	const coverPromise = (async () => {
		if (book.source === "imported") {
			const bookInfo = await ExpoFileSystem.getInfoAsync(book.fileUri);

			if (!bookInfo.exists || bookInfo.isDirectory) {
				return null;
			}

			const bookBase64 = await ExpoFileSystem.readAsStringAsync(book.fileUri, {
				encoding: "base64",
			});

			return getCachedOrExtractedEpubCoverUri({
				assetFingerprint: book.fingerprint,
				bookBase64,
				bookId: book.id,
			});
		}

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

	coverCache.set(cacheKey, coverPromise);

	return coverPromise;
}

export function clearBookCoverCacheEntry(bookId: string) {
	for (const cacheKey of coverCache.keys()) {
		if (cacheKey === bookId || cacheKey.startsWith(`${bookId}:`)) {
			coverCache.delete(cacheKey);
		}
	}
}

export function useBookCovers(books: Book[]) {
	const [coverUris, setCoverUris] = useState<Record<string, string | null>>({});

	useEffect(() => {
		let isMounted = true;
		const bookIds = new Set(books.map((book) => book.id));

		setCoverUris((currentCoverUris) =>
			Object.fromEntries(
				Object.entries(currentCoverUris).filter(([bookId]) =>
					bookIds.has(bookId),
				),
			),
		);

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
