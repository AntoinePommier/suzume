import BottomSheet, { BottomSheetView } from "@gorhom/bottom-sheet";
import { useEffect, useMemo, useRef } from "react";
import { StyleSheet, Text } from "react-native";

import type { DictionarySelection } from "./types";

type DictionaryBottomSheetProps = {
	selection: DictionarySelection | null;
	onDismiss: () => void;
};

export function DictionaryBottomSheet({
	selection,
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
});
