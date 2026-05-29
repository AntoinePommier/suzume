import * as DocumentPicker from "expo-document-picker";
import * as ExpoFileSystem from "expo-file-system/legacy";
import { getCachedOrExtractedEpubCoverUri } from "@/features/reader/utils/epubCoverCache";
import { extractEpubMetadata } from "@/features/reader/utils/extractEpubMetadata";
import { getLibraryStorageState, upsertImportedBook } from "./libraryStorage";
import type { ImportedBook } from "./types";

const importedBooksDirectory = `${ExpoFileSystem.documentDirectory}suzume-library/books/`;
const epubMimeTypes = new Set([
	"application/epub+zip",
	"application/octet-stream",
	"application/x-epub",
	"application/zip",
]);
const epubPickerTypes = ["application/epub+zip", "org.idpf.epub-container"];

export type ImportEpubResult =
	| {
			book: ImportedBook;
			status: "duplicate" | "imported";
	  }
	| {
			status: "cancelled";
	  }
	| {
			error: string;
			status: "error";
	  };

function sanitizeFilename(value: string) {
	return value
		.replace(/\.[eE][pP][uU][bB]$/, "")
		.replace(/[^a-zA-Z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

function getFallbackTitle(filename: string) {
	return filename.replace(/\.[eE][pP][uU][bB]$/, "").trim() || "Untitled EPUB";
}

function getSafeFingerprint(value: string) {
	return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function hasEpubExtension(filename: string) {
	return filename.toLowerCase().endsWith(".epub");
}

function isLikelyEpubFile(filename: string, mimeType?: string | null) {
	return (
		hasEpubExtension(filename) || (!!mimeType && epubMimeTypes.has(mimeType))
	);
}

async function ensureImportedBooksDirectory() {
	await ExpoFileSystem.makeDirectoryAsync(importedBooksDirectory, {
		intermediates: true,
	});
}

async function getPickedFileInfo(uri: string) {
	return ExpoFileSystem.getInfoAsync(uri, { md5: true } as {
		md5: true;
	});
}

async function copyImportedEpub({
	bookId,
	sourceUri,
}: {
	bookId: string;
	sourceUri: string;
}) {
	await ensureImportedBooksDirectory();

	const destinationUri = `${importedBooksDirectory}${bookId}.epub`;

	await ExpoFileSystem.copyAsync({
		from: sourceUri,
		to: destinationUri,
	});

	return destinationUri;
}

export async function importEpub(): Promise<ImportEpubResult> {
	try {
		const pickerResult = await DocumentPicker.getDocumentAsync({
			copyToCacheDirectory: true,
			multiple: false,
			type: epubPickerTypes,
		});

		if (pickerResult.canceled) {
			return { status: "cancelled" };
		}

		const pickedFile = pickerResult.assets[0];

		if (!pickedFile?.uri) {
			return { error: "No EPUB file selected", status: "error" };
		}

		if (!isLikelyEpubFile(pickedFile.name, pickedFile.mimeType)) {
			return { error: "Selected file is not an EPUB", status: "error" };
		}

		const pickedFileInfo = await getPickedFileInfo(pickedFile.uri);

		if (!pickedFileInfo.exists || pickedFileInfo.isDirectory) {
			return { error: "Selected EPUB could not be read", status: "error" };
		}

		const pickedFileMd5 =
			"md5" in pickedFileInfo && typeof pickedFileInfo.md5 === "string"
				? pickedFileInfo.md5
				: null;
		const pickedFileSize =
			"size" in pickedFileInfo && typeof pickedFileInfo.size === "number"
				? pickedFileInfo.size
				: pickedFile.size;
		const fallbackFingerprint = `${sanitizeFilename(pickedFile.name)}-${pickedFileSize ?? "unknown"}`;
		const fingerprint = pickedFileMd5
			? `${pickedFileMd5}-${pickedFileSize ?? "unknown"}`
			: fallbackFingerprint;
		const bookId = `imported-${getSafeFingerprint(fingerprint)}`;
		const currentLibrary = await getLibraryStorageState();
		const existingBook = currentLibrary.importedBooks.find(
			(book) => book.id === bookId || book.fingerprint === fingerprint,
		);

		if (existingBook) {
			const existingBookInfo = await ExpoFileSystem.getInfoAsync(
				existingBook.fileUri,
			);

			if (existingBookInfo.exists && !existingBookInfo.isDirectory) {
				const updatedExistingBook = {
					...existingBook,
					updatedAt: new Date().toISOString(),
				};

				await upsertImportedBook(updatedExistingBook);

				return { book: updatedExistingBook, status: "duplicate" };
			}
		}

		const bookBase64 = await ExpoFileSystem.readAsStringAsync(pickedFile.uri, {
			encoding: "base64",
		});
		const extractedMetadata = await extractEpubMetadata(bookBase64).catch(
			() => null,
		);

		if (!extractedMetadata) {
			return { error: "Selected file is not a valid EPUB", status: "error" };
		}

		const fileUri = await copyImportedEpub({
			bookId,
			sourceUri: pickedFile.uri,
		});
		const importedAt = new Date().toISOString();
		const importedBook: ImportedBook = {
			fileUri,
			fingerprint,
			id: bookId,
			importedAt,
			originalFilename: pickedFile.name,
			source: "imported",
			subtitle: extractedMetadata.creator ?? "Unknown author",
			title: extractedMetadata.title ?? getFallbackTitle(pickedFile.name),
			updatedAt: importedAt,
		};

		await upsertImportedBook(importedBook);
		getCachedOrExtractedEpubCoverUri({
			assetFingerprint: fingerprint,
			bookBase64,
			bookId,
		}).catch(() => undefined);

		return { book: importedBook, status: "imported" };
	} catch {
		return { error: "Unable to import EPUB", status: "error" };
	}
}
