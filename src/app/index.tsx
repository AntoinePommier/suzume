import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";

export default function HomeScreen() {
	return (
		<View style={styles.container}>
			<StatusBar style="light" />

			<Text style={styles.title}>Suzume</Text>

			<Text style={styles.subtitle}>Japanese ebook reader</Text>
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
});
