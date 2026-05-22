import BottomSheet, { BottomSheetView } from "@gorhom/bottom-sheet";
import { useEffect, useMemo, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { DictionaryLookupResult, DictionarySelection } from "./types";

type DictionaryBottomSheetProps = {
	selection: DictionarySelection | null;
	lookupResult: DictionaryLookupResult | null;
	onDismiss: () => void;
};

export function DictionaryBottomSheet({
	selection,
	lookupResult,
	onDismiss,
}: DictionaryBottomSheetProps) {
	const bottomSheetRef = useRef<BottomSheet>(null);
	const snapPoints = useMemo(() => ["22%", "48%"], []);

	useEffect(() => {
		if (selection) {
			bottomSheetRef.current?.snapToIndex(0);
		} else {
			bottomSheetRef.current?.close();
		}
	}, [selection]);

	return (
		<BottomSheet
			ref={bottomSheetRef}
			index={-1}
			snapPoints={snapPoints}
			enablePanDownToClose
			onClose={onDismiss}
			backgroundStyle={styles.background}
			handleIndicatorStyle={styles.handleIndicator}
		>
			<BottomSheetView style={styles.content}>
				<Text style={styles.label}>Character</Text>
				<Text style={styles.selectedText}>{selection?.character}</Text>

				<Text style={[styles.label, styles.contextLabel]}>Context</Text>
				<Text style={styles.contextText}>{selection?.context}</Text>

				<Text style={[styles.label, styles.dictionaryLabel]}>Dictionary</Text>

				{lookupResult?.status === "not-installed" ? (
					<Text style={styles.mutedText}>Dictionary not installed.</Text>
				) : null}

				{lookupResult?.status === "error" ? (
					<Text style={styles.mutedText}>Dictionary unavailable.</Text>
				) : null}

				{lookupResult?.status === "ready" &&
				lookupResult.entries.length === 0 ? (
					<Text style={styles.mutedText}>No match found.</Text>
				) : null}

				{lookupResult?.status === "ready"
					? lookupResult.entries.map((entry, index) => (
							<View
								key={`${entry.expression}-${entry.reading}-${entry.sequence ?? index}`}
								style={styles.entry}
							>
								<Text style={styles.entryExpression}>
									{entry.expression}
									{entry.reading && entry.reading !== entry.expression
										? ` [${entry.reading}]`
										: ""}
								</Text>

								{entry.glossary.map((glossary, glossaryIndex) => (
									<Text
										key={`${entry.sequence ?? index}-${glossaryIndex}`}
										style={styles.glossary}
									>
										{glossary}
									</Text>
								))}
							</View>
						))
					: null}
			</BottomSheetView>
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
		flex: 1,
		paddingHorizontal: 20,
		paddingBottom: 28,
	},
	label: {
		color: "#666666",
		fontSize: 13,
		fontWeight: "700",
		textTransform: "uppercase",
	},
	selectedText: {
		marginTop: 12,
		color: "#111111",
		fontSize: 24,
		lineHeight: 34,
	},
	contextLabel: {
		marginTop: 20,
	},
	contextText: {
		marginTop: 8,
		color: "#111111",
		fontSize: 18,
		lineHeight: 28,
	},
	dictionaryLabel: {
		marginTop: 22,
	},
	mutedText: {
		marginTop: 10,
		color: "#777777",
		fontSize: 15,
		lineHeight: 22,
	},
	entry: {
		marginTop: 14,
		paddingTop: 14,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: "#dddddd",
	},
	entryExpression: {
		color: "#111111",
		fontSize: 18,
		fontWeight: "700",
		lineHeight: 26,
	},
	glossary: {
		marginTop: 6,
		color: "#333333",
		fontSize: 15,
		lineHeight: 22,
	},
});
