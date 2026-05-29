import { bundledBooks } from "@/books";
import type { ReadingProgressState } from "@/features/reader/readingProgressStorage";
import { getLibraryStorageState } from "./libraryStorage";
import type { LibraryBook } from "./types";

function getBookSortTimestamp(
	book: LibraryBook,
	readingProgress?: ReadingProgressState,
) {
	const progressTimestamp =
		Date.parse(readingProgress?.byBookId[book.id]?.updatedAt ?? "") || 0;
	const importTimestamp =
		book.source === "imported"
			? Date.parse(book.updatedAt || book.importedAt) || 0
			: 0;

	return Math.max(progressTimestamp, importTimestamp);
}

export function orderLibraryBooks(
	books: LibraryBook[],
	readingProgress?: ReadingProgressState,
) {
	return [...books].sort((a, b) => {
		const aTimestamp = getBookSortTimestamp(a, readingProgress);
		const bTimestamp = getBookSortTimestamp(b, readingProgress);

		if (aTimestamp !== bTimestamp) {
			return bTimestamp - aTimestamp;
		}

		if (a.source !== b.source) {
			return a.source === "imported" ? -1 : 1;
		}

		if (a.source === "imported" && b.source === "imported") {
			return getBookSortTimestamp(b) - getBookSortTimestamp(a);
		}

		return (
			books.findIndex((book) => book.id === a.id) -
			books.findIndex((book) => book.id === b.id)
		);
	});
}

export async function getAllLibraryBooks() {
	const libraryState = await getLibraryStorageState();

	return [...bundledBooks, ...libraryState.importedBooks];
}

export async function getLibraryBookById(bookId: string | undefined) {
	const books = await getAllLibraryBooks();

	return books.find((book) => book.id === bookId) ?? null;
}
