export type BundledBook = {
	asset: number;
	id: string;
	source: "bundled";
	subtitle: string;
	title: string;
};

export type ImportedBook = {
	fileUri: string;
	fingerprint: string;
	id: string;
	importedAt: string;
	originalFilename?: string;
	source: "imported";
	subtitle: string;
	title: string;
	updatedAt: string;
};

export type LibraryBook = BundledBook | ImportedBook;

export type LibraryStorageState = {
	importedBooks: ImportedBook[];
};
