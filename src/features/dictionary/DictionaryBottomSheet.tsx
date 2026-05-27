import BottomSheet, { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";
import {
	type GestureResponderEvent,
	type NativeScrollEvent,
	type NativeSyntheticEvent,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type {
	DictionaryLookupEntry,
	DictionaryLookupResult,
	DictionarySelection,
} from "./types";

type DictionaryBottomSheetProps = {
	selection: DictionarySelection | null;
	lookupResult: DictionaryLookupResult | null;
	onDismiss: () => void;
};

type DictionaryResultItemProps = {
	entry: DictionaryLookupEntry;
};

type DictionaryResultRow = {
	entry: DictionaryLookupEntry;
	key: string;
};

const openScreenRatio = 0.6;
const topPullCloseDistance = 36;
const topSafeMargin = 12;

function isKana(character: string) {
	return /^[\u3040-\u30ffー]$/.test(character);
}

function getDisplayReading(expression: string, reading: string) {
	const expressionCharacters = Array.from(expression);
	const readingCharacters = Array.from(reading);

	while (
		expressionCharacters.length > 0 &&
		readingCharacters.length > 0 &&
		isKana(expressionCharacters[expressionCharacters.length - 1]) &&
		expressionCharacters[expressionCharacters.length - 1] ===
			readingCharacters[readingCharacters.length - 1]
	) {
		expressionCharacters.pop();
		readingCharacters.pop();
	}

	return readingCharacters.join("");
}

function getGlossaryRows(entry: DictionaryLookupEntry) {
	const seenGlosses = new Map<string, number>();

	return entry.glossary.filter(Boolean).map((glossary) => {
		const seenCount = seenGlosses.get(glossary) ?? 0;
		seenGlosses.set(glossary, seenCount + 1);

		return {
			key: `${entry.sequence ?? entry.expression}-${glossary}-${seenCount}`,
			text: glossary,
		};
	});
}

function getDictionaryResultRows(entries: DictionaryLookupEntry[]) {
	const seenEntries = new Map<string, number>();

	return entries.map((entry): DictionaryResultRow => {
		const baseKey = [
			entry.expression,
			entry.reading,
			entry.sequence ?? "",
			entry.score,
			entry.glossary.join("|"),
		].join("-");
		const seenCount = seenEntries.get(baseKey) ?? 0;
		seenEntries.set(baseKey, seenCount + 1);

		return {
			entry,
			key: `${baseKey}-${seenCount}`,
		};
	});
}

function createSnapPoints(screenHeight: number, topInset: number) {
	const openHeight = Math.round(screenHeight * openScreenRatio);
	const safeOpenHeight = Math.round(screenHeight - topInset - topSafeMargin);

	return [Math.min(openHeight, safeOpenHeight)];
}

function DictionaryResultItem({ entry }: DictionaryResultItemProps) {
	const displayReading =
		entry.reading && entry.reading !== entry.expression
			? getDisplayReading(entry.expression, entry.reading)
			: "";
	const glossaryRows = getGlossaryRows(entry);

	return (
		<View style={styles.entry}>
			{displayReading ? (
				<Text style={styles.reading}>{displayReading}</Text>
			) : null}

			<Text style={styles.expression}>{entry.expression}</Text>

			<View style={styles.glossaryList}>
				{glossaryRows.map((glossary) => (
					<View key={glossary.key} style={styles.glossaryRow}>
						<Text style={styles.glossaryMarker}>•</Text>
						<Text style={styles.glossary}>{glossary.text}</Text>
					</View>
				))}
			</View>
		</View>
	);
}

export function DictionaryBottomSheet({
	selection,
	lookupResult,
	onDismiss,
}: DictionaryBottomSheetProps) {
	const bottomSheetRef = useRef<BottomSheet>(null);
	const isOpenRef = useRef(false);
	const isProgrammaticCloseRef = useRef(false);
	const isProgrammaticSnapRef = useRef(false);
	const currentSheetIndexRef = useRef(-1);
	const scrollOffsetYRef = useRef(0);
	const topPullStartYRef = useRef<number | null>(null);
	const topPullTriggeredRef = useRef(false);
	const selectionRef = useRef(selection);
	const { height } = useWindowDimensions();
	const { top } = useSafeAreaInsets();
	const snapPoints = useMemo(
		() => createSnapPoints(height, top),
		[height, top],
	);
	const openSnapPoint = snapPoints[0];
	const shouldDisplayEntries =
		lookupResult?.status === "results" ||
		(lookupResult?.status === "loading" && lookupResult.entries.length > 0);
	const resultRows = useMemo(
		() =>
			shouldDisplayEntries ? getDictionaryResultRows(lookupResult.entries) : [],
		[lookupResult, shouldDisplayEntries],
	);

	const handleSheetChange = useCallback(
		(index: number) => {
			currentSheetIndexRef.current = index;

			if (index >= 0) {
				isOpenRef.current = true;
				isProgrammaticCloseRef.current = false;
				isProgrammaticSnapRef.current = false;
				return;
			}

			if (
				isProgrammaticCloseRef.current ||
				isProgrammaticSnapRef.current ||
				!isOpenRef.current ||
				!selectionRef.current
			) {
				isOpenRef.current = false;
				isProgrammaticCloseRef.current = false;
				return;
			}

			isOpenRef.current = false;
			onDismiss();
		},
		[onDismiss],
	);

	const handleContentScroll = useCallback(
		(event: NativeSyntheticEvent<NativeScrollEvent>) => {
			scrollOffsetYRef.current = Math.max(0, event.nativeEvent.contentOffset.y);
		},
		[],
	);

	const handleContentTouchStart = useCallback(
		(event: GestureResponderEvent) => {
			topPullStartYRef.current = event.nativeEvent.pageY;
			topPullTriggeredRef.current = false;
		},
		[],
	);

	const handleContentTouchMove = useCallback((event: GestureResponderEvent) => {
		const startY = topPullStartYRef.current;

		if (startY === null || topPullTriggeredRef.current) {
			return;
		}

		const deltaY = event.nativeEvent.pageY - startY;
		const isAtTop = scrollOffsetYRef.current <= 1;

		if (isAtTop && deltaY >= topPullCloseDistance) {
			topPullTriggeredRef.current = true;
			bottomSheetRef.current?.close();
		}
	}, []);

	const handleContentTouchEnd = useCallback(() => {
		topPullStartYRef.current = null;
		topPullTriggeredRef.current = false;
	}, []);

	useEffect(() => {
		selectionRef.current = selection;
	}, [selection]);

	useLayoutEffect(() => {
		if (selection) {
			if (openSnapPoint <= 0) {
				return;
			}

			isProgrammaticSnapRef.current = true;
			bottomSheetRef.current?.snapToIndex(0);
			return;
		}

		isProgrammaticCloseRef.current = true;
		bottomSheetRef.current?.close();
	}, [openSnapPoint, selection]);

	return (
		<BottomSheet
			ref={bottomSheetRef}
			index={-1}
			snapPoints={snapPoints}
			enableDynamicSizing={false}
			enableContentPanningGesture={false}
			enableHandlePanningGesture={true}
			enablePanDownToClose
			onChange={handleSheetChange}
			topInset={top}
			backgroundStyle={styles.background}
			handleStyle={styles.handle}
			handleIndicatorStyle={styles.handleIndicator}
		>
			<BottomSheetScrollView
				contentContainerStyle={styles.content}
				showsVerticalScrollIndicator={false}
				onScroll={handleContentScroll}
				onTouchStart={handleContentTouchStart}
				onTouchMove={handleContentTouchMove}
				onTouchEnd={handleContentTouchEnd}
				onTouchCancel={handleContentTouchEnd}
			>
				{lookupResult?.status === "loading" && resultRows.length === 0 ? (
					<Text style={styles.mutedText}>Preparing dictionary...</Text>
				) : null}

				{lookupResult?.status === "notInstalled" ? (
					<Text style={styles.mutedText}>Dictionary not installed.</Text>
				) : null}

				{lookupResult?.status === "error" ? (
					<Text style={styles.mutedText}>Dictionary unavailable.</Text>
				) : null}

				{lookupResult?.status === "noResults" ? (
					<Text style={styles.mutedText}>No dictionary results found.</Text>
				) : null}

				{shouldDisplayEntries
					? resultRows.map((row) => (
							<DictionaryResultItem key={row.key} entry={row.entry} />
						))
					: null}
			</BottomSheetScrollView>
		</BottomSheet>
	);
}

const styles = StyleSheet.create({
	background: {
		backgroundColor: "#ffffff",
		borderTopLeftRadius: 18,
		borderTopRightRadius: 18,
	},
	handleIndicator: {
		width: 40,
		backgroundColor: "#c8c8c8",
	},
	handle: {
		paddingTop: 14,
		paddingBottom: 14,
	},
	content: {
		paddingHorizontal: 20,
		paddingTop: 8,
		paddingBottom: 36,
	},
	mutedText: {
		marginTop: 8,
		color: "#6f6f6f",
		fontSize: 15,
		lineHeight: 22,
	},
	entry: {
		paddingVertical: 13,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: "#e5e2dc",
	},
	reading: {
		marginBottom: -1,
		color: "#8a8176",
		fontSize: 13,
		lineHeight: 16,
	},
	expression: {
		color: "#171412",
		fontSize: 28,
		fontWeight: "700",
		lineHeight: 32,
	},
	glossaryList: {
		marginTop: 5,
		gap: 1,
	},
	glossaryRow: {
		flexDirection: "row",
		alignItems: "flex-start",
		gap: 7,
	},
	glossaryMarker: {
		color: "#9a9288",
		fontSize: 13,
		lineHeight: 20,
	},
	glossary: {
		flex: 1,
		color: "#34302b",
		fontSize: 14,
		lineHeight: 18,
	},
});
