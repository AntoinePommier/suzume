import BottomSheet, { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";

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

const initialMaxScreenRatio = 0.45;
const expandedScreenRatio = 0.95;
const minSheetHeight = 132;
const handleHeight = 28;
const verticalContentPadding = 44;
const statusTextHeight = 30;
const entryVerticalPadding = 26;
const readingHeight = 16;
const expressionHeight = 32;
const glossaryTopMargin = 5;
const glossaryLineHeight = 18;
const glossaryRowGap = 1;
const entryBorderHeight = 1;
const glossaryHorizontalChrome = 47;

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

function estimateGlossaryHeight(glossary: string, availableWidth: number) {
	const estimatedCharacterWidth = 7;
	const charactersPerLine = Math.max(
		18,
		Math.floor(availableWidth / estimatedCharacterWidth),
	);
	const lineCount = Math.max(
		1,
		Math.ceil(Array.from(glossary).length / charactersPerLine),
	);

	return lineCount * glossaryLineHeight;
}

function estimateEntryHeight(
	entry: DictionaryLookupEntry,
	availableWidth: number,
) {
	const glosses = entry.glossary.filter(Boolean);
	const glossaryHeight = glosses.reduce(
		(total, glossary) =>
			total + estimateGlossaryHeight(glossary, availableWidth),
		0,
	);
	const glossaryGaps = Math.max(0, glosses.length - 1) * glossaryRowGap;
	const hasReading = Boolean(
		entry.reading && entry.reading !== entry.expression,
	);

	return (
		entryVerticalPadding +
		entryBorderHeight +
		(hasReading ? readingHeight : 0) +
		expressionHeight +
		(glosses.length > 0 ? glossaryTopMargin + glossaryHeight + glossaryGaps : 0)
	);
}

function estimateContentHeight(
	lookupResult: DictionaryLookupResult | null,
	screenWidth: number,
) {
	const hasDisplayEntries =
		lookupResult?.status === "results" ||
		(lookupResult?.status === "loading" && lookupResult.entries.length > 0);

	if (!lookupResult || !hasDisplayEntries) {
		return handleHeight + verticalContentPadding + statusTextHeight;
	}

	const availableGlossaryWidth = Math.max(
		180,
		screenWidth -
			styles.content.paddingHorizontal * 2 -
			glossaryHorizontalChrome,
	);

	return (
		handleHeight +
		verticalContentPadding +
		lookupResult.entries.reduce(
			(total, entry) =>
				total + estimateEntryHeight(entry, availableGlossaryWidth),
			0,
		)
	);
}

function createSnapPoints(
	lookupResult: DictionaryLookupResult | null,
	screenWidth: number,
	screenHeight: number,
) {
	const maxInitialHeight = Math.round(screenHeight * initialMaxScreenRatio);
	const expandedHeight = Math.round(screenHeight * expandedScreenRatio);
	const estimatedHeight = estimateContentHeight(lookupResult, screenWidth);
	const contentHeight = Math.min(
		expandedHeight,
		Math.max(minSheetHeight, Math.ceil(estimatedHeight)),
	);
	const initialHeight =
		contentHeight <= maxInitialHeight ? contentHeight : maxInitialHeight;

	return [initialHeight, Math.max(initialHeight + 1, expandedHeight)];
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
	const selectionRef = useRef(selection);
	const { height, width } = useWindowDimensions();
	const snapPoints = useMemo(
		() => createSnapPoints(lookupResult, width, height),
		[height, lookupResult, width],
	);
	const initialSnapPoint = snapPoints[0];
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

	useEffect(() => {
		selectionRef.current = selection;
	}, [selection]);

	useLayoutEffect(() => {
		if (selection) {
			if (initialSnapPoint <= 0) {
				return;
			}

			isProgrammaticSnapRef.current = true;
			bottomSheetRef.current?.snapToIndex(0);
			return;
		}

		isProgrammaticCloseRef.current = true;
		bottomSheetRef.current?.close();
	}, [initialSnapPoint, selection]);

	return (
		<BottomSheet
			ref={bottomSheetRef}
			index={-1}
			snapPoints={snapPoints}
			enableDynamicSizing={false}
			enablePanDownToClose
			onChange={handleSheetChange}
			backgroundStyle={styles.background}
			handleIndicatorStyle={styles.handleIndicator}
		>
			<BottomSheetScrollView
				contentContainerStyle={styles.content}
				showsVerticalScrollIndicator={false}
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
