import { Reader } from "@epubjs-react-native/core";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ActivityIndicator,
	Animated,
	Pressable,
	Text,
	View,
} from "react-native";
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
	useBookAsset,
	useLegacyFileSystem,
} from "@/features/reader/hooks/useBookAsset";
import { useReaderControls } from "@/features/reader/hooks/useReaderControls";
import { useRenderedPagination } from "@/features/reader/hooks/useRenderedPagination";
import {
	currentReaderTheme,
	readerContentPaddingBottom,
	readerContentPaddingTop,
	readerTheme,
} from "@/features/reader/readerTheme";
import {
	getReadingProgressState,
	markBookOpened,
	saveReadingProgress,
} from "@/features/reader/readingProgressStorage";
import { createReaderBackgroundScript } from "@/features/reader/scripts/readerBackgroundScript";
import { createRenderedPaginationScript } from "@/features/reader/scripts/renderedPaginationScript";
import { rtlSwipeScript } from "@/features/reader/scripts/rtlSwipeScript";
import type {
	ReaderLocation,
	RenderedPaginationMessage,
} from "@/features/reader/types";

const idleDictionaryLookupResult: DictionaryLookupResult = {
	status: "idle",
	matchedText: "",
	entries: [],
};
const progressSaveDelayMs = 900;
const resumeVisibilityFallbackDelayMs = 1400;

