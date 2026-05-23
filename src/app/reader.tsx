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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Pressable, Text, View } from "react-native";

const currentReaderTheme = {
	background: "#F1E2C9",
	text: "#111111",
};

const readerControlFadeDuration = 180;
const readerContentPaddingTop = 100;
const readerContentPaddingBottom = 48;

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
		displayed?: {
			page?: number;
			total?: number;
		};
		href?: string;
		index?: number;
	};
	end?: {
		cfi?: string;
		displayed?: {
			page?: number;
			total?: number;
		};
	};
};

type RenderedPaginationMessage =
	| {
			type: "rendered-pagination-loading";
			payload?: {
				layoutKey?: string;
				spineCount?: number;
			};
	  }
	| {
			type: "rendered-pagination-ready";
			payload?: {
				layoutKey?: string;
				pageCountsBySpineIndex?: Record<string, number>;
				totalPages?: number;
			};
	  }
	| {
			type: "rendered-pagination-error";
			payload?: {
				error?: string;
				layoutKey?: string;
			};
	  };

type RenderedPaginationState =
	| {
			status: "idle" | "loading" | "error";
			layoutKey?: string;
			error?: string;
	  }
	| {
			status: "ready";
			layoutKey?: string;
			pageCountsBySpineIndex: Record<number, number>;
			offsetsBySpineIndex: Record<number, number>;
			totalPages: number;
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

const renderedPaginationScript = `
(() => {
	if (window.__suzumeRenderedPaginationAttached) {
		return;
	}

	window.__suzumeRenderedPaginationAttached = true;

	const reactNativeWebview =
		window.ReactNativeWebView !== undefined && window.ReactNativeWebView !== null
			? window.ReactNativeWebView
			: window;

	let computeTimer = null;
	let activeLayoutKey = null;
	let isComputing = false;
	let needsRecompute = false;

	function postMessage(type, payload) {
		reactNativeWebview.postMessage(JSON.stringify({ type, payload }));
	}

	function waitForFrames(frameCount) {
		return new Promise((resolve) => {
			function step(remainingFrames) {
				if (remainingFrames <= 0) {
					resolve();
					return;
				}

				requestAnimationFrame(() => step(remainingFrames - 1));
			}

			step(frameCount);
		});
	}

	function getViewerSize() {
		const viewer = document.getElementById("viewer");
		const bounds = viewer && viewer.getBoundingClientRect();
		const width =
			(bounds && Math.round(bounds.width)) ||
			(viewer && viewer.clientWidth) ||
			window.innerWidth;
		const height =
			(bounds && Math.round(bounds.height)) ||
			(viewer && viewer.clientHeight) ||
			window.innerHeight;

		return { width, height };
	}

	function getLayoutKey() {
		const size = getViewerSize();
		const settings = rendition && rendition.settings ? rendition.settings : {};

		return [
			size.width,
			size.height,
			settings.flow || "auto",
			settings.spread || "none",
			settings.direction || "ltr",
			document.documentElement && document.documentElement.clientWidth,
			document.documentElement && document.documentElement.clientHeight,
		].join("|");
	}

	function getLinearSpineItems() {
		const items =
			book &&
			book.spine &&
			Array.isArray(book.spine.spineItems)
				? book.spine.spineItems
				: [];

		return items.filter((item) => item && item.linear !== "no");
	}

	async function computeRenderedPagination() {
		if (
			isComputing ||
			typeof book === "undefined" ||
			typeof rendition === "undefined"
		) {
			if (isComputing) {
				needsRecompute = true;
			}

			return;
		}

		const layoutKey = getLayoutKey();

		if (activeLayoutKey === layoutKey) {
			return;
		}

		isComputing = true;
		activeLayoutKey = layoutKey;

		const spineItems = getLinearSpineItems();
		postMessage("rendered-pagination-loading", {
			layoutKey,
			spineCount: spineItems.length,
		});

		let measuringRendition = null;
		let measuringContainer = null;

		try {
			await book.ready;
			await waitForFrames(2);

			const size = getViewerSize();
			measuringContainer = document.createElement("div");
			measuringContainer.id = "suzume-rendered-pagination-measurer";
			measuringContainer.setAttribute("aria-hidden", "true");
			measuringContainer.style.position = "fixed";
			measuringContainer.style.left = "-100000px";
			measuringContainer.style.top = "0";
			measuringContainer.style.width = size.width + "px";
			measuringContainer.style.height = size.height + "px";
			measuringContainer.style.overflow = "hidden";
			measuringContainer.style.opacity = "0";
			measuringContainer.style.pointerEvents = "none";
			measuringContainer.style.backgroundColor = ${JSON.stringify(
				currentReaderTheme.background,
			)};
			document.body.appendChild(measuringContainer);

			measuringRendition = book.renderTo(measuringContainer, {
				width: size.width,
				height: size.height,
				manager: "default",
				flow: "paginated",
				snap: undefined,
				spread: "none",
				fullsize: undefined,
				allowPopups: typeof allowPopups !== "undefined" ? allowPopups : false,
				allowScriptedContent:
					typeof allowScriptedContent !== "undefined"
						? allowScriptedContent
						: false,
			});

			measuringRendition.themes.register({ theme });
			measuringRendition.themes.select("theme");
			measuringRendition.direction(
				rendition.settings && rendition.settings.direction
					? rendition.settings.direction
					: "ltr",
			);

			const pageCountsBySpineIndex = {};
			let totalPages = 0;

			for (const item of spineItems) {
				await measuringRendition.display(item.index);
				await waitForFrames(2);

				const location = measuringRendition.currentLocation();
				const displayedTotal =
					location &&
					location.start &&
					location.start.displayed &&
					Number(location.start.displayed.total);
				const fallbackTotal =
					location &&
					location.end &&
					location.end.displayed &&
					Number(location.end.displayed.total);
				const pageCount = Math.max(1, displayedTotal || fallbackTotal || 1);

				pageCountsBySpineIndex[item.index] = pageCount;
				totalPages += pageCount;
			}

			postMessage("rendered-pagination-ready", {
				layoutKey,
				pageCountsBySpineIndex,
				totalPages,
			});
		} catch (error) {
			activeLayoutKey = null;
			postMessage("rendered-pagination-error", {
				layoutKey,
				error: error && error.message ? error.message : "Unable to paginate book",
			});
		} finally {
			if (measuringRendition && measuringRendition.destroy) {
				measuringRendition.destroy();
			}

			if (measuringContainer && measuringContainer.parentNode) {
				measuringContainer.parentNode.removeChild(measuringContainer);
			}

			isComputing = false;

			if (needsRecompute) {
				needsRecompute = false;
				activeLayoutKey = null;
				scheduleRenderedPagination();
			}
		}
	}

	function scheduleRenderedPagination() {
		if (computeTimer) {
			clearTimeout(computeTimer);
		}

		computeTimer = setTimeout(computeRenderedPagination, 250);
	}

	if (typeof rendition !== "undefined") {
		rendition.on("resized", () => {
			activeLayoutKey = null;
			scheduleRenderedPagination();
		});

		rendition.on("layout", () => {
			activeLayoutKey = null;
			scheduleRenderedPagination();
		});
	}

	scheduleRenderedPagination();
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
