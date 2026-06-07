/**
 * Spike screen for foliate-js reader — etape 1.
 *
 * Scope: engine validation only.
 * - Loads and displays an EPUB with foliate-js.
 * - Tests vertical-rl / RTL rendering.
 * - Tests cross-spine backward navigation correctness.
 * - Logs location events with prefix [FOLIATE-SPIKE].
 *
 * Out of scope: dictionary, progress persistence, theme, proper error UI.
 * Delete this file and src/features/reader-foliate/ to remove the spike.
 */

import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	Pressable,
	SafeAreaView,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import type { LibraryBook } from "@/features/library/types";
import { getLibraryBookById } from "@/features/library/libraryBooks";
import {
	type FoliateMessage,
	type FoliateReaderHandle,
	FoliateReaderView,
} from "@/features/reader-foliate/FoliateReaderView";
import { useBookAsset } from "@/features/reader/hooks/useBookAsset";

const MAX_LOG_LINES = 80;

export default function FoliateReaderScreen() {
	const { bookId } = useLocalSearchParams<{ bookId?: string }>();
	const normalizedBookId = Array.isArray(bookId) ? bookId[0] : bookId;
	const [book, setBook] = useState<LibraryBook | null>(null);

	useEffect(() => {
		let active = true;
		getLibraryBookById(normalizedBookId)
			.then((b) => {
				if (active) setBook(b);
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, [normalizedBookId]);

	const { bookUri, bookError } = useBookAsset(book);

	const readerRef = useRef<FoliateReaderHandle>(null);
	const logIdRef = useRef(0);
	const [logs, setLogs] = useState<{ id: number; text: string }[]>([
		{ id: 0, text: "[FOLIATE-SPIKE] waiting..." },
	]);
	const [lastCfi, setLastCfi] = useState<string | null>(null);
	const [showLogs, setShowLogs] = useState(true);

	const addLog = useCallback((line: string) => {
		const id = ++logIdRef.current;
		setLogs((prev) => {
			const next = [...prev, { id, text: line }];
			return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
		});
	}, []);

	const handleMessage = useCallback(
		(msg: FoliateMessage) => {
			if (msg.type === "log") {
				console.log(msg.payload);
				addLog(msg.payload);
			} else if (msg.type === "error") {
				console.error(msg.payload);
				addLog(`ERROR: ${msg.payload}`);
			} else if (msg.type === "loaded") {
				addLog(`[FOLIATE-SPIKE] spine ${msg.payload.index} loaded`);
			} else if (msg.type === "relocated") {
				const { cfi, fraction, sectionCurrent, sectionTotal } = msg.payload;
				if (cfi) setLastCfi(cfi);
				addLog(
					`[FOLIATE-SPIKE] relocated` +
						` sec=${sectionCurrent}/${sectionTotal}` +
						` frac=${fraction?.toFixed(4) ?? "n/a"}`,
				);
			}
		},
		[addLog],
	);

	if (bookError) {
		return (
			<SafeAreaView style={styles.center}>
				<Text style={styles.errorText}>Error: {bookError}</Text>
				<Pressable style={styles.btn} onPress={() => router.back()}>
					<Text style={styles.btnText}>Back</Text>
				</Pressable>
			</SafeAreaView>
		);
	}

	if (!bookUri) {
		return (
			<SafeAreaView style={styles.center}>
				<Text style={styles.loadingText}>[FOLIATE-SPIKE] loading EPUB...</Text>
			</SafeAreaView>
		);
	}

	return (
		<View style={styles.root}>
			<FoliateReaderView
				ref={readerRef}
				bookBase64={bookUri}
				onMessage={handleMessage}
			/>

			{/* Minimal HUD — prev/next buttons + log toggle */}
			<SafeAreaView style={styles.hud} pointerEvents="box-none">
				<View style={styles.navRow} pointerEvents="box-none">
					<Pressable
						style={styles.navBtn}
						onPress={() => readerRef.current?.prev()}
					>
						<Text style={styles.navBtnText}>← Prev</Text>
					</Pressable>

					<Pressable
						style={styles.navBtn}
						onPress={() => setShowLogs((v) => !v)}
					>
						<Text style={styles.navBtnText}>
							{showLogs ? "Hide logs" : "Show logs"}
						</Text>
					</Pressable>

					<Pressable
						style={styles.navBtn}
						onPress={() => readerRef.current?.next()}
					>
						<Text style={styles.navBtnText}>Next →</Text>
					</Pressable>
				</View>

				{showLogs && (
					<View style={styles.logPanel}>
						<ScrollView
							style={styles.logScroll}
							contentContainerStyle={styles.logContent}
						>
							{logs.map(({ id, text }) => (
								<Text key={id} style={styles.logLine}>
									{text}
								</Text>
							))}
						</ScrollView>
						{lastCfi ? (
							<Text style={styles.cfiLine} numberOfLines={2}>
								CFI: {lastCfi}
							</Text>
						) : null}
						<Pressable
							style={[styles.navBtn, styles.backBtn]}
							onPress={() => router.back()}
						>
							<Text style={styles.navBtnText}>← Back to library</Text>
						</Pressable>
					</View>
				)}
			</SafeAreaView>
		</View>
	);
}

const styles = StyleSheet.create({
	root: {
		flex: 1,
		backgroundColor: "#F1E2C9",
	},
	center: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "#F1E2C9",
		gap: 16,
	},
	errorText: {
		color: "#c00",
		fontSize: 14,
		textAlign: "center",
		paddingHorizontal: 20,
	},
	loadingText: {
		color: "#555",
		fontSize: 13,
		fontFamily: "monospace",
	},
	hud: {
		position: "absolute",
		bottom: 0,
		left: 0,
		right: 0,
	},
	navRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		paddingHorizontal: 12,
		paddingBottom: 4,
		gap: 8,
	},
	navBtn: {
		backgroundColor: "rgba(0,0,0,0.55)",
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderRadius: 8,
	},
	navBtnText: {
		color: "#fff",
		fontSize: 13,
		fontFamily: "monospace",
	},
	logPanel: {
		backgroundColor: "rgba(0,0,0,0.82)",
		marginHorizontal: 8,
		marginBottom: 8,
		borderRadius: 8,
		padding: 8,
		maxHeight: 220,
	},
	logScroll: {
		flex: 1,
	},
	logContent: {
		paddingBottom: 4,
	},
	logLine: {
		color: "#b8ffb8",
		fontSize: 10,
		fontFamily: "monospace",
		lineHeight: 14,
	},
	cfiLine: {
		color: "#ffdd88",
		fontSize: 10,
		fontFamily: "monospace",
		marginTop: 4,
	},
	backBtn: {
		marginTop: 6,
		alignSelf: "flex-start",
	},
	btn: {
		backgroundColor: "#333",
		paddingHorizontal: 20,
		paddingVertical: 10,
		borderRadius: 8,
	},
	btnText: {
		color: "#fff",
		fontSize: 14,
	},
});
