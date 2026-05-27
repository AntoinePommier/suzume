import { getBundledJitendexDatabase } from "./dictionaryDatabase";
import {
	createDictionaryMatches,
	createLookupCandidates,
	createRankedDictionaryMatchGroups,
	normalizeLookupSource,
	type DictionaryLookupCandidate,
	type RankedDictionaryMatchGroup,
} from "./lookup/rankDictionaryMatches";
import type { DictionaryLookupEntry, DictionaryLookupResult } from "./types";

const maxLookupLength = 20;
const maxEntries = 30;
const maxLookupCandidates = 400;
const maxBulkRows = 1000;
type BundledDictionaryDatabase = NonNullable<
	Awaited<ReturnType<typeof getBundledJitendexDatabase>>
>;

type DictionaryTermRow = {
	id: number;
	expression: string;
	reading: string | null;
	definition_tags: string | null;
	rules: string | null;
	score: number | null;
	sequence: number | null;
	term_tags: string | null;
	term_bank_order: number | null;
	dictionary_id: number | null;
	tag_score: number | null;
	gloss_count: number | null;
	jpdb_frequency_score: number | null;
};

async function loadGlossesForTerms(
	db: BundledDictionaryDatabase,
	rows: DictionaryTermRow[],
) {
	if (rows.length === 0) {
		return new Map<number, string[]>();
	}

	const termIds = rows.map((row) => row.id);
	const placeholders = termIds.map(() => "?").join(", ");
	const glossRows = await db.getAllAsync<{
		term_id: number;
		glossary_text: string;
	}>(
		`SELECT term_id, glossary_text
		 FROM dictionary_glosses
		 WHERE term_id IN (${placeholders})
		 ORDER BY term_id, glossary_index`,
		...termIds,
	);
	const glossesByTermId = new Map<number, string[]>();

	for (const row of glossRows) {
		const glosses = glossesByTermId.get(row.term_id) ?? [];
		glosses.push(row.glossary_text);
		glossesByTermId.set(row.term_id, glosses);
	}

	return glossesByTermId;
}

function toLookupEntries(
	groups: RankedDictionaryMatchGroup[],
	glossesByTermId: Map<number, string[]>,
): DictionaryLookupEntry[] {
	return groups.map((group) => {
		const row = group.representative.row as DictionaryTermRow;
		const { candidate } = group.representative;

		return {
			expression: row.expression,
			reading: row.reading ?? "",
			glossary: glossesByTermId.get(row.id) ?? [],
			score: row.score ?? 0,
			sequence: row.sequence,
			surfaceForm: candidate.surfaceForm,
			dictionaryForm: candidate.dictionaryForm,
			deinflectionReasons: candidate.reasons,
			deinflectionRules: candidate.rules,
		};
	});
}

async function queryCandidates(
	db: BundledDictionaryDatabase,
	candidates: DictionaryLookupCandidate[],
	after: string,
): Promise<DictionaryLookupEntry[]> {
	if (candidates.length === 0) {
		return [];
	}

	const terms = candidates.map((candidate) => candidate.dictionaryForm);
	const placeholders = terms.map(() => "?").join(", ");
	const rows = await db.getAllAsync<DictionaryTermRow>(
		`SELECT
			terms.id,
			terms.expression,
			terms.reading,
			terms.definition_tags,
			terms.rules,
			terms.score,
			terms.sequence,
			terms.term_tags,
			terms.term_bank_order,
			terms.dictionary_id,
			COALESCE(MAX(tags.score), 0) AS tag_score,
			(
				SELECT COUNT(*)
				FROM dictionary_glosses AS glosses
				WHERE glosses.term_id = terms.id
			) AS gloss_count,
			(
				SELECT MIN(meta.frequency_score)
				FROM dictionary_term_meta AS meta
				WHERE meta.mode = 'freq'
				  AND meta.expression = terms.expression
				  AND (meta.reading = terms.reading OR meta.reading IS NULL)
			) AS jpdb_frequency_score
		 FROM dictionary_terms AS terms
		 LEFT JOIN dictionary_tags AS tags
		   ON tags.dictionary_name = terms.dictionary_name
		 	AND instr(
				' ' || COALESCE(terms.term_tags, '') || ' ' || COALESCE(terms.definition_tags, '') || ' ',
				' ' || tags.name || ' '
			) > 0
		 WHERE terms.expression IN (${placeholders})
		    OR terms.reading IN (${placeholders})
		 GROUP BY terms.id
		 LIMIT ?`,
		...terms,
		...terms,
		maxBulkRows,
	);

	if (rows.length === 0) {
		return [];
	}

	const matches = createDictionaryMatches(rows, candidates);
	const bestGroups = createRankedDictionaryMatchGroups(matches, after, {
		maxLookupLength,
	}).slice(0, maxEntries);

	if (bestGroups.length === 0) {
		return [];
	}

	const bestRows = bestGroups.map(
		(group) => group.representative.row as DictionaryTermRow,
	);
	const glossesByTermId = await loadGlossesForTerms(db, bestRows);

	return toLookupEntries(bestGroups, glossesByTermId);
}

