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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	PixelRatio,
	Pressable,
	SafeAreaView,
	ScrollView,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import { getLibraryBookById } from "@/features/library/libraryBooks";
import type { LibraryBook } from "@/features/library/types";
import { useBookAsset } from "@/features/reader/hooks/useBookAsset";
import {
	type FoliateMessage,
	type FoliateReaderHandle,
	FoliateReaderView,
} from "@/features/reader-foliate/FoliateReaderView";
import { createFoliateLayoutKey } from "@/features/reader-foliate/pagination/createFoliateLayoutKey";
import {
	getFoliateLastPosition,
	getFoliatePagination,
	upsertFoliateLastPosition,
	upsertFoliatePagination,
} from "@/features/reader-foliate/pagination/foliateBookRuntimeStorage";
import {
	FOLIATE_ENGINE_BUILD_ID,
	type FoliateReadingPosition,
	type FoliateRenderedPagination,
	type ReaderLayoutProfile,
} from "@/features/reader-foliate/pagination/foliatePaginationTypes";

const MAX_LOG_LINES = 80;

type MeasurementState = "idle" | "checking" | "measuring" | "ready" | "error";

// A CFI with a character offset (contains ":") pinpoints a text position.
// Bare element-only CFIs (e.g. epubcfi(/6/2!/4)) are produced during layout
// stabilisation and must not overwrite a more precise stored position.
function isCfiPrecise(cfi: string): boolean {
	return cfi.includes(":");
}

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

	const { width, height } = useWindowDimensions();
	const pixelRatio = PixelRatio.get();
	const viewportWidth = Math.round(width);
	const viewportHeight = Math.round(height);

	const bookFingerprint = book
		? book.source === "imported"
			? book.fingerprint
			: book.id
		: null;

	const layoutProfile = useMemo<ReaderLayoutProfile | null>(() => {
		if (!book) return null;
		return {
			engine: "foliate",
			engineBuildId: FOLIATE_ENGINE_BUILD_ID,
			viewportWidth,
			viewportHeight,
			pixelRatio,
			orientation: viewportWidth < viewportHeight ? "portrait" : "landscape",
			maxColumnCount: 1,
			flow: "paginated",
		};
	}, [book, viewportWidth, viewportHeight, pixelRatio]);

	const layoutKey = useMemo(
		() => (layoutProfile ? createFoliateLayoutKey(layoutProfile) : null),
		[layoutProfile],
	);

	const readerRef = useRef<FoliateReaderHandle>(null);
	const logIdRef = useRef(0);
	const [logs, setLogs] = useState<{ id: number; text: string }[]>([
		{ id: 0, text: "[FOLIATE-SPIKE] waiting..." },
	]);
	const [lastCfi, setLastCfi] = useState<string | null>(null);
	const [showLogs, setShowLogs] = useState(true);

	const [measurementState, setMeasurementStateInner] =
		useState<MeasurementState>("idle");
	const measurementStateRef = useRef<MeasurementState>("idle");
	const updateMeasurementState = useCallback((s: MeasurementState) => {
		measurementStateRef.current = s;
		setMeasurementStateInner(s);
	}, []);

	// Stable refs to avoid stale closures in callbacks.
	const readerReadyRef = useRef(false);
	const paginationRef = useRef<{
		sectionOffsets: Record<number, number>;
		totalPages: number;
	} | null>(null);

	const addLog = useCallback((line: string) => {
		const id = ++logIdRef.current;
		setLogs((prev) => {
			const next = [...prev, { id, text: line }];
			return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
		});
	}, []);

	const injectPagination = useCallback(() => {
		if (readerReadyRef.current && paginationRef.current) {
			readerRef.current?.setPagination(
				paginationRef.current.sectionOffsets,
				paginationRef.current.totalPages,
			);
		}
	}, []);

	// ── reading position persistence ─────────────────────────────────────────
	// Position loaded from storage at startup; used to restore after "ready".
	const savedPositionRef = useRef<FoliateReadingPosition | null>(null);
	// Position waiting for the debounce timer to fire; flushed on unmount.
	const pendingPositionRef = useRef<FoliateReadingPosition | null>(null);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Stable refs used by the unmount flush (avoids re-running the cleanup effect).
	const bookRef = useRef(book);
	const bookFingerprintRef = useRef(bookFingerprint);
	useEffect(() => {
		bookRef.current = book;
	}, [book]);
	useEffect(() => {
		bookFingerprintRef.current = bookFingerprint;
	}, [bookFingerprint]);

	// Debounced save — 800 ms after the last relocated event.
	// Ignores imprecise CFIs (no character offset) that would overwrite a
	// more precise stored position.
	const scheduleSave = useCallback((position: FoliateReadingPosition) => {
		const existing = pendingPositionRef.current ?? savedPositionRef.current;
		if (existing && isCfiPrecise(existing.cfi) && !isCfiPrecise(position.cfi)) {
			return;
		}
		pendingPositionRef.current = position;
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		saveTimerRef.current = setTimeout(() => {
			const b = bookRef.current;
			const fp = bookFingerprintRef.current;
			if (b && fp) {
				upsertFoliateLastPosition(b.id, fp, position).catch(() => {});
			}
			pendingPositionRef.current = null;
			saveTimerRef.current = null;
		}, 800);
	}, []);

	// Flush any pending save immediately on unmount (user may close right after
	// turning a page, before the 800 ms debounce fires).
	useEffect(() => {
		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			const b = bookRef.current;
			const fp = bookFingerprintRef.current;
			const pending = pendingPositionRef.current;
			if (pending && b && fp) {
				upsertFoliateLastPosition(b.id, fp, pending).catch(() => {});
			}
		};
	}, []);
	// ─────────────────────────────────────────────────────────────────────────

	// Check AsyncStorage for cached pagination + last reading position once
	// book + layout are known. Both reads share the same AsyncStorage key so
	// we run them in parallel (Promise.all) to avoid two sequential round-trips.
	useEffect(() => {
		if (!book || !bookUri || !layoutKey || !bookFingerprint) return;
		let active = true;
		updateMeasurementState("checking");
		Promise.all([
			getFoliatePagination(book.id, bookFingerprint, layoutKey),
			getFoliateLastPosition(book.id, bookFingerprint),
		])
			.then(([cached, lastPos]) => {
				if (!active) return;
				savedPositionRef.current = lastPos;
				if (lastPos) {
					addLog(
						`[FOLIATE-SPIKE] last position sec=${lastPos.sectionIndex} cfi=${lastPos.cfi.slice(0, 48)}`,
					);
				}
				if (cached) {
					addLog(`[FOLIATE-SPIKE] cache HIT totalPages=${cached.totalPages}`);
					for (const [secStr, offset] of Object.entries(
						cached.sectionOffsets,
					)) {
						const sec = Number(secStr);
						addLog(
							`[CACHE-TABLE] sec=${sec} content=${cached.sectionPageCounts[sec] ?? 0} offset=${offset}`,
						);
					}
					paginationRef.current = {
						sectionOffsets: cached.sectionOffsets,
						totalPages: cached.totalPages,
					};
					injectPagination();
					updateMeasurementState("ready");
				} else {
					addLog("[FOLIATE-SPIKE] cache MISS — will measure after book ready");
					updateMeasurementState("measuring");
				}
			})
			.catch((e) => {
				if (active) {
					addLog(`[FOLIATE-SPIKE] cache error: ${String(e)}`);
					updateMeasurementState("measuring");
				}
			});
		return () => {
			active = false;
		};
	}, [
		book,
		bookUri,
		layoutKey,
		bookFingerprint,
		addLog,
		injectPagination,
		updateMeasurementState,
	]);

	const handlePaginationReady = useCallback(
		(payload: {
			sectionPageCounts: Record<number, number>;
			sectionOffsets: Record<number, number>;
			totalPages: number;
		}) => {
			addLog(
				`[FOLIATE-SPIKE] pagination-ready totalPages=${payload.totalPages} sections=${Object.keys(payload.sectionPageCounts).length}`,
			);
			if (!layoutProfile || !layoutKey || !book || !bookFingerprint) {
				addLog(
					"[FOLIATE-SPIKE] pagination-ready: missing context — not stored",
				);
				return;
			}
			const pagination: FoliateRenderedPagination = {
				version: 1,
				layoutKey,
				layoutProfile,
				createdAt: Date.now(),
				sectionPageCounts: payload.sectionPageCounts,
				sectionOffsets: payload.sectionOffsets,
				totalPages: payload.totalPages,
			};
			upsertFoliatePagination(book.id, bookFingerprint, pagination).catch(
				() => {},
			);
			paginationRef.current = {
				sectionOffsets: payload.sectionOffsets,
				totalPages: payload.totalPages,
			};
			injectPagination();
			addLog("[FOLIATE-SPIKE] pagination stored + injected");
			updateMeasurementState("ready");
		},
		[
			layoutProfile,
			layoutKey,
			book,
			bookFingerprint,
			addLog,
			injectPagination,
			updateMeasurementState,
		],
	);

	const handleMessage = useCallback(
		(msg: FoliateMessage) => {
			if (msg.type === "log") {
				console.log(msg.payload);
				addLog(msg.payload);
			} else if (msg.type === "error") {
				addLog(`ERROR: ${msg.payload}`);
			} else if (msg.type === "loaded") {
				addLog(`[FOLIATE-SPIKE] spine ${msg.payload.index} loaded`);
			} else if (msg.type === "ready") {
				readerReadyRef.current = true;
				injectPagination();
				if (measurementStateRef.current === "measuring") {
					const initialCfi = savedPositionRef.current?.cfi ?? null;
					addLog(
						initialCfi
							? `[FOLIATE-SPIKE] book ready — measuring, will restore ${initialCfi.slice(0, 48)}`
							: "[FOLIATE-SPIKE] book ready — measuring from start",
					);
					readerRef.current?.startMeasurement(initialCfi);
				} else {
					const savedCfi = savedPositionRef.current?.cfi;
					if (savedCfi) {
						addLog(
							`[FOLIATE-SPIKE] book ready — restoring ${savedCfi.slice(0, 48)}`,
						);
						readerRef.current?.goTo(savedCfi);
					} else {
						addLog("[FOLIATE-SPIKE] book ready");
					}
				}
			} else if (msg.type === "pagination-ready") {
				handlePaginationReady(msg.payload);
			} else if (msg.type === "pagination-error") {
				addLog(`[FOLIATE-SPIKE] measurement error: ${msg.payload.message}`);
				updateMeasurementState("error");
			} else if (msg.type === "relocated") {
				const {
					cfi,
					fraction,
					sectionCurrent,
					sectionTotal,
					locationCurrent: loc,
					locationTotal: locTotal,
				} = msg.payload;
				if (cfi) setLastCfi(cfi);
				addLog(
					`[FOLIATE-SPIKE] relocated` +
						` sec=${sectionCurrent}/${sectionTotal}` +
						` loc=${loc ?? "n/a"}/${locTotal ?? "n/a"}` +
						` frac=${fraction?.toFixed(4) ?? "n/a"}`,
				);
				// Save position (bridge already suppresses relocated during measurement,
				// but guard here too for safety).
				if (cfi && measurementStateRef.current !== "measuring") {
					scheduleSave({
						cfi,
						fraction: fraction ?? 0,
						sectionIndex: sectionCurrent ?? 0,
						savedAt: Date.now(),
					});
				}
			}
		},
		[
			addLog,
			injectPagination,
			handlePaginationReady,
			scheduleSave,
			updateMeasurementState,
		],
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

			{/* Preparation overlay — covers the reader while pages are being measured.
			    Placed last in JSX so it renders above the HUD. */}
			{measurementState === "measuring" && (
				<View style={styles.overlay}>
					<Text style={styles.overlayText}>Préparation du livre…</Text>
				</View>
			)}
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
	overlay: {
		...StyleSheet.absoluteFillObject,
		backgroundColor: "#F1E2C9",
		alignItems: "center",
		justifyContent: "center",
	},
	overlayText: {
		color: "#555",
		fontSize: 16,
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
