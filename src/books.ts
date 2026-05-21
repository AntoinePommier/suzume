export type BookId = "shika-no-ou-1" | "le-petit-prince";

export type Book = {
	id: BookId;
	title: string;
	subtitle: string;
	asset: number;
};

export const books: Book[] = [
	{
		id: "shika-no-ou-1",
		title: "鹿の王 1",
		subtitle: "Nahoko Uehashi",
		asset: require("../assets/books/shika-no-ou-1.epub"),
	},
	{
		id: "le-petit-prince",
		title: "Le Petit Prince",
		subtitle: "Antoine de Saint-Exupéry",
		asset: require("../assets/books/le-petit-prince.epub"),
	},
];

export function getBookById(bookId: string | string[] | undefined) {
	const normalizedBookId = Array.isArray(bookId) ? bookId[0] : bookId;

	return books.find((book) => book.id === normalizedBookId) ?? books[0];
}