async function queryExactPrefixFallback(
	db: BundledDictionaryDatabase,
	after: string,
) {
	const characters = normalizeLookupSource(after);

	for (let length = characters.length; length > 0; length -= 1) {
		const candidate = characters.slice(0, length).join("");
		const rows = await db.getAllAsync<DictionaryTermRow>(
			`SELECT
				terms.id,
				terms.expression,
				terms.reading,
				terms.definition_tags,
				terms.rules,
				terms.score,
				terms.sequence,
				terms.term_tags,
				terms.term_bank_order,
				terms.dictionary_id,
				COALESCE(MAX(tags.score), 0) AS tag_score,
				(
					SELECT COUNT(*)
					FROM dictionary_glosses AS glosses
					WHERE glosses.term_id = terms.id
				) AS gloss_count,
				(
					SELECT MIN(meta.frequency_score)
					FROM dictionary_term_meta AS meta
					WHERE meta.mode = 'freq'
					  AND meta.expression = terms.expression
					  AND (meta.reading = terms.reading OR meta.reading IS NULL)
				) AS jpdb_frequency_score
			 FROM dictionary_terms AS terms
			 LEFT JOIN dictionary_tags AS tags
			   ON tags.dictionary_name = terms.dictionary_name
			  AND instr(
				' ' || COALESCE(terms.term_tags, '') || ' ' || COALESCE(terms.definition_tags, '') || ' ',
				' ' || tags.name || ' '
			) > 0
			 WHERE terms.expression = ?
			 GROUP BY terms.id
			 ORDER BY terms.score DESC
			 LIMIT ?`,
			candidate,
			maxEntries,
		);

		if (rows.length === 0) {
			continue;
		}

		const lookupCandidate: DictionaryLookupCandidate = {
			candidateOrder: 0,
			inflectionChainLength: 0,
			surfaceForm: candidate,
			dictionaryForm: candidate,
			reasons: [],
			rules: [],
		};
		const glossesByTermId = await loadGlossesForTerms(db, rows);
		const groups = rows.map((row) => ({
			groupKey: `term:${row.expression}\u0000${row.reading ?? ""}`,
			groupMatches: [
				{
					row,
					candidate: lookupCandidate,
					matchSource: "expression" as const,
				},
			],
			representative: {
				row,
				candidate: lookupCandidate,
				matchSource: "expression" as const,
			},
			rank: {
				matchSourceStrength: 5,
				maxSurfaceLength: Array.from(candidate).length,
				exactExpressionMatchCount: 1,
				exactReadingMatchCount: 0,
				deinflectionChainLength: 0,
				ruleConfidence: 3,
				sourceClass: "exact-expression-full-source" as const,
				sourceClassRank: 0,
				bestScore: row.score ?? 0,
				bestTagScore: row.tag_score ?? 0,
				bestFrequencyScore: row.jpdb_frequency_score ?? null,
				bestGlossCount: row.gloss_count ?? 0,
				termBankOrder: row.term_bank_order ?? 0,
				dictionaryId: row.dictionary_id ?? 0,
				isSingleCharacter: Array.from(row.expression).length === 1,
				isKanjiOnly: false,
				candidateOrder: 0,
			},
		}));

		return toLookupEntries(groups, glossesByTermId);
	}

	return [];
}

export async function lookupJapaneseTermFromSqlite(
	after: string,
): Promise<DictionaryLookupResult> {
	const db = await getBundledJitendexDatabase();

	if (!db) {
		return {
			status: "notInstalled",
			matchedText: "",
			entries: [],
		};
	}

	const entries = await queryCandidates(
		db,
		createLookupCandidates(after, { maxLookupLength, maxLookupCandidates }),
		after,
	);
	const fallbackEntries =
		entries.length > 0 ? entries : await queryExactPrefixFallback(db, after);

	if (fallbackEntries.length > 0) {
		return {
			status: "results",
			matchedText: fallbackEntries[0].surfaceForm ?? fallbackEntries[0].expression,
			entries: fallbackEntries,
		};
	}

	return {
		status: "noResults",
		matchedText: "",
		entries: [],
	};
}
