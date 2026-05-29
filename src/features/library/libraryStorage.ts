import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ImportedBook, LibraryStorageState } from "./types";

const libraryStorageKey = "suzume:library";
const emptyLibraryStorageState: LibraryStorageState = {
	importedBooks: [],
};

function isImportedBook(value: unknown): value is ImportedBook {
	if (!value || typeof value !== "object") {
		return false;
	}

	const book = value as Partial<ImportedBook>;

	return (
		book.source === "imported" &&
		typeof book.id === "string" &&
		typeof book.title === "string" &&
		typeof book.subtitle === "string" &&
		typeof book.fileUri === "string" &&
		typeof book.fingerprint === "string" &&
		typeof book.importedAt === "string" &&
		typeof book.updatedAt === "string"
	);
}

export async function getLibraryStorageState(): Promise<LibraryStorageState> {
	try {
		const libraryJson = await AsyncStorage.getItem(libraryStorageKey);

		if (!libraryJson) {
			return emptyLibraryStorageState;
		}

		const parsedLibrary = JSON.parse(
			libraryJson,
		) as Partial<LibraryStorageState>;

		return {
			importedBooks: Array.isArray(parsedLibrary.importedBooks)
				? parsedLibrary.importedBooks.filter(isImportedBook)
				: [],
		};
	} catch {
		return emptyLibraryStorageState;
	}
}

export async function writeLibraryStorageState(
	libraryState: LibraryStorageState,
) {
	await AsyncStorage.setItem(libraryStorageKey, JSON.stringify(libraryState));
}

export async function upsertImportedBook(importedBook: ImportedBook) {
	const currentLibrary = await getLibraryStorageState();
	const existingIndex = currentLibrary.importedBooks.findIndex(
		(book) => book.id === importedBook.id,
	);
	const importedBooks =
		existingIndex >= 0
			? currentLibrary.importedBooks.map((book, index) =>
					index === existingIndex ? importedBook : book,
				)
			: [importedBook, ...currentLibrary.importedBooks];

	await writeLibraryStorageState({ importedBooks });

	return importedBook;
}

export async function removeImportedBookFromStorage(bookId: string) {
	const currentLibrary = await getLibraryStorageState();
	const importedBook = currentLibrary.importedBooks.find(
		(book) => book.id === bookId,
	);

	if (!importedBook) {
		return null;
	}

	await writeLibraryStorageState({
		importedBooks: currentLibrary.importedBooks.filter(
			(book) => book.id !== bookId,
		),
	});

	return importedBook;
}
