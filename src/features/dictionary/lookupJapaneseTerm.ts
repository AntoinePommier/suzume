import { getBundledJitendexDatabase } from "./dictionaryDatabase";
import type { DictionaryLookupEntry, DictionaryLookupResult } from "./types";

const maxLookupLength = 20;
const maxEntries = 6;
type BundledDictionaryDatabase = NonNullable<
	Awaited<ReturnType<typeof getBundledJitendexDatabase>>
>;

function normalizeLookupSource(text: string) {
	return Array.from(text.replace(/\s+/g, "")).slice(0, maxLookupLength);
}

async function queryExactTerm(
	db: BundledDictionaryDatabase,
	expression: string,
): Promise<DictionaryLookupEntry[]> {
	const rows = await db.getAllAsync<{
		id: number;
		expression: string;
		reading: string | null;
		score: number | null;
		sequence: number | null;
	}>(
		`SELECT id, expression, reading, score, sequence
		 FROM dictionary_terms
		 WHERE expression = ?
		 ORDER BY score DESC
		 LIMIT ?`,
		expression,
		maxEntries,
	);

	if (rows.length === 0) {
		return [];
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

	return rows.map((row) => ({
		expression: row.expression,
		reading: row.reading ?? "",
		glossary: glossesByTermId.get(row.id) ?? [],
		score: row.score ?? 0,
		sequence: row.sequence,
	}));
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

	const characters = normalizeLookupSource(after);

	for (let length = characters.length; length > 0; length -= 1) {
		const candidate = characters.slice(0, length).join("");
		const entries = await queryExactTerm(db, candidate);

		if (entries.length > 0) {
			return {
				status: "ready",
				matchedText: candidate,
				entries,
			};
		}
	}

	return {
		status: "ready",
		matchedText: "",
		entries: [],
	};
}
