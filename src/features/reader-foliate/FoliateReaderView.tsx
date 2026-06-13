import {
	forwardRef,
	useCallback,
	useImperativeHandle,
	useMemo,
	useRef,
} from "react";
import { StyleSheet, View } from "react-native";
import { captureRef } from "react-native-view-shot";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import type { DictionarySelection } from "@/features/dictionary";
import { buildFoliateHtml } from "./foliateReaderHtml";

export type FoliateMessage =
	| { type: "log"; payload: string }
	| { type: "error"; payload: string }
	| { type: "loaded"; payload: { index: number } }
	| { type: "ready"; payload: Record<string, never> }
	| {
			type: "pagination-ready";
			payload: {
				sectionPageCounts: Record<number, number>;
				sectionOffsets: Record<number, number>;
				totalPages: number;
			};
	  }
	| { type: "pagination-error"; payload: { message: string } }
	| { type: "reader-background-tap"; payload: Record<string, never> }
	| { type: "reader-page-turn"; payload: Record<string, never> }
	| { type: "dictionary-tap"; payload: DictionarySelection }
	| { type: "dictionary-close"; payload: Record<string, never> }
	// Prototype snapshot page turn: swipe validated in the bridge, navigation
	// deferred to RN (capture → overlay → __turnNav). t = bridge Date.now().
	| {
			type: "turn-intent";
			payload: { action: "goLeft" | "goRight"; dir: 1 | -1; t: number };
	  }
	| {
			type: "relocated";
			payload: {
				cfi: string | null;
				fraction: number | null;
				sectionCurrent: number | null;
				sectionTotal: number | null;
				locationCurrent: number | null;
				locationTotal: number | null;
			};
	  };

export type FoliateReaderHandle = {
	next: () => void;
	prev: () => void;
	goLeft: () => void;
	goRight: () => void;
	goTo: (cfi: string) => void;
	setPagination: (
		sectionOffsets: Record<number, number>,
		totalPages: number,
	) => void;
	startMeasurement: (initialCfi?: string | null) => void;
	clearDictionaryHighlight: () => void;
	highlightDictionaryMatch: (text: string) => void;
	setDictionaryOpen: (open: boolean) => void;
	// Prototype snapshot page turn.
	capturePage: () => Promise<string>;
	turnNav: (action: "goLeft" | "goRight") => void;
};

type Props = {
	bookBase64: string;
	onMessage?: (msg: FoliateMessage) => void;
};

export const FoliateReaderView = forwardRef<FoliateReaderHandle, Props>(
	function FoliateReaderView({ bookBase64, onMessage }, ref) {
		const webViewRef = useRef<WebView>(null);
		// Capture target for the snapshot page turn: the container View wrapping
		// the WebView only — RN siblings (chrome, dictionary sheet) are excluded.
		const containerRef = useRef<View>(null);

		// Built once — the HTML is static (bundle + bridge script).
		const html = useMemo(() => buildFoliateHtml(), []);

		// Pre-inject the book base64 before the page HTML is parsed.
		// The bridge script reads window.__BOOK_B64 on DOMContentLoaded and
		// opens the book immediately without a separate injectJavaScript round-trip.
		const preInjected = useMemo(
			() => `window.__BOOK_B64 = ${JSON.stringify(bookBase64)};`,
			[bookBase64],
		);

		const inject = useCallback((js: string) => {
			webViewRef.current?.injectJavaScript(`${js} true;`);
		}, []);

		useImperativeHandle(
			ref,
			() => ({
				next: () => inject("window.__navNext();"),
				prev: () => inject("window.__navPrev();"),
				goLeft: () => inject("window.__navGoLeft();"),
				goRight: () => inject("window.__navGoRight();"),
				goTo: (cfi: string) => inject(`window.__goTo(${JSON.stringify(cfi)});`),
				setPagination: (
					sectionOffsets: Record<number, number>,
					totalPages: number,
				) =>
					inject(
						`window.__setGlobalPagination(${JSON.stringify({ sectionOffsets, totalPages })});`,
					),
				startMeasurement: (initialCfi) =>
					inject(
						`window.__startMeasurement(${JSON.stringify(initialCfi ?? null)});`,
					),
				clearDictionaryHighlight: () =>
					inject(
						"window.__suzumeClearDictionaryHighlight && window.__suzumeClearDictionaryHighlight();",
					),
				highlightDictionaryMatch: (text: string) =>
					inject(
						`window.__suzumeHighlightDictionaryMatch && window.__suzumeHighlightDictionaryMatch(${JSON.stringify(text)});`,
					),
				setDictionaryOpen: (open: boolean) =>
					inject(
						`window.__suzumeSetDictionaryOpen && window.__suzumeSetDictionaryOpen(${open});`,
					),
				// Visible-viewport capture of the reader. PNG (lossless) so the
				// mounted overlay is pixel-identical to the live page beneath it.
				capturePage: () =>
					captureRef(containerRef, { result: "tmpfile", format: "png" }),
				turnNav: (action: "goLeft" | "goRight") =>
					inject(`window.__turnNav(${JSON.stringify(action)});`),
			}),
			[inject],
		);

		const handleMessage = useCallback(
			(event: WebViewMessageEvent) => {
				if (!onMessage) return;
				try {
					const msg = JSON.parse(event.nativeEvent.data) as FoliateMessage;
					onMessage(msg);
				} catch {
					// ignore malformed messages
				}
			},
			[onMessage],
		);

		return (
			<View ref={containerRef} collapsable={false} style={styles.container}>
				<WebView
					ref={webViewRef}
					source={{ html }}
					injectedJavaScriptBeforeContentLoaded={preInjected}
					onMessage={handleMessage}
					originWhitelist={["*"]}
					allowFileAccess
					allowUniversalAccessFromFileURLs
					javaScriptEnabled
					scrollEnabled={false}
					overScrollMode="never"
					bounces={false}
					style={styles.webView}
				/>
			</View>
		);
	},
);

const styles = StyleSheet.create({
	container: {
		flex: 1,
	},
	webView: {
		flex: 1,
		backgroundColor: "#F1E2C9",
	},
});
