import { getBookById } from "@/books";
import {
	DictionaryBottomSheet,
	type DictionaryBridgeMessage,
	type DictionaryLookupResult,
	type DictionarySelection,
	dictionaryTapScript,
	lookupJapaneseTermFromSqlite,
} from "@/features/dictionary";
import {
	currentReaderTheme,
	readerContentPaddingBottom,
	readerContentPaddingTop,
	readerControlFadeDuration,
	readerTheme,
} from "@/features/reader/readerTheme";
import { createReaderBackgroundScript } from "@/features/reader/scripts/readerBackgroundScript";
import { createRenderedPaginationScript } from "@/features/reader/scripts/renderedPaginationScript";
import { rtlSwipeScript } from "@/features/reader/scripts/rtlSwipeScript";
import type {
	ReaderLocation,
	ReadingDirection,
	RenderedPaginationMessage,
	RenderedPaginationState,
} from "@/features/reader/types";
import { Reader } from "@epubjs-react-native/core";
import jszipSource from "@epubjs-react-native/core/lib/module/jszip";
import { Asset } from "expo-asset";
import * as ExpoFileSystem from "expo-file-system/legacy";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Pressable, Text, View } from "react-native";

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
	const [currentReaderLocation, setCurrentReaderLocation] =
		useState<ReaderLocation | null>(null);
	const [renderedPagination, setRenderedPagination] =
		useState<RenderedPaginationState>({ status: "idle" });
	const [readerControlsVisible, setReaderControlsVisible] = useState(false);
	const [pageIndicatorExpanded, setPageIndicatorExpanded] = useState(false);
	const dictionaryLookupRequestId = useRef(0);
	const currentReaderLocationKey = useRef<string | null>(null);
	const readerControlsAnimation = useRef(new Animated.Value(0)).current;
	const pageIndicatorOpacity = useRef(new Animated.Value(1)).current;
	const readerBackgroundScript = useMemo(
		() => createReaderBackgroundScript(currentReaderTheme.background),
		[],
	);
	const renderedPaginationScript = useMemo(
		() => createRenderedPaginationScript(currentReaderTheme.background),
		[],
	);
	const injectedReaderJavascript =
		readingDirection === "rtl"
			? `${readerBackgroundScript}\n${rtlSwipeScript}\n${dictionaryTapScript}\n${renderedPaginationScript}`
			: `${readerBackgroundScript}\n${dictionaryTapScript}\n${renderedPaginationScript}`;

	const renderedPageIndicator = useMemo(() => {
		if (
			renderedPagination.status !== "ready" ||
			!currentReaderLocation?.start?.displayed?.page ||
			currentReaderLocation.start.index === undefined ||
			renderedPagination.totalPages <= 0
		) {
			return null;
		}

		const currentSpineIndex = currentReaderLocation.start.index;
		const currentLocalPage = currentReaderLocation.start.displayed.page;
		const currentPageCount =
			renderedPagination.pageCountsBySpineIndex[currentSpineIndex] ?? 0;

		if (currentPageCount <= 0) {
			return null;
		}

		const clampedLocalPage = Math.min(
			Math.max(1, currentLocalPage),
			currentPageCount,
		);
		const currentGlobalPage =
			(renderedPagination.offsetsBySpineIndex[currentSpineIndex] ?? 0) +
			clampedLocalPage;

		return {
			currentPage: currentGlobalPage,
			totalPages: renderedPagination.totalPages,
		};
	}, [currentReaderLocation, renderedPagination]);

	const readerControlsAnimatedStyle = useMemo(
		() => ({
			opacity: readerControlsAnimation,
		}),
		[readerControlsAnimation],
	);

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

	const handleReaderBackgroundTap = useCallback(() => {
		if (dictionarySelection) {
			closeDictionary();
			return;
		}

		setReaderControlsVisible((isVisible) => !isVisible);
	}, [closeDictionary, dictionarySelection]);

	useEffect(() => {
		Animated.timing(readerControlsAnimation, {
			toValue: readerControlsVisible ? 1 : 0,
			duration: readerControlFadeDuration,
			easing: Easing.out(Easing.cubic),
			useNativeDriver: true,
		}).start();
	}, [readerControlsAnimation, readerControlsVisible]);

	useEffect(() => {
		let isCancelled = false;

		Animated.timing(pageIndicatorOpacity, {
			toValue: 0,
			duration: readerControlFadeDuration,
			easing: Easing.out(Easing.cubic),
			useNativeDriver: true,
		}).start(() => {
			if (isCancelled) {
				return;
			}

			setPageIndicatorExpanded(readerControlsVisible);

			Animated.timing(pageIndicatorOpacity, {
				toValue: 1,
				duration: readerControlFadeDuration,
				easing: Easing.out(Easing.cubic),
				useNativeDriver: true,
			}).start();
		});

		return () => {
			isCancelled = true;
			pageIndicatorOpacity.stopAnimation();
		};
	}, [pageIndicatorOpacity, readerControlsVisible]);

	const handleLocationChange = useCallback(
		(_totalLocations: number, currentLocation: ReaderLocation) => {
			setCurrentReaderLocation(currentLocation);

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
				setReaderControlsVisible(false);
				closeDictionary();
			}

			currentReaderLocationKey.current = locationKey;
		},
		[closeDictionary],
	);

	const handleWebViewMessage = useCallback(
		(
			message:
				| DictionaryBridgeMessage
				| RenderedPaginationMessage
				| { type?: string },
		) => {
			if (message.type === "rendered-pagination-loading") {
				const payload =
					"payload" in message && message.payload ? message.payload : {};

				setRenderedPagination({
					status: "loading",
					layoutKey: payload.layoutKey,
				});
				return;
			}

			if (message.type === "rendered-pagination-ready") {
				const payload =
					"payload" in message && message.payload ? message.payload : {};
				const pageCountsBySpineIndex = Object.fromEntries(
					Object.entries(payload.pageCountsBySpineIndex ?? {})
						.map(([spineIndex, pageCount]) => [
							Number(spineIndex),
							Number(pageCount),
						])
						.filter(
							([spineIndex, pageCount]) =>
								Number.isFinite(spineIndex) &&
								Number.isFinite(pageCount) &&
								pageCount > 0,
						),
				);
				const sortedSpineIndexes = Object.keys(pageCountsBySpineIndex)
					.map(Number)
					.sort((a, b) => a - b);
				const offsetsBySpineIndex: Record<number, number> = {};
				let totalPages = 0;

				for (const spineIndex of sortedSpineIndexes) {
					offsetsBySpineIndex[spineIndex] = totalPages;
					totalPages += pageCountsBySpineIndex[spineIndex];
				}

				setRenderedPagination({
					status: "ready",
					layoutKey: payload.layoutKey,
					pageCountsBySpineIndex,
					offsetsBySpineIndex,
					totalPages: payload.totalPages || totalPages,
				});
				return;
			}

			if (message.type === "rendered-pagination-error") {
				const payload =
					"payload" in message && message.payload ? message.payload : {};

				setRenderedPagination({
					status: "error",
					layoutKey: payload.layoutKey,
					error: payload.error,
				});
				return;
			}

			if (message.type === "dictionary-close") {
				closeDictionary();
				return;
			}

			if (message.type === "reader-background-tap") {
				handleReaderBackgroundTap();
				return;
			}

			if (
				message.type !== "dictionary-tap" ||
				!("payload" in message) ||
				!message.payload.character
			) {
				return;
			}

			setReaderControlsVisible(false);
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
		[closeDictionary, handleReaderBackgroundTap, runDictionaryLookup],
	);

	useEffect(() => {
		let isMounted = true;
		setBookUri(null);
		setBookError(null);
		closeDictionary();
		setCurrentReaderLocation(null);
		setRenderedPagination({ status: "idle" });
		setReaderControlsVisible(false);
		setPageIndicatorExpanded(false);
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
			<Animated.View
				pointerEvents={readerControlsVisible ? "auto" : "none"}
				style={[
					{
						position: "absolute",
						top: 54,
						left: 20,
						width: 44,
						height: 44,
						borderRadius: 22,
						zIndex: 10,
					},
					readerControlsAnimatedStyle,
				]}
			>
				<Pressable
					onPress={() => router.back()}
					hitSlop={10}
					style={{
						width: 44,
						height: 44,
						borderRadius: 22,
						overflow: "hidden",
						zIndex: 10,
					}}
				>
					<View
						style={{
							width: 44,
							height: 44,
							borderRadius: 22,
							alignItems: "center",
							justifyContent: "center",
							backgroundColor: "rgba(255, 255, 255, 0.55)",
							borderWidth: 1,
							borderColor: "rgba(255, 255, 255, 0.75)",
							shadowColor: "#000000",
							shadowOffset: { width: 0, height: 6 },
							shadowOpacity: 0.12,
							shadowRadius: 16,
							elevation: 4,
						}}
					>
						<Text
							style={{
								color: currentReaderTheme.text,
								fontSize: 30,
								fontWeight: "400",
								lineHeight: 34,
								marginTop: -2,
							}}
						>
							‹
						</Text>
					</View>
				</Pressable>
			</Animated.View>

			{bookUri ? (
				<View
					style={{
						flex: 1,
						backgroundColor: currentReaderTheme.background,
						paddingTop: readerContentPaddingTop,
						paddingBottom: readerContentPaddingBottom,
					}}
				>
					<Pressable
						onPress={handleReaderBackgroundTap}
						style={{
							position: "absolute",
							top: 0,
							left: 0,
							right: 0,
							height: readerContentPaddingTop,
							zIndex: 1,
						}}
					/>
					<Pressable
						onPress={handleReaderBackgroundTap}
						style={{
							position: "absolute",
							left: 0,
							right: 0,
							bottom: 0,
							height: readerContentPaddingBottom,
							zIndex: 1,
						}}
					/>

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

					<View
						pointerEvents="none"
						style={{
							position: "absolute",
							top: 60,
							alignSelf: "center",
							maxWidth: "58%",
							paddingHorizontal: 10,
							paddingVertical: 4,
						}}
					>
						<Text
							numberOfLines={1}
							ellipsizeMode="tail"
							style={{
								color: currentReaderTheme.text,
								fontSize: 12,
								fontWeight: "500",
								opacity: 0.45,
								textAlign: "center",
							}}
						>
							{selectedBook.title}
						</Text>
					</View>

					{renderedPageIndicator ? (
						<Animated.View
							pointerEvents="none"
							style={{
								position: "absolute",
								bottom: 18,
								alignSelf: "center",
								paddingHorizontal: 10,
								paddingVertical: 4,
								opacity: pageIndicatorOpacity,
							}}
						>
							<Text
								style={{
									color: currentReaderTheme.text,
									fontSize: 12,
									fontWeight: "500",
									opacity: 0.45,
								}}
							>
								{pageIndicatorExpanded
									? `${renderedPageIndicator.currentPage} sur ${renderedPageIndicator.totalPages}`
									: renderedPageIndicator.currentPage}
							</Text>
						</Animated.View>
					) : null}
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
