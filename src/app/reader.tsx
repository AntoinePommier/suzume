import { Reader } from "@epubjs-react-native/core";
import { Asset } from "expo-asset";
import * as ExpoFileSystem from "expo-file-system/legacy";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";

function useLegacyFileSystem() {
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

export default function ReaderScreen() {
	const [bookUri, setBookUri] = useState<string | null>(null);

	useEffect(() => {
		async function loadBook() {
			const book = Asset.fromModule(
				require("../../assets/books/shika-no-ou-1.epub"),
			);

			await book.downloadAsync();
			setBookUri(book.localUri ?? book.uri);
		}

		loadBook();
	}, []);

	return (
		<View style={{ flex: 1, backgroundColor: "#111111" }}>
			<Pressable
				onPress={() => router.back()}
				style={{
					position: "absolute",
					top: 60,
					left: 24,
					zIndex: 10,
				}}
			>
				<Text style={{ color: "white", fontSize: 18 }}>← Back</Text>
			</Pressable>

			{bookUri ? (
				<View
					style={{
						flex: 1,
						paddingTop: 120,
						paddingBottom: 48,
					}}
				>
					<Reader
						src={bookUri}
						fileSystem={useLegacyFileSystem}
						flow="paginated"
						enableSwipe
						defaultTheme={{
							body: {
								background: "#f8f5ee !important",
								color: "#111111 !important",
							},
							p: {
								color: "#111111 !important",
							},
							span: {
								color: "#111111 !important",
							},
						}}
					/>
				</View>
			) : (
				<View
					style={{
						flex: 1,
						alignItems: "center",
						justifyContent: "center",
					}}
				>
					<Text style={{ color: "white", fontSize: 18 }}>Loading book...</Text>
				</View>
			)}
		</View>
	);
}
