import { getBookById } from "@/books";
import {
	DictionaryBottomSheet,
	type DictionaryBridgeMessage,
	type DictionaryLookupResult,
	type DictionarySelection,
	dictionaryTapScript,
	lookupJapaneseTermFromSqlite,
} from "@/features/dictionary";
import { Reader } from "@epubjs-react-native/core";
import jszipSource from "@epubjs-react-native/core/lib/module/jszip";
import { Asset } from "expo-asset";
import * as ExpoFileSystem from "expo-file-system/legacy";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";

const currentReaderTheme = {
	background: "#F1E2C9",
	text: "#111111",
};

const readerTheme = {
	html: {
		background: `${currentReaderTheme.background} !important`,
		"-webkit-text-size-adjust": "100% !important",
		"text-size-adjust": "100% !important",
	},
	body: {
		background: currentReaderTheme.background,
		"background-color": `${currentReaderTheme.background} !important`,
		color: `${currentReaderTheme.text} !important`,
		"font-size": "20px !important",
		"line-height": "1.75 !important",
		margin: "0 !important",
		padding: "16px 22px !important",
		"box-sizing": "border-box !important",
	},
};

type ReadingDirection = "ltr" | "rtl";

type ReaderLocation = {
	start?: {
		cfi?: string;
		href?: string;
		index?: number;
	};
	end?: {
		cfi?: string;
	};
};

let JSZipConstructor: any;

const idleDictionaryLookupResult: DictionaryLookupResult = {
	status: "idle",
	matchedText: "",
	entries: [],
};

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

