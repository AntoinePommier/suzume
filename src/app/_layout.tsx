import { ReaderProvider } from "@epubjs-react-native/core";
import { Stack } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";

export default function RootLayout() {
	return (
		<GestureHandlerRootView style={{ flex: 1 }}>
			<ReaderProvider>
				<Stack screenOptions={{ headerShown: false }}>
					<Stack.Screen name="index" />
					<Stack.Screen name="reader" options={{ gestureEnabled: false }} />
				</Stack>
			</ReaderProvider>
		</GestureHandlerRootView>
	);
}
