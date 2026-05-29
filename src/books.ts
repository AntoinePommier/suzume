import type { BundledBook, LibraryBook } from "@/features/library/types";

export type Book = LibraryBook;
export type BookId = string;

export const bundledBooks: BundledBook[] = [
	{
		id: "shika-no-ou-1",
		title: "鹿の王 1",
		subtitle: "Nahoko Uehashi",
		source: "bundled",
		asset: require("../assets/books/shika-no-ou-1.epub"),
	},
	{
		id: "le-petit-prince",
		title: "Le Petit Prince",
		subtitle: "Antoine de Saint-Exupéry",
		source: "bundled",
		asset: require("../assets/books/le-petit-prince.epub"),
	},
];

export const books: Book[] = bundledBooks;

export function getBundledBookById(bookId: string | string[] | undefined) {
	const normalizedBookId = Array.isArray(bookId) ? bookId[0] : bookId;

	return bundledBooks.find((book) => book.id === normalizedBookId) ?? null;
}
