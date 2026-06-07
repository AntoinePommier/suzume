import {
	forwardRef,
	useCallback,
	useImperativeHandle,
	useMemo,
	useRef,
} from "react";
import { StyleSheet, View } from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import { buildFoliateHtml } from "./foliateReaderHtml";

export type FoliateMessage =
	| { type: "log"; payload: string }
	| { type: "error"; payload: string }
	| { type: "loaded"; payload: { index: number } }
	| {
			type: "relocated";
			payload: {
				cfi: string | null;
				fraction: number | null;
				sectionCurrent: number | null;
				sectionTotal: number | null;
				locationCurrent: number | null;
			};
	  };

export type FoliateReaderHandle = {
	next: () => void;
	prev: () => void;
	goTo: (cfi: string) => void;
};

type Props = {
	bookBase64: string;
	onMessage?: (msg: FoliateMessage) => void;
};

export const FoliateReaderView = forwardRef<FoliateReaderHandle, Props>(
	function FoliateReaderView({ bookBase64, onMessage }, ref) {
		const webViewRef = useRef<WebView>(null);

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
				goTo: (cfi: string) =>
					inject(`window.__goTo(${JSON.stringify(cfi)});`),
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
			<View style={styles.container}>
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