async function detectReadingDirection(
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

const readerBackgroundScript = `
(() => {
	const readerBackground = ${JSON.stringify(currentReaderTheme.background)};

	function applyDocumentBackground(document) {
		if (!document) {
			return;
		}

		const root = document.documentElement;
		const body = document.body;
		const viewer = document.getElementById("viewer");

		if (root) {
			root.style.setProperty("background-color", readerBackground, "important");
		}

		if (body) {
			body.style.setProperty("background-color", readerBackground, "important");
		}

		if (viewer) {
			viewer.style.setProperty("background-color", readerBackground, "important");
		}
	}

	function applyContentBackground(contents) {
		if (!contents || !contents.document) {
			return;
		}

		applyDocumentBackground(contents.document);
	}

	function applyAllBackgrounds() {
		applyDocumentBackground(document);

		if (typeof rendition === "undefined" || !rendition.getContents) {
			return;
		}

		rendition.getContents().forEach(applyContentBackground);
	}

	if (typeof rendition !== "undefined") {
		if (rendition.hooks && rendition.hooks.content) {
			rendition.hooks.content.register((contents) => {
				applyContentBackground(contents);
			});
		}

		rendition.on("rendered", applyAllBackgrounds);
		rendition.on("relocated", applyAllBackgrounds);
		rendition.on("resized", applyAllBackgrounds);
	}

	applyAllBackgrounds();
})();
true;
`;

const rtlSwipeScript = `
(() => {
	const minSwipeDistance = 60;
	const maxVerticalRatio = 1.5;
	let isPaging = false;

	function attachSwipe(target) {
		if (!target || target.__suzumeRtlSwipeAttached) {
			return;
		}

		target.__suzumeRtlSwipeAttached = true;

		let startX = 0;
		let startY = 0;

		target.addEventListener("touchstart", (event) => {
			const touch = event.changedTouches && event.changedTouches[0];

			if (!touch) {
				return;
			}

			startX = touch.clientX;
			startY = touch.clientY;
		}, { passive: true });

		target.addEventListener("touchend", (event) => {
			const touch = event.changedTouches && event.changedTouches[0];

			if (!touch || isPaging || typeof rendition === "undefined") {
				return;
			}

			const deltaX = touch.clientX - startX;
			const deltaY = touch.clientY - startY;

			if (
				Math.abs(deltaX) < minSwipeDistance ||
				Math.abs(deltaX) < Math.abs(deltaY) * maxVerticalRatio
			) {
				return;
			}

			isPaging = true;

			const pageTurn = deltaX > 0 ? rendition.next() : rendition.prev();

			Promise.resolve(pageTurn)
				.catch(() => {})
				.finally(() => {
					setTimeout(() => {
						isPaging = false;
						attachToRenderedContents();
					}, 250);
				});
		}, { passive: true });
	}

	function attachSwipeToContents(contents) {
		if (!contents) {
			return;
		}

		attachSwipe(contents.window);
		attachSwipe(contents.document);
		attachSwipe(contents.document && contents.document.documentElement);
		attachSwipe(contents.document && contents.document.body);
	}

	function attachToRenderedContents() {
		attachSwipe(window);
		attachSwipe(document);
		attachSwipe(document.documentElement);
		attachSwipe(document.body);

		if (typeof rendition === "undefined" || !rendition.getContents) {
			return;
		}

		rendition.getContents().forEach(attachSwipeToContents);
	}

	attachToRenderedContents();

	if (typeof rendition !== "undefined") {
		if (rendition.hooks && rendition.hooks.content) {
			rendition.hooks.content.register((contents) => {
				attachSwipeToContents(contents);
			});
		}

		rendition.on("rendered", attachToRenderedContents);
		rendition.on("relocated", attachToRenderedContents);
		rendition.on("resized", attachToRenderedContents);
	}

	setInterval(attachToRenderedContents, 1000);
})();
true;
`;

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
	const { bookId } = useLocalSearchParams<{ bookId?: string }>();
	const selectedBook = getBookById(bookId);
	const [bookUri, setBookUri] = useState<string | null>(null);
	const [bookError, setBookError] = useState<string | null>(null);
	const [dictionarySelection, setDictionarySelection] =
		useState<DictionarySelection | null>(null);
	const [dictionaryLookupResult, setDictionaryLookupResult] =
		useState<DictionaryLookupResult>(idleDictionaryLookupResult);
	const [readingDirection, setReadingDirection] =
		useState<ReadingDirection>("ltr");
	const dictionaryLookupRequestId = useRef(0);
	const currentReaderLocationKey = useRef<string | null>(null);
	const injectedReaderJavascript =
		readingDirection === "rtl"
			? `${readerBackgroundScript}\n${rtlSwipeScript}\n${dictionaryTapScript}`
			: `${readerBackgroundScript}\n${dictionaryTapScript}`;

	const runDictionaryLookup = useCallback(
		async (selection: DictionarySelection) => {
			const requestId = dictionaryLookupRequestId.current + 1;
			dictionaryLookupRequestId.current = requestId;

			try {
				const result = await lookupJapaneseTermFromSqlite(selection.after);

				if (dictionaryLookupRequestId.current === requestId) {
					setDictionaryLookupResult(result);
				}
			} catch {
				if (dictionaryLookupRequestId.current === requestId) {
					setDictionaryLookupResult({
						status: "error",
						matchedText: "",
						entries: [],
						error: "Dictionary unavailable",
					});
				}
			}
		},
		[],
	);

	const closeDictionary = useCallback(() => {
		dictionaryLookupRequestId.current += 1;
		setDictionarySelection(null);
		setDictionaryLookupResult(idleDictionaryLookupResult);
	}, []);

	const handleLocationChange = useCallback(
		(_totalLocations: number, currentLocation: ReaderLocation) => {
			const locationKey = [
				currentLocation?.start?.cfi,
				currentLocation?.end?.cfi,
				currentLocation?.start?.href,
				currentLocation?.start?.index,
			]
				.filter((value) => value !== undefined && value !== null)
				.join("|");

			if (!locationKey) {
				return;
			}

			if (
				currentReaderLocationKey.current &&
				currentReaderLocationKey.current !== locationKey
			) {
				closeDictionary();
			}

			currentReaderLocationKey.current = locationKey;
		},
		[closeDictionary],
	);

	const handleWebViewMessage = useCallback(
		(message: DictionaryBridgeMessage | { type?: string }) => {
			if (message.type === "dictionary-close") {
				closeDictionary();
				return;
			}

			if (
				message.type !== "dictionary-tap" ||
				!("payload" in message) ||
				!message.payload.character
			) {
				return;
			}

			setDictionarySelection(message.payload);
			setDictionaryLookupResult((currentResult) => {
				if (
					currentResult?.status === "results" ||
					currentResult?.status === "loading"
				) {
					return {
						...currentResult,
						status: "loading",
					};
				}

				return {
					status: "loading",
					matchedText: "",
					entries: [],
				};
			});
			runDictionaryLookup(message.payload);
		},
		[closeDictionary, runDictionaryLookup],
	);

	useEffect(() => {
		let isMounted = true;
		setBookUri(null);
		setBookError(null);
		closeDictionary();
		currentReaderLocationKey.current = null;
		setReadingDirection("ltr");

		async function loadBook() {
			try {
				const book = Asset.fromModule(selectedBook.asset);

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
	}, [closeDictionary, selectedBook.asset]);

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
				<Text style={{ color: "white", fontSize: 18 }}>← Books</Text>
			</Pressable>

			{bookUri ? (
				<View
					style={{
						flex: 1,
						backgroundColor: currentReaderTheme.background,
						paddingTop: 100,
						paddingBottom: 48,
					}}
				>
					<Reader
						src={bookUri}
						fileSystem={useLegacyFileSystem}
						flow="paginated"
						spread="none"
						enableSwipe={readingDirection === "ltr"}
						defaultTheme={readerTheme}
						renderLoadingFileComponent={() => (
							<View
								style={{
									flex: 1,
									backgroundColor: currentReaderTheme.background,
								}}
							/>
						)}
						renderOpeningBookComponent={() => (
							<View
								style={{
									flex: 1,
									backgroundColor: currentReaderTheme.background,
								}}
							/>
						)}
						openingBookComponentContainerStyle={{
							width: "100%",
							height: "100%",
							backgroundColor: currentReaderTheme.background,
						}}
						injectedJavascript={injectedReaderJavascript}
						onLocationChange={handleLocationChange}
						onWebViewMessage={handleWebViewMessage}
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
					<Text style={{ color: "white", fontSize: 18 }}>
						{bookError ?? "Loading book..."}
					</Text>
				</View>
			)}

			<DictionaryBottomSheet
				selection={dictionarySelection}
				lookupResult={dictionaryLookupResult}
				onDismiss={closeDictionary}
			/>
		</View>
	);
}
