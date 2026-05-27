import { Asset } from "expo-asset";
import * as ExpoFileSystem from "expo-file-system/legacy";
import { useCallback, useEffect, useState } from "react";
import type { ReadingDirection } from "../types";
import { detectReadingDirection } from "../utils/detectReadingDirection";

export function useBookAsset(assetModule: number) {
	const [bookUri, setBookUri] = useState<string | null>(null);
	const [bookError, setBookError] = useState<string | null>(null);
	const [readingDirection, setReadingDirection] =
		useState<ReadingDirection>("ltr");

	useEffect(() => {
		let isMounted = true;
		setBookUri(null);
		setBookError(null);
		setReadingDirection("ltr");

		async function loadBook() {
			try {
				const book = Asset.fromModule(assetModule);

				await book.downloadAsync();

				if (!book.localUri) {
					throw new Error("Book asset was not downloaded locally");
				}

				const bookBase64 = await ExpoFileSystem.readAsStringAsync(
					book.localUri,
					{
						encoding: "base64",
					},
				);
				const detectedReadingDirection =
					await detectReadingDirection(bookBase64);

				if (isMounted) {
					setReadingDirection(detectedReadingDirection);
					setBookUri(bookBase64);
				}
			} catch (err) {
				if (isMounted) {
					setBookError(
						err instanceof Error ? err.message : "Unable to load book",
					);
				}
			}
		}

		loadBook();

		return () => {
			isMounted = false;
		};
	}, [assetModule]);

	return { bookUri, bookError, readingDirection };
}

export function useLegacyFileSystem() {
	const [file, setFile] = useState<string | null>(null);
	const [progress, setProgress] = useState(0);
	const [downloading, setDownloading] = useState(false);
	const [size, setSize] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);

	const downloadFile = useCallback((fromUrl: string, toFile: string) => {
		const downloadResumable = ExpoFileSystem.createDownloadResumable(
			fromUrl,
			`${ExpoFileSystem.documentDirectory}${toFile}`,
			{ cache: true },
			(downloadProgress) => {
				const expectedBytes = downloadProgress.totalBytesExpectedToWrite;

				if (expectedBytes > 0) {
					setProgress(
						Math.round(
							(downloadProgress.totalBytesWritten / expectedBytes) * 100,
						),
					);
				}
			},
		);

		setDownloading(true);

		return downloadResumable
			.downloadAsync()
			.then((value) => {
				if (!value) {
					throw new Error("Download failed");
				}

				if (value.headers["Content-Length"]) {
					setSize(Number(value.headers["Content-Length"]));
				}

				setSuccess(true);
				setError(null);
				setFile(value.uri);

				return { uri: value.uri, mimeType: value.mimeType ?? null };
			})
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : "Error downloading file");
				return { uri: null, mimeType: null };
			})
			.finally(() => setDownloading(false));
	}, []);

	const getFileInfo = useCallback(async (fileUri: string) => {
		const info = await ExpoFileSystem.getInfoAsync(fileUri);

		return {
			uri: info.uri,
			exists: info.exists,
			isDirectory: info.exists ? info.isDirectory : false,
			size: info.exists ? info.size : undefined,
		};
	}, []);

	return {
		file,
		progress,
		downloading,
		size,
		error,
		success,
		documentDirectory: ExpoFileSystem.documentDirectory,
		cacheDirectory: ExpoFileSystem.cacheDirectory,
		bundleDirectory: ExpoFileSystem.bundleDirectory ?? undefined,
		readAsStringAsync: ExpoFileSystem.readAsStringAsync,
		writeAsStringAsync: ExpoFileSystem.writeAsStringAsync,
		deleteAsync: ExpoFileSystem.deleteAsync,
		downloadFile,
		getFileInfo,
	};
}
