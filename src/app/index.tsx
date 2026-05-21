import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Pressable, StyleSheet, Text, View } from "react-native";

export default function HomeScreen() {
	return (
		<View style={styles.container}>
			<StatusBar style="light" />

			<Text style={styles.title}>Suzume</Text>

			<Text style={styles.subtitle}>Japanese ebook reader</Text>

			<Pressable style={styles.button} onPress={() => router.push("./reader")}>
				<Text style={styles.buttonText}>Start Reading</Text>
			</Pressable>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: "#111111",
		alignItems: "center",
		justifyContent: "center",
		gap: 12,
	},
	title: {
		fontSize: 32,
		fontWeight: "700",
		color: "#ffffff",
	},
	subtitle: {
		fontSize: 16,
		color: "#999999",
	},
	button: {
		marginTop: 24,
		paddingHorizontal: 24,
		paddingVertical: 12,
		backgroundColor: "#ffffff",
		borderRadius: 12,
	},
	buttonText: {
		color: "#111111",
		fontSize: 16,
		fontWeight: "600",
	},
});
