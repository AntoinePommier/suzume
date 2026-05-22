import { getBundledJitendexDatabase } from "./dictionaryDatabase";
import type { DictionaryLookupEntry, DictionaryLookupResult } from "./types";

const maxLookupLength = 20;
const maxEntries = 6;

function normalizeLookupSource(text: string) {
	return Array.from(text.replace(/\s+/g, "")).slice(0, maxLookupLength);
}

function collectText(value: unknown, parts: string[]) {
	if (typeof value === "string") {
		parts.push(value);
		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			collectText(item, parts);
		}
		return;
	}

	if (value && typeof value === "object") {
		const record = value as { data?: { content?: string }; content?: unknown };

		if (record.data?.content === "attribution") {
			return;
		}

		collectText(record.content, parts);
	}
}

function parseGlossary(glossaryJson: string) {
	try {
		const glossary = JSON.parse(glossaryJson) as unknown;
		const items = Array.isArray(glossary) ? glossary : [glossary];

		return items
			.map((item) => {
				const parts: string[] = [];
				collectText(item, parts);

				return parts.join(" ").replace(/\s+/g, " ").trim();
			})
			.filter(Boolean)
			.slice(0, 4);
	} catch {
		return [];
	}
}

async function queryExactTerm(
	expression: string,
): Promise<DictionaryLookupEntry[]> {
	const db = await getBundledJitendexDatabase();

	if (!db) {
		return [];
	}

	const rows = await db.getAllAsync<{
		expression: string;
		reading: string | null;
		glossary_json: string;
		score: number | null;
		sequence: number | null;
	}>(
		`SELECT expression, reading, glossary_json, score, sequence
		 FROM dictionary_terms
		 WHERE expression = ?
		 ORDER BY score DESC
		 LIMIT ?`,
		expression,
		maxEntries,
	);

	return rows.map((row) => ({
		expression: row.expression,
		reading: row.reading ?? "",
		glossary: parseGlossary(row.glossary_json),
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
		const entries = await queryExactTerm(candidate);

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
