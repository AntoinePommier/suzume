/**
 * Prototype — snapshot page-turn overlay (spike, behind SNAPSHOT_PAGE_TURN_ENABLED).
 *
 * Sequence per swipe, driven by the bridge "turn-intent" message:
 *   1. capture the reader container (react-native-view-shot, visible viewport);
 *   2. mount the capture as an Animated.Image above the reader (pixel-identical,
 *      so the mount itself is invisible);
 *   3. trigger the real — instant — Foliate page turn underneath (__turnNav);
 *   4. wait for the relocated message (or a short fallback timeout);
 *   5. slide the snapshot off horizontally in the finger direction, revealing
 *      the new page already rendered below;
 *   6. unmount and release the temp file.
 *
 * Any capture failure or timeout falls back to direct navigation without
 * animation — the turn itself is never lost. The overlay is pointer-events
 * none and only exists for the duration of one turn, so taps, dictionary
 * hit-testing and Foliate internals are never touched.
 *
 * Timing log (single summary line per turn):
 *   [SNAPTURN] ok action=… intent=…ms capture=…ms mount=…ms landed=…ms(reason)
 *              slide=…ms total=…ms
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
	Animated,
	Easing,
	Image,
	StyleSheet,
	useWindowDimensions,
} from "react-native";
import { releaseCapture } from "react-native-view-shot";

export type TurnIntent = {
	action: "goLeft" | "goRight";
	dir: 1 | -1;
	t: number;
};

export type SnapshotPageTurnHandle = {
	/** Start a snapshot turn; falls back to direct nav if one is in flight. */
	begin: (intent: TurnIntent) => void;
	/** Called by the screen whenever a relocated message arrives. */
	notifyRelocated: () => void;
};

type Props = {
	/** Captures the reader container; resolves to a tmpfile URI. */
	capture: () => Promise<string>;
	/** Runs the real Foliate navigation (window.__turnNav in the bridge). */
	nav: (action: "goLeft" | "goRight") => void;
	log: (line: string) => void;
};

type Phase = "idle" | "capturing" | "mounting" | "navigating" | "sliding";

const CAPTURE_TIMEOUT_MS = 250;
const RELOCATED_FALLBACK_MS = 700;
// Held fully covered after the jump: spans the 1-2 frames during which
// WKWebView may still composite stale tiles of the previous page (ghosting).
const PRE_SLIDE_HOLD_MS = 50;
const SLIDE_DURATION_MS = 200;

