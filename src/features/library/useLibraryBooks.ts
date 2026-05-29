import { useCallback, useEffect, useMemo, useState } from "react";
import { bundledBooks } from "@/books";
import {
	getReadingProgressState,
	type ReadingProgressState,
} from "@/features/reader/readingProgressStorage";
import { deleteImportedBook } from "./deleteImportedBook";
import { importEpub } from "./importEpub";
import { orderLibraryBooks } from "./libraryBooks";
import { getLibraryStorageState } from "./libraryStorage";
import type { ImportedBook } from "./types";

export function useLibraryBooks() {
	const [importedBooks, setImportedBooks] = useState<ImportedBook[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [isImporting, setIsImporting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [readingProgress, setReadingProgress] =
		useState<ReadingProgressState | null>(null);
	const allBooks = useMemo(
		() => [...bundledBooks, ...importedBooks],
		[importedBooks],
	);
	const orderedBooks = useMemo(
		() => orderLibraryBooks(allBooks, readingProgress ?? undefined),
		[allBooks, readingProgress],
	);

	const reload = useCallback(async () => {
		setIsLoading(true);

		try {
			const [libraryState, progressState] = await Promise.all([
				getLibraryStorageState(),
				getReadingProgressState(),
			]);

			setImportedBooks(libraryState.importedBooks);
			setReadingProgress(progressState);
			setError(null);
		} catch {
			setImportedBooks([]);
			setReadingProgress(null);
			setError("Unable to load library");
		} finally {
			setIsLoading(false);
		}
	}, []);

	const importBook = useCallback(async () => {
		setIsImporting(true);

		try {
			const result = await importEpub();

			if (result.status === "imported" || result.status === "duplicate") {
				await reload();
			}

			if (result.status === "error") {
				setError(result.error);
			} else {
				setError(null);
			}

			return result;
		} finally {
			setIsImporting(false);
		}
	}, [reload]);

	const deleteBook = useCallback(
		async (bookId: string) => {
			const result = await deleteImportedBook(bookId);

			if (result.status === "deleted") {
				await reload();
				setError(null);
			} else {
				setError(result.error);
			}

			return result;
		},
		[reload],
	);

	useEffect(() => {
		reload();
	}, [reload]);

	return {
		books: orderedBooks,
		deleteBook,
		error,
		importBook,
		isImporting,
		isLoading,
		reload,
	};
}
