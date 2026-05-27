import { textLength } from "./createLookupCandidates";
import type {
	DictionaryLookupCandidate,
	DictionaryMatchForRanking,
	DictionarySourceClass,
	DictionaryTermRowForRanking,
} from "./types";

export const sourceClassRanks: Record<DictionarySourceClass, number> = {
	"exact-expression-full-source": 0,
	"exact-reading-full-source": 1,
	"strong-deinflection-full-source-expression": 2,
	"exact-expression-prefix": 3,
	"deinflection-prefix-expression": 4,
	"weak-deinflection-full-source-expression": 5,
	"strong-deinflection-full-source-reading": 6,
	"exact-reading-prefix": 7,
	"deinflection-prefix-reading": 8,
	"weak-deinflection-full-source-reading": 9,
	"single-character-fallback": 10,
	"kanji-only-fallback": 11,
	"reading-only-fallback": 12,
	"incompatible-deinflection": 13,
	other: 14,
};

export function isSingleKanjiExpression(text: string) {
	return textLength(text) === 1 && /^[\u3400-\u9fff]$/.test(text);
}

export function isSingleCharacterExpression(text: string) {
	return textLength(text) === 1;
}

export function splitDictionaryTags(value: string | null | undefined) {
	return String(value ?? "")
		.split(/\s+/)
		.map((tag) => tag.trim())
		.filter(Boolean);
}

function normalizedTagText(value: string | null | undefined) {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

export function getDictionaryPriorityScore(row: DictionaryTermRowForRanking) {
	const tagText = [
		normalizedTagText(row.definition_tags),
		normalizedTagText(row.term_tags),
	]
		.filter(Boolean)
		.join(" ");

	if (tagText.includes("priority form")) {
		return 4;
	}

	if (tagText.includes("★")) {
		return 3;
	}

	if (
		tagText.includes("rarely used form") ||
		tagText.includes("old kanji form") ||
		tagText.includes("obsolete reading") ||
		tagText.includes("irregular form")
	) {
		return -1;
	}

	return row.tag_score ?? 0;
}

function dictionaryRuleSet(match: DictionaryMatchForRanking) {
	return new Set(splitDictionaryTags(match.row.rules));
}

export function isRuleCompatible(match: DictionaryMatchForRanking) {
	if (match.candidate.inflectionChainLength === 0) {
		return true;
	}

	const dictionaryRules = dictionaryRuleSet(match);

	if (dictionaryRules.size === 0) {
		return false;
	}

	for (const rule of match.candidate.rules) {
		if (rule === "ichidan" || rule === "ichidan-classical-shi") {
			if (dictionaryRules.has("v1")) {
				return true;
			}
		}

		if (rule === "godan") {
			if (
				[...dictionaryRules].some((dictionaryRule) =>
					dictionaryRule.startsWith("v5"),
				)
			) {
				return true;
			}
		}

		if (rule === "suru") {
			if (
				dictionaryRules.has("vs") ||
				dictionaryRules.has("vs-i") ||
				dictionaryRules.has("vs-s")
			) {
				return true;
			}
		}

		if (rule === "kuru") {
			if (dictionaryRules.has("vk")) {
				return true;
			}
		}

		if (rule === "adjective") {
			if (dictionaryRules.has("adj-i") || dictionaryRules.has("ix")) {
				return true;
			}
		}
	}

	return false;
}

export function isFullSurfaceExactExpression(match: DictionaryMatchForRanking) {
	return (
		match.matchSource === "expression" &&
		match.candidate.inflectionChainLength === 0 &&
		match.row.expression === match.candidate.surfaceForm
	);
}

export function isFullSurfaceExactReading(match: DictionaryMatchForRanking) {
	return (
		match.matchSource === "reading" &&
		match.candidate.inflectionChainLength === 0 &&
		match.row.reading === match.candidate.surfaceForm
	);
}

export function isFullSurfaceDeinflection(match: DictionaryMatchForRanking) {
	return match.candidate.inflectionChainLength > 0;
}

export function getRuleConfidence(candidate: DictionaryLookupCandidate) {
	if (candidate.inflectionChainLength === 0) {
		return 3;
	}

	if (
		candidate.reasons.some((reason) =>
			[
				"polite",
				"polite-negative",
				"polite-past",
				"polite-past-negative",
				"polite-volitional",
				"negative",
				"past",
				"te",
				"tari",
				"adv",
			].includes(reason),
		)
	) {
		return 2;
	}

	if (
		candidate.reasons.some((reason) =>
			["classical-past", "masu-stem"].includes(reason),
		)
	) {
		return 1;
	}

	return 1;
}

function isStrongDeinflection(candidate: DictionaryLookupCandidate) {
	return (
		candidate.inflectionChainLength > 0 && getRuleConfidence(candidate) >= 2
	);
}

function isWeakDeinflection(candidate: DictionaryLookupCandidate) {
	return (
		candidate.inflectionChainLength > 0 && getRuleConfidence(candidate) < 2
	);
}

export function classifyMatchSource(
	match: DictionaryMatchForRanking,
	fullSourceLength: number,
): DictionarySourceClass {
	const surfaceLength = textLength(match.candidate.surfaceForm);
	const isFullSource = surfaceLength === fullSourceLength;
	const isSingleCharacter = isSingleCharacterExpression(match.row.expression);
	const isKanjiOnly =
		(match.row.score !== null && match.row.score < 0) ||
		isSingleKanjiExpression(match.row.expression);
	const isExactFullSurfaceExpression =
		match.candidate.inflectionChainLength === 0 &&
		match.matchSource === "expression" &&
		isFullSource;
	const isExactFullSurfaceReading =
		match.candidate.inflectionChainLength === 0 &&
		match.matchSource === "reading" &&
		isFullSource &&
		match.row.reading === match.candidate.surfaceForm;

	if (isSingleCharacter && !isFullSource) {
		return "single-character-fallback";
	}

	if (
		isKanjiOnly &&
		!isExactFullSurfaceExpression &&
		!isExactFullSurfaceReading
	) {
		return "kanji-only-fallback";
	}

	if (match.candidate.inflectionChainLength > 0 && !isRuleCompatible(match)) {
		return "incompatible-deinflection";
	}

	if (match.candidate.inflectionChainLength === 0) {
		if (match.matchSource === "expression") {
			return isFullSource
				? "exact-expression-full-source"
				: "exact-expression-prefix";
		}

		return isFullSource ? "exact-reading-full-source" : "exact-reading-prefix";
	}

	if (isStrongDeinflection(match.candidate)) {
		if (match.matchSource === "expression") {
			return isFullSource
				? "strong-deinflection-full-source-expression"
				: "deinflection-prefix-expression";
		}

		return isFullSource
			? "strong-deinflection-full-source-reading"
			: "deinflection-prefix-reading";
	}

	if (isWeakDeinflection(match.candidate)) {
		if (match.matchSource === "expression") {
			return isFullSource
				? "weak-deinflection-full-source-expression"
				: "deinflection-prefix-expression";
		}

		return isFullSource
			? "weak-deinflection-full-source-reading"
			: "deinflection-prefix-reading";
	}

	return match.matchSource === "reading" ? "reading-only-fallback" : "other";
}