export const SnapshotPageTurn = forwardRef<SnapshotPageTurnHandle, Props>(
	function SnapshotPageTurn({ capture, nav, log }, ref) {
		const { width } = useWindowDimensions();
		const [snapshotUri, setSnapshotUri] = useState<string | null>(null);
		const translateX = useRef(new Animated.Value(0)).current;

		const phaseRef = useRef<Phase>("idle");
		const intentRef = useRef<TurnIntent | null>(null);
		const uriRef = useRef<string | null>(null);
		const timingsRef = useRef<Record<string, number>>({});
		const landedRef = useRef(false);
		const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

		const clearTimers = useCallback(() => {
			if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
			if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
			fallbackTimerRef.current = null;
			holdTimerRef.current = null;
		}, []);

		const finishTurn = useCallback(() => {
			clearTimers();
			const uri = uriRef.current;
			uriRef.current = null;
			setSnapshotUri(null);
			translateX.setValue(0);
			phaseRef.current = "idle";
			if (uri) releaseCapture(uri);
		}, [clearTimers, translateX]);

		// Safety: never leak the temp file if the screen unmounts mid-turn.
		useEffect(() => {
			return () => {
				clearTimers();
				if (uriRef.current) releaseCapture(uriRef.current);
			};
		}, [clearTimers]);

		const logSummary = useCallback(
			(landedBy: string) => {
				const T = timingsRef.current;
				const intent = intentRef.current;
				log(
					`[SNAPTURN] ok action=${intent?.action}` +
						` intent=${T.captureStart - T.touchend}ms` +
						` capture=${T.captureDone - T.captureStart}ms` +
						` mount=${T.mounted - T.captureDone}ms` +
						` landed=${T.landed - T.navSent}ms(${landedBy})` +
						` slide=${T.slideEnd - T.slideStart}ms` +
						` total=${T.slideEnd - T.touchend}ms`,
				);
			},
			[log],
		);

		const startSlide = useCallback(
			(landedBy: string) => {
				const intent = intentRef.current;
				if (!intent) return;
				timingsRef.current.landed = Date.now();
				phaseRef.current = "sliding";
				holdTimerRef.current = setTimeout(() => {
					holdTimerRef.current = null;
					timingsRef.current.slideStart = Date.now();
					Animated.timing(translateX, {
						toValue: intent.dir * width,
						duration: SLIDE_DURATION_MS,
						easing: Easing.in(Easing.quad),
						useNativeDriver: true,
					}).start(({ finished }) => {
						timingsRef.current.slideEnd = Date.now();
						if (finished) logSummary(landedBy);
						finishTurn();
					});
				}, PRE_SLIDE_HOLD_MS);
			},
			[finishTurn, logSummary, translateX, width],
		);

		const handleLanded = useCallback(
			(reason: string) => {
				if (phaseRef.current !== "navigating" || landedRef.current) return;
				landedRef.current = true;
				if (fallbackTimerRef.current) {
					clearTimeout(fallbackTimerRef.current);
					fallbackTimerRef.current = null;
				}
				startSlide(reason);
			},
			[startSlide],
		);

		// The snapshot is decoded; wait two frames so it is actually presented
		// on screen before the instant page turn happens underneath it.
		const handleImageLoaded = useCallback(() => {
			if (phaseRef.current !== "mounting") return;
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					const intent = intentRef.current;
					if (phaseRef.current !== "mounting" || !intent) return;
					timingsRef.current.mounted = Date.now();
					phaseRef.current = "navigating";
					landedRef.current = false;
					nav(intent.action);
					timingsRef.current.navSent = Date.now();
					fallbackTimerRef.current = setTimeout(() => {
						fallbackTimerRef.current = null;
						handleLanded("fallback");
					}, RELOCATED_FALLBACK_MS);
				});
			});
		}, [handleLanded, nav]);

		const begin = useCallback(
			(intent: TurnIntent) => {
				if (phaseRef.current !== "idle") {
					// Rapid swipes degrade gracefully: instant turn, no animation.
					log(`[SNAPTURN] busy (${phaseRef.current}) — direct nav`);
					nav(intent.action);
					return;
				}
				phaseRef.current = "capturing";
				intentRef.current = intent;
				timingsRef.current = { touchend: intent.t, captureStart: Date.now() };
				translateX.setValue(0);

				let settled = false;
				const capturePromise = capture();
				const timeout = new Promise<never>((_, reject) => {
					setTimeout(
						() => reject(new Error("capture-timeout")),
						CAPTURE_TIMEOUT_MS,
					);
				});
				Promise.race([capturePromise, timeout])
					.then((uri) => {
						settled = true;
						if (phaseRef.current !== "capturing") {
							releaseCapture(uri);
							return;
						}
						timingsRef.current.captureDone = Date.now();
						uriRef.current = uri;
						phaseRef.current = "mounting";
						setSnapshotUri(uri); // → onLoad → handleImageLoaded
					})
					.catch((e: Error) => {
						if (settled) return;
						settled = true;
						// Late capture result must still release its temp file.
						capturePromise.then((uri) => releaseCapture(uri)).catch(() => {});
						log(`[SNAPTURN] capture failed (${e.message}) — direct nav`);
						phaseRef.current = "idle";
						intentRef.current = null;
						nav(intent.action);
					});
			},
			[capture, log, nav, translateX],
		);

		const notifyRelocated = useCallback(() => {
			handleLanded("relocated");
		}, [handleLanded]);

		useImperativeHandle(ref, () => ({ begin, notifyRelocated }), [
			begin,
			notifyRelocated,
		]);

		if (!snapshotUri) return null;
		return (
			<Animated.View
				pointerEvents="none"
				style={[StyleSheet.absoluteFill, { transform: [{ translateX }] }]}
			>
				<Image
					source={{ uri: snapshotUri }}
					fadeDuration={0}
					resizeMode="stretch"
					onLoad={handleImageLoaded}
					style={StyleSheet.absoluteFill}
				/>
			</Animated.View>
		);
	},
);
