import { getBundledJitendexDatabase } from "./dictionaryDatabase";
import { deinflectJapaneseTerm, type JapaneseDeinflection } from "./japaneseDeinflector";
import type { DictionaryLookupEntry, DictionaryLookupResult } from "./types";

const maxLookupLength = 20;
const maxEntries = 6;
const maxLookupCandidates = 400;
const maxBulkRows = 1000;
type BundledDictionaryDatabase = NonNullable<
	Awaited<ReturnType<typeof getBundledJitendexDatabase>>
>;

function normalizeLookupSource(text: string) {
	return Array.from(text.replace(/\s+/g, "")).slice(0, maxLookupLength);
}

type LookupCandidate = JapaneseDeinflection & {
	order: number;
};

type DictionaryTermRow = {
	id: number;
	expression: string;
	reading: string | null;
	score: number | null;
	sequence: number | null;
};

function createLookupCandidates(after: string) {
	const characters = normalizeLookupSource(after);
	const candidates: LookupCandidate[] = [];
	const seen = new Set<string>();
	let order = 0;

	for (let length = characters.length; length > 0; length -= 1) {
		const surfaceForm = characters.slice(0, length).join("");

		for (const deinflection of deinflectJapaneseTerm(surfaceForm)) {
			const key = deinflection.dictionaryForm;

			if (seen.has(key)) {
				continue;
			}

			seen.add(key);
			candidates.push({ ...deinflection, order });
			order += 1;

			if (candidates.length >= maxLookupCandidates) {
				return candidates;
			}
		}
	}

	return candidates;
}

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
	rows: DictionaryTermRow[],
	glossesByTermId: Map<number, string[]>,
	candidatesByTerm: Map<string, LookupCandidate>,
): DictionaryLookupEntry[] {
	return rows.map((row) => ({
		expression: row.expression,
		reading: row.reading ?? "",
		glossary: glossesByTermId.get(row.id) ?? [],
		score: row.score ?? 0,
		sequence: row.sequence,
		surfaceForm:
			candidatesByTerm.get(row.expression)?.surfaceForm ??
			candidatesByTerm.get(row.reading ?? "")?.surfaceForm ??
			row.expression,
		dictionaryForm:
			candidatesByTerm.get(row.expression)?.dictionaryForm ??
			candidatesByTerm.get(row.reading ?? "")?.dictionaryForm ??
			row.expression,
		deinflectionReasons:
			candidatesByTerm.get(row.expression)?.reasons ??
			candidatesByTerm.get(row.reading ?? "")?.reasons ??
			[],
		deinflectionRules:
			candidatesByTerm.get(row.expression)?.rules ??
			candidatesByTerm.get(row.reading ?? "")?.rules ??
			[],
	}));
}

async function queryCandidates(
	db: BundledDictionaryDatabase,
	candidates: LookupCandidate[],
): Promise<DictionaryLookupEntry[]> {
	if (candidates.length === 0) {
		return [];
	}

	const terms = candidates.map((candidate) => candidate.dictionaryForm);
	const placeholders = terms.map(() => "?").join(", ");
	const rows = await db.getAllAsync<DictionaryTermRow>(
		`SELECT id, expression, reading, score, sequence
		 FROM dictionary_terms
		 WHERE expression IN (${placeholders})
		    OR reading IN (${placeholders})
		 LIMIT ?`,
		...terms,
		...terms,
		maxBulkRows,
	);

	if (rows.length === 0) {
		return [];
	}

	const candidatesByTerm = new Map<string, LookupCandidate>();
	const orderByTerm = new Map<string, number>();

	for (const candidate of candidates) {
		candidatesByTerm.set(candidate.dictionaryForm, candidate);
		orderByTerm.set(candidate.dictionaryForm, candidate.order);
	}

	const matchingRows = rows
		.map((row) => {
			const expressionOrder = orderByTerm.get(row.expression);
			const readingOrder = orderByTerm.get(row.reading ?? "");
			const order =
				expressionOrder !== undefined && readingOrder !== undefined
					? Math.min(expressionOrder, readingOrder)
					: (expressionOrder ?? readingOrder);

			return order === undefined ? null : { row, order };
		})
		.filter((item): item is { row: DictionaryTermRow; order: number } =>
			Boolean(item),
		);

	if (matchingRows.length === 0) {
		return [];
	}

	const bestOrder = Math.min(...matchingRows.map((item) => item.order));
	const bestRows = matchingRows
		.filter((item) => item.order === bestOrder)
		.sort((a, b) => (b.row.score ?? 0) - (a.row.score ?? 0))
		.slice(0, maxEntries)
		.map((item) => item.row);
	const glossesByTermId = await loadGlossesForTerms(db, bestRows);

	return toLookupEntries(bestRows, glossesByTermId, candidatesByTerm);
}

async function queryExactPrefixFallback(
	db: BundledDictionaryDatabase,
	after: string,
) {
	const characters = normalizeLookupSource(after);

	for (let length = characters.length; length > 0; length -= 1) {
		const candidate = characters.slice(0, length).join("");
		const rows = await db.getAllAsync<DictionaryTermRow>(
			`SELECT id, expression, reading, score, sequence
			 FROM dictionary_terms
			 WHERE expression = ?
			 ORDER BY score DESC
			 LIMIT ?`,
			candidate,
			maxEntries,
		);

		if (rows.length === 0) {
			continue;
		}

		const lookupCandidate: LookupCandidate = {
			order: 0,
			surfaceForm: candidate,
			dictionaryForm: candidate,
			reasons: [],
			rules: [],
		};
		const glossesByTermId = await loadGlossesForTerms(db, rows);
		const candidatesByTerm = new Map([[candidate, lookupCandidate]]);

		return toLookupEntries(rows, glossesByTermId, candidatesByTerm);
	}

	return [];
}

export async function lookupJapaneseTermFromSqlite(
	after: string,
): Promise<DictionaryLookupResult> {
	const db = await getBundledJitendexDatabase();

	if (!db) {
		return {
			status: "not-installed",
			matchedText: "",
			entries: [],
		};
	}

	const entries = await queryCandidates(db, createLookupCandidates(after));
	const fallbackEntries =
		entries.length > 0 ? entries : await queryExactPrefixFallback(db, after);

	if (fallbackEntries.length > 0) {
		return {
			status: "ready",
			matchedText: fallbackEntries[0].surfaceForm ?? fallbackEntries[0].expression,
			entries: fallbackEntries,
		};
	}

	return {
		status: "ready",
		matchedText: "",
		entries: [],
	};
}
