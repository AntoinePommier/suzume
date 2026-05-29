import * as ExpoFileSystem from "expo-file-system/legacy";
import { bundledBooks } from "@/books";
import { deleteReadingProgress } from "@/features/reader/readingProgressStorage";
import { deleteCachedEpubCover } from "@/features/reader/utils/epubCoverCache";
import {
	getLibraryStorageState,
	removeImportedBookFromStorage,
} from "./libraryStorage";

export type DeleteImportedBookResult =
	| {
			status: "deleted";
	  }
	| {
			error: string;
			status: "error";
	  };

export async function deleteImportedBook(
	bookId: string,
): Promise<DeleteImportedBookResult> {
	try {
		const importedBook = await removeImportedBookFromStorage(bookId);

		if (!importedBook) {
			return { error: "Imported book not found", status: "error" };
		}

		const currentLibrary = await getLibraryStorageState();
		const remainingBookIds = [
			...bundledBooks.map((book) => book.id),
			...currentLibrary.importedBooks.map((book) => book.id),
		];

		await Promise.all([
			ExpoFileSystem.deleteAsync(importedBook.fileUri, {
				idempotent: true,
			}).catch(() => undefined),
			deleteCachedEpubCover(bookId),
			deleteReadingProgress(bookId, remainingBookIds),
		]);

		return { status: "deleted" };
	} catch {
		return { error: "Unable to delete imported book", status: "error" };
	}
}