export default function ReaderScreen() {
	const { bookId } = useLocalSearchParams<{ bookId?: string }>();
	const selectedBook = getBookById(bookId);
	const { bookUri, bookError, readingDirection } = useBookAsset(
		selectedBook.asset,
	);
	const [dictionarySelection, setDictionarySelection] =
		useState<DictionarySelection | null>(null);
	const [dictionaryLookupResult, setDictionaryLookupResult] =
		useState<DictionaryLookupResult>(idleDictionaryLookupResult);
	const [currentReaderLocation, setCurrentReaderLocation] =
		useState<ReaderLocation | null>(null);
	const [initialReaderLocation, setInitialReaderLocation] = useState<
		string | null
	>(null);
	const [isInitialReaderLocationLoaded, setIsInitialReaderLocationLoaded] =
		useState(false);
	const [isReaderContentVisible, setIsReaderContentVisible] = useState(false);
	const dictionaryLookupRequestId = useRef(0);
	const currentReaderLocationKey = useRef<string | null>(null);
	const progressSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const pendingProgressSave = useRef<{
		bookId: string;
		location: string;
		progress?: number | null;
	} | null>(null);
	const resumeVisibilityFallbackTimeout = useRef<ReturnType<
		typeof setTimeout
	> | null>(null);
	const injectReaderJavascript = useRef<((script: string) => void) | null>(
		null,
	);
	const {
		readerControlsVisible,
		setReaderControlsVisible,
		pageIndicatorExpanded,
		setPageIndicatorExpanded,
		pageIndicatorOpacity,
		readerControlsAnimatedStyle,
	} = useReaderControls();
	const {
		renderedPageIndicator,
		setRenderedPagination,
		handleRenderedPaginationMessage,
	} = useRenderedPagination(currentReaderLocation);
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
	const handleInjectionJavascriptFn = useCallback(
		(injectJavascript: (script: string) => void) => {
			injectReaderJavascript.current = injectJavascript;
		},
		[],
	);
	const runReaderJavascript = useCallback((script: string) => {
		injectReaderJavascript.current?.(`${script}\ntrue;`);
	}, []);
	const clearDictionaryHighlight = useCallback(() => {
		runReaderJavascript(`
			window.__suzumeClearDictionaryHighlight &&
				window.__suzumeClearDictionaryHighlight();
		`);
	}, [runReaderJavascript]);
	const highlightDictionaryMatch = useCallback(
		(matchedText: string) => {
			if (!matchedText) {
				clearDictionaryHighlight();
				return;
			}

			runReaderJavascript(`
				window.__suzumeHighlightDictionaryMatch &&
					window.__suzumeHighlightDictionaryMatch(${JSON.stringify(matchedText)});
			`);
		},
		[clearDictionaryHighlight, runReaderJavascript],
	);

	const runDictionaryLookup = useCallback(
		async (selection: DictionarySelection) => {
			const requestId = dictionaryLookupRequestId.current + 1;
			dictionaryLookupRequestId.current = requestId;

			try {
				const result = await lookupJapaneseTermFromSqlite(selection.after);

				if (dictionaryLookupRequestId.current === requestId) {
					setDictionaryLookupResult(result);

					if (result.status === "results") {
						highlightDictionaryMatch(result.matchedText);
					} else {
						clearDictionaryHighlight();
					}
				}
			} catch {
				if (dictionaryLookupRequestId.current === requestId) {
					setDictionaryLookupResult({
						status: "error",
						matchedText: "",
						entries: [],
						error: "Dictionary unavailable",
					});
					clearDictionaryHighlight();
				}
			}
		},
		[clearDictionaryHighlight, highlightDictionaryMatch],
	);

	const closeDictionary = useCallback(() => {
		dictionaryLookupRequestId.current += 1;
		setDictionarySelection(null);
		setDictionaryLookupResult(idleDictionaryLookupResult);
		clearDictionaryHighlight();
	}, [clearDictionaryHighlight]);

	const scheduleReadingProgressSave = useCallback(
		(progress: {
			bookId: string;
			location: string;
			progress?: number | null;
		}) => {
			if (progressSaveTimeout.current) {
				clearTimeout(progressSaveTimeout.current);
			}

			pendingProgressSave.current = progress;

			progressSaveTimeout.current = setTimeout(() => {
				progressSaveTimeout.current = null;
				const pendingProgress = pendingProgressSave.current;
				pendingProgressSave.current = null;

				if (pendingProgress) {
					saveReadingProgress(pendingProgress).catch(() => undefined);
				}
			}, progressSaveDelayMs);
		},
		[],
	);

	const handleReaderBackgroundTap = useCallback(() => {
		if (dictionarySelection) {
			closeDictionary();
			return;
		}

		setReaderControlsVisible((isVisible) => !isVisible);
	}, [closeDictionary, dictionarySelection, setReaderControlsVisible]);

	const flushPendingProgressSave = useCallback(() => {
		if (progressSaveTimeout.current) {
			clearTimeout(progressSaveTimeout.current);
			progressSaveTimeout.current = null;
		}

		const pendingProgress = pendingProgressSave.current;
		pendingProgressSave.current = null;

		if (pendingProgress) {
			saveReadingProgress(pendingProgress).catch(() => undefined);
		}
	}, []);

	const handleLocationChange = useCallback(
		(
			_totalLocations: number,
			currentLocation: ReaderLocation,
			_progress?: number,
		) => {
			setCurrentReaderLocation(currentLocation);

			const location = currentLocation?.start?.cfi;
			const locationKey = [
				location,
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

			if (location) {
				if (!initialReaderLocation || location === initialReaderLocation) {
					setIsReaderContentVisible(true);
				}

				if (
					initialReaderLocation &&
					!isReaderContentVisible &&
					location !== initialReaderLocation
				) {
					return;
				}

				scheduleReadingProgressSave({
					bookId: selectedBook.id,
					location,
					progress: null,
				});
			}
		},
		[
			closeDictionary,
			initialReaderLocation,
			isReaderContentVisible,
			scheduleReadingProgressSave,
			selectedBook.id,
			setReaderControlsVisible,
		],
	);

	const handleWebViewMessage = useCallback(
		(
			message:
				| DictionaryBridgeMessage
				| RenderedPaginationMessage
				| { type?: string },
		) => {
			if (handleRenderedPaginationMessage(message)) {
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
		[
			closeDictionary,
			handleReaderBackgroundTap,
			handleRenderedPaginationMessage,
			runDictionaryLookup,
			setReaderControlsVisible,
		],
	);

	useEffect(() => {
		if (!Number.isFinite(selectedBook.asset)) {
			return;
		}

		flushPendingProgressSave();

		closeDictionary();
		setCurrentReaderLocation(null);
		setInitialReaderLocation(null);
		setIsInitialReaderLocationLoaded(false);
		setIsReaderContentVisible(false);
		setRenderedPagination({ status: "idle" });
		setReaderControlsVisible(false);
		setPageIndicatorExpanded(false);
		currentReaderLocationKey.current = null;
	}, [
		closeDictionary,
		flushPendingProgressSave,
		selectedBook.asset,
		setPageIndicatorExpanded,
		setReaderControlsVisible,
		setRenderedPagination,
	]);

	useEffect(() => {
		let isMounted = true;

		getReadingProgressState()
			.then((progressState) => {
				if (!isMounted) {
					return;
				}

				setInitialReaderLocation(
					progressState.byBookId[selectedBook.id]?.location ?? null,
				);
				setIsInitialReaderLocationLoaded(true);
				setIsReaderContentVisible(
					!progressState.byBookId[selectedBook.id]?.location,
				);
				markBookOpened(selectedBook.id).catch(() => undefined);
			})
			.catch(() => {
				if (!isMounted) {
					return;
				}

				setInitialReaderLocation(null);
				setIsInitialReaderLocationLoaded(true);
				setIsReaderContentVisible(true);
			});

		return () => {
			isMounted = false;
			flushPendingProgressSave();
		};
	}, [flushPendingProgressSave, selectedBook.id]);

	useEffect(() => {
		if (!bookUri || !isInitialReaderLocationLoaded) {
			return;
		}

		if (!initialReaderLocation) {
			setIsReaderContentVisible(true);
			return;
		}

		setIsReaderContentVisible(false);

		if (resumeVisibilityFallbackTimeout.current) {
			clearTimeout(resumeVisibilityFallbackTimeout.current);
		}

		resumeVisibilityFallbackTimeout.current = setTimeout(() => {
			resumeVisibilityFallbackTimeout.current = null;
			setIsReaderContentVisible(true);
		}, resumeVisibilityFallbackDelayMs);

		return () => {
			if (resumeVisibilityFallbackTimeout.current) {
				clearTimeout(resumeVisibilityFallbackTimeout.current);
				resumeVisibilityFallbackTimeout.current = null;
			}
		};
	}, [bookUri, initialReaderLocation, isInitialReaderLocationLoaded]);

	useEffect(() => {
		const location = currentReaderLocation?.start?.cfi;

		if (
			!isReaderContentVisible ||
			!location ||
			!renderedPageIndicator ||
			renderedPageIndicator.totalPages <= 0
		) {
			return;
		}

		const renderedProgress =
			(renderedPageIndicator.currentPage / renderedPageIndicator.totalPages) *
			100;

		if (!Number.isFinite(renderedProgress)) {
			return;
		}

		scheduleReadingProgressSave({
			bookId: selectedBook.id,
			location,
			progress: renderedProgress,
		});
	}, [
		currentReaderLocation?.start?.cfi,
		isReaderContentVisible,
		renderedPageIndicator,
		scheduleReadingProgressSave,
		selectedBook.id,
	]);

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

			{bookUri && isInitialReaderLocationLoaded ? (
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
						initialLocation={initialReaderLocation ?? undefined}
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
						getInjectionJavascriptFn={handleInjectionJavascriptFn}
						onLocationChange={handleLocationChange}
						onWebViewMessage={handleWebViewMessage}
					/>

					{isReaderContentVisible ? null : (
						<View
							pointerEvents="none"
							style={{
								position: "absolute",
								top: readerContentPaddingTop,
								right: 0,
								bottom: readerContentPaddingBottom,
								left: 0,
								alignItems: "center",
								justifyContent: "center",
								backgroundColor: currentReaderTheme.background,
							}}
						>
							<ActivityIndicator color={currentReaderTheme.text} size="small" />
							<Text
								style={{
									marginTop: 10,
									color: currentReaderTheme.text,
									fontSize: 12,
									fontWeight: "500",
									opacity: 0.45,
								}}
							>
								Resuming…
							</Text>
						</View>
					)}

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

					{isReaderContentVisible && renderedPageIndicator ? (
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
