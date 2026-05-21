import { books } from "@/books";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Pressable, StyleSheet, Text, View } from "react-native";

export default function HomeScreen() {
	return (
		<View style={styles.container}>
			<StatusBar style="light" />

			<Text style={styles.title}>Suzume</Text>

			<Text style={styles.subtitle}>Choose a book</Text>

			<View style={styles.bookList}>
				{books.map((book) => (
					<Pressable
						key={book.id}
						style={styles.bookButton}
						onPress={() =>
							router.push({
								pathname: "./reader",
								params: { bookId: book.id },
							})
						}
					>
						<Text style={styles.bookTitle}>{book.title}</Text>
						<Text style={styles.bookSubtitle}>{book.subtitle}</Text>
					</Pressable>
				))}
			</View>
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
	bookList: {
		marginTop: 24,
		width: "100%",
		maxWidth: 360,
		gap: 12,
		paddingHorizontal: 24,
	},
	bookButton: {
		paddingHorizontal: 18,
		paddingVertical: 16,
		backgroundColor: "#ffffff",
		borderRadius: 8,
	},
	bookTitle: {
		color: "#111111",
		fontSize: 17,
		fontWeight: "600",
	},
	bookSubtitle: {
		marginTop: 4,
		color: "#666666",
		fontSize: 14,
	},
});
