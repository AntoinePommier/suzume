export type DictionaryTapMessage = {
	type: "dictionary-tap";
	payload: {
		character: string;
		before: string;
		after: string;
		context: string;
	};
};

export type DictionarySelection = DictionaryTapMessage["payload"];

export type DictionaryCloseMessage = {
	type: "dictionary-close";
};

export type ReaderBackgroundTapMessage = {
	type: "reader-background-tap";
};

export type DictionaryBridgeMessage =
	| DictionaryTapMessage
	| DictionaryCloseMessage
	| ReaderBackgroundTapMessage;

export type YomitanDictionaryIndex = {
	title?: string;
	author?: string;
	revision?: string;
	format?: number;
	url?: string;
	sourceLanguage?: string;
	targetLanguage?: string;
	description?: string;
	attribution?: string;
};

export type YomitanTermBankEntry = [
	expression: string,
	reading: string,
	definitionTags: string,
	rules: string,
	score: number,
	glossary: unknown[],
	sequence?: number,
	termTags?: string,
];

export type DictionaryImportProgress = {
	phase: "checking" | "loading-zip" | "parsing-index" | "importing-terms" | "complete";
	dictionaryTitle?: string;
	banksImported?: number;
	totalBanks?: number;
	termsImported?: number;
};

export type DictionaryImportResult = {
	dictionaryId: number;
	title: string;
	revision: string | null;
	termsImported: number;
	skipped: boolean;
};

export type DictionaryLookupEntry = {
	expression: string;
	reading: string;
	glossary: string[];
	score: number;
	sequence: number | null;
	surfaceForm?: string;
	dictionaryForm?: string;
	deinflectionReasons?: string[];
	deinflectionRules?: string[];
};

export type DictionaryLookupResult = {
	status:
		| "idle"
		| "loading"
		| "results"
		| "noResults"
		| "notInstalled"
		| "error";
	matchedText: string;
	entries: DictionaryLookupEntry[];
	error?: string;
};
