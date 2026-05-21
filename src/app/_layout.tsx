import { ReaderProvider } from "@epubjs-react-native/core";
import { Stack } from "expo-router";

export default function RootLayout() {
	return (
		<ReaderProvider>
			<Stack screenOptions={{ headerShown: false }} />
		</ReaderProvider>
	);
}
