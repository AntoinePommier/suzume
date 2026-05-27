import type { JapaneseDeinflection } from "../japaneseDeinflector";

export type DictionaryMatchSource = "expression" | "reading";

export type DictionaryTermRowForRanking = {
	id?: number;
	expression: string;
	reading: string | null;
	definition_tags?: string | null;
	rules?: string | null;
	score: number | null;
	sequence: number | null;
	term_tags?: string | null;
	term_bank_order?: number | null;
	dictionary_id?: number | null;
	tag_score?: number | null;
	gloss_count?: number | null;
	jpdb_frequency_score?: number | null;
};

export type DictionaryLookupCandidate = JapaneseDeinflection & {
	candidateOrder: number;
	inflectionChainLength: number;
};

export type DictionaryMatchForRanking = {
	row: DictionaryTermRowForRanking;
	candidate: DictionaryLookupCandidate;
	matchSource: DictionaryMatchSource;
};

export type DictionarySourceClass =
	| "exact-expression-full-source"
	| "exact-reading-full-source"
	| "strong-deinflection-full-source-expression"
	| "exact-expression-prefix"
	| "deinflection-prefix-expression"
	| "weak-deinflection-full-source-expression"
	| "strong-deinflection-full-source-reading"
	| "exact-reading-prefix"
	| "deinflection-prefix-reading"
	| "weak-deinflection-full-source-reading"
	| "single-character-fallback"
	| "kanji-only-fallback"
	| "reading-only-fallback"
	| "incompatible-deinflection"
	| "other";

export type DictionaryRankFields = {
	matchSourceStrength: number;
	maxSurfaceLength: number;
	exactExpressionMatchCount: number;
	exactReadingMatchCount: number;
	deinflectionChainLength: number;
	ruleConfidence: number;
	sourceClass: DictionarySourceClass;
	sourceClassRank: number;
	bestScore: number;
	bestTagScore: number;
	bestFrequencyScore: number | null;
	bestGlossCount: number;
	termBankOrder: number;
	dictionaryId: number;
	isSingleCharacter: boolean;
	isKanjiOnly: boolean;
	candidateOrder: number;
};

export type RankedDictionaryMatchGroup = {
	groupKey: string;
	groupMatches: DictionaryMatchForRanking[];
	representative: DictionaryMatchForRanking;
	rank: DictionaryRankFields;
};
