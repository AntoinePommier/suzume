import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useState } from "react";
import {
	Image,
	Pressable,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { type Book, books } from "@/books";
import { useBookCovers } from "@/features/reader/hooks/useBookCovers";
import { colors, radius, spacing } from "@/theme";

function getCoverAccent(book: Book) {
	if (book.id === "le-petit-prince") {
		return colors.accentSoft;
	}

	return colors.accent;
}

function PlaceholderCover({ book }: { book: Book }) {
	const accentColor = getCoverAccent(book);

	return (
		<View style={styles.cover}>
			<View style={[styles.coverAccent, { backgroundColor: accentColor }]} />
			<View style={styles.coverContent}>
				<Text numberOfLines={3} style={styles.coverTitle}>
					{book.title}
				</Text>
				<View style={styles.coverDivider} />
				<Text numberOfLines={2} style={styles.coverAuthor}>
					{book.subtitle}
				</Text>
			</View>
			<View style={styles.coverFooter} />
		</View>
	);
}

function BookCover({
	book,
	coverUri,
}: {
	book: Book;
	coverUri: string | null | undefined;
}) {
	const [imageFailed, setImageFailed] = useState(false);

	if (coverUri && !imageFailed) {
		return (
			<View style={[styles.cover, styles.realCover]}>
				<Image
					source={{ uri: coverUri }}
					style={styles.coverImage}
					resizeMode="cover"
					onError={() => setImageFailed(true)}
				/>
			</View>
		);
	}

	return <PlaceholderCover book={book} />;
}

const contentHorizontalPadding = 22;
const librarySlotCount = 6;
const emptyBookSlotIds = [
	"empty-book-slot-1",
	"empty-book-slot-2",
	"empty-book-slot-3",
	"empty-book-slot-4",
	"empty-book-slot-5",
	"empty-book-slot-6",
];

function BookCard({
	book,
	coverUri,
	width,
}: {
	book: Book;
	coverUri: string | null | undefined;
	width: number;
}) {
	return (
		<Pressable
			style={({ pressed }) => [
				styles.bookCard,
				{ width },
				pressed ? styles.bookCardPressed : null,
			]}
			onPress={() =>
				router.push({
					pathname: "./reader",
					params: { bookId: book.id },
				})
			}
		>
			<BookCover book={book} coverUri={coverUri} />
			<Text numberOfLines={2} style={styles.bookTitle}>
				{book.title}
			</Text>
		</Pressable>
	);
}

function EmptyBookSlot({ width }: { width: number }) {
	return (
		<View style={[styles.bookCard, { width }]}>
			<View style={styles.emptyCoverSlot} />
		</View>
	);
}

export default function HomeScreen() {
	const handlePlaceholderAction = useCallback(() => undefined, []);
	const { height, width } = useWindowDimensions();
	const coverUris = useBookCovers(books);
	const continueCardHeight = Math.max(
		168,
		Math.min(214, Math.round(height * 0.24)),
	);
	const bookCardWidth = Math.max(
		82,
		Math.min(92, Math.floor((width - contentHorizontalPadding * 2 - 28) / 3)),
	);
	const emptySlotIds = emptyBookSlotIds.slice(
		0,
		Math.max(0, librarySlotCount - books.length),
	);

	return (
		<SafeAreaView style={styles.safeArea}>
			<StatusBar style="light" />
			<View style={styles.content}>
				<View style={styles.header}>
					<View style={styles.headerText}>
						<Text style={styles.title}>Suzume</Text>
						<Text style={styles.subtitle}>Japanese EPUB reader</Text>
					</View>

					<View style={styles.headerActions}>
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Import book"
							onPress={handlePlaceholderAction}
							style={({ pressed }) => [
								styles.headerAction,
								pressed ? styles.headerActionPressed : null,
							]}
						>
							<Text style={styles.headerActionIcon}>+</Text>
							<Text style={styles.headerActionLabel}>Import</Text>
						</Pressable>

						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Settings"
							onPress={handlePlaceholderAction}
							style={({ pressed }) => [
								styles.headerAction,
								pressed ? styles.headerActionPressed : null,
							]}
						>
							<Text style={styles.headerActionIcon}>⋯</Text>
							<Text style={styles.headerActionLabel}>Settings</Text>
						</Pressable>
					</View>
				</View>

				<View style={styles.continueSection}>
					<View
						style={[styles.emptyRecentCard, { height: continueCardHeight }]}
					>
						<View style={styles.emptyIcon}>
							<Text style={styles.emptyIconText}>□</Text>
						</View>
						<View style={styles.emptyCopy}>
							<Text style={styles.emptyTitle}>No recent book yet</Text>
							<Text style={styles.emptyDescription}>
								Choose a book from your library to start reading.
							</Text>
						</View>
					</View>
				</View>

				<View style={styles.section}>
					<Text style={styles.sectionTitle}>Library</Text>
					<View style={styles.libraryGrid}>
						{books.map((book) => (
							<BookCard
								key={book.id}
								book={book}
								coverUri={coverUris[book.id]}
								width={bookCardWidth}
							/>
						))}
						{emptySlotIds.map((slotId) => (
							<EmptyBookSlot key={slotId} width={bookCardWidth} />
						))}
					</View>
				</View>
			</View>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	safeArea: {
		flex: 1,
		backgroundColor: colors.background,
	},
	content: {
		flex: 1,
		paddingHorizontal: contentHorizontalPadding,
		paddingTop: spacing.sm,
		paddingBottom: spacing.md,
	},
	header: {
		flexDirection: "row",
		alignItems: "flex-start",
		justifyContent: "space-between",
		gap: spacing.md,
	},
	headerText: {
		flex: 1,
	},
	title: {
		color: colors.text,
		fontSize: 22,
		fontWeight: "700",
		letterSpacing: 0,
	},
	subtitle: {
		marginTop: 2,
		color: colors.paperMuted,
		fontSize: 12,
		fontWeight: "500",
	},
	headerActions: {
		flexDirection: "row",
		gap: spacing.sm,
	},
	headerAction: {
		minWidth: 42,
		alignItems: "center",
		paddingVertical: 2,
		borderRadius: radius.md,
	},
	headerActionPressed: {
		backgroundColor: colors.surfaceSoft,
	},
	headerActionIcon: {
		color: colors.paperMuted,
		fontSize: 22,
		fontWeight: "300",
		lineHeight: 24,
	},
	headerActionLabel: {
		marginTop: 1,
		color: colors.textMuted,
		fontSize: 10,
		fontWeight: "500",
	},
	section: {
		marginTop: spacing.lg,
	},
	continueSection: {
		marginTop: spacing.lg,
	},
	sectionTitle: {
		marginBottom: spacing.sm + 2,
		color: colors.text,
		fontSize: 17,
		fontWeight: "700",
	},
	emptyRecentCard: {
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: spacing.sm,
		paddingHorizontal: spacing.lg,
		paddingVertical: spacing.lg,
		backgroundColor: colors.surface,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		borderRadius: radius.lg,
	},
	emptyIcon: {
		width: 48,
		height: 48,
		alignItems: "center",
		justifyContent: "center",
		borderRadius: radius.md,
		backgroundColor: colors.surfaceSoft,
	},
	emptyIconText: {
		color: colors.accentSoft,
		fontSize: 31,
		lineHeight: 33,
		transform: [{ rotate: "45deg" }],
	},
	emptyCopy: {
		alignItems: "center",
	},
	emptyTitle: {
		color: colors.text,
		fontSize: 16,
		fontWeight: "600",
		textAlign: "center",
	},
	emptyDescription: {
		marginTop: spacing.xs,
		color: colors.textMuted,
		fontSize: 13,
		lineHeight: 18,
		textAlign: "center",
	},
	libraryGrid: {
		flexDirection: "row",
		flexWrap: "wrap",
		justifyContent: "space-between",
		rowGap: spacing.sm + 2,
	},
	bookCard: {
		flexShrink: 0,
	},
	emptyCoverSlot: {
		aspectRatio: 0.72,
		borderRadius: radius.sm,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.surface,
		opacity: 0.45,
	},
	bookCardPressed: {
		opacity: 0.82,
	},
	cover: {
		aspectRatio: 0.72,
		overflow: "hidden",
		paddingHorizontal: spacing.xs + 2,
		paddingVertical: spacing.sm,
		backgroundColor: colors.paper,
		borderRadius: radius.sm,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.paperMuted,
		shadowColor: "#000000",
		shadowOffset: { width: 0, height: 5 },
		shadowOpacity: 0.13,
		shadowRadius: 10,
		elevation: 3,
	},
	realCover: {
		paddingHorizontal: 0,
		paddingVertical: 0,
	},
	coverImage: {
		width: "100%",
		height: "100%",
	},
	coverAccent: {
		position: "absolute",
		top: 0,
		left: 0,
		right: 0,
		height: 4,
	},
	coverContent: {
		flex: 1,
		alignItems: "center",
		justifyContent: "space-between",
		paddingTop: spacing.xs + 2,
		paddingBottom: spacing.xs,
	},
	coverTitle: {
		color: colors.textOnPaper,
		fontSize: 14,
		fontWeight: "700",
		lineHeight: 18,
		textAlign: "center",
	},
	coverDivider: {
		width: 22,
		height: StyleSheet.hairlineWidth,
		backgroundColor: colors.accent,
	},
	coverAuthor: {
		color: colors.textMutedOnPaper,
		fontSize: 9,
		fontWeight: "500",
		lineHeight: 12,
		textAlign: "center",
	},
	coverFooter: {
		height: 8,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.paperMuted,
		opacity: 0.7,
	},
	bookTitle: {
		marginTop: spacing.xs,
		color: colors.text,
		fontSize: 11,
		fontWeight: "600",
		lineHeight: 14,
	},
});
