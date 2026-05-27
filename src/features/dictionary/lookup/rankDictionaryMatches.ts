import {
	deinflectJapaneseTerm,
	type JapaneseDeinflection,
} from "../japaneseDeinflector";

const defaultMaxLookupLength = 20;
const defaultMaxLookupCandidates = 400;

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

export function characters(text: string) {
	return Array.from(text);
}

export function textLength(text: string) {
	return characters(text).length;
}

export function normalizeLookupSource(
	text: string,
	maxLookupLength = defaultMaxLookupLength,
) {
	return characters(text.replace(/\s+/g, "")).slice(0, maxLookupLength);
}

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

function getDictionaryPriorityScore(row: DictionaryTermRowForRanking) {
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
			if ([...dictionaryRules].some((dictionaryRule) => dictionaryRule.startsWith("v5"))) {
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

export function createLookupPrefixes(
	after: string,
	maxLookupLength = defaultMaxLookupLength,
) {
	const sourceCharacters = normalizeLookupSource(after, maxLookupLength);
	const prefixes: string[] = [];

	for (let length = sourceCharacters.length; length > 0; length -= 1) {
		prefixes.push(sourceCharacters.slice(0, length).join(""));
	}

	return prefixes;
}

export function createLookupCandidates(
	after: string,
	options: {
		maxLookupLength?: number;
		maxLookupCandidates?: number;
	} = {},
) {
	const maxLookupCandidates =
		options.maxLookupCandidates ?? defaultMaxLookupCandidates;
	const prefixes = createLookupPrefixes(
		after,
		options.maxLookupLength ?? defaultMaxLookupLength,
	);
	const candidates: DictionaryLookupCandidate[] = [];
	const seen = new Set<string>();
	let candidateOrder = 0;

	for (const surfaceForm of prefixes) {
		for (const deinflection of deinflectJapaneseTerm(surfaceForm)) {
			const key = [
				deinflection.surfaceForm,
				deinflection.dictionaryForm,
				deinflection.reasons.join("\u0001"),
				deinflection.rules.join("\u0001"),
			].join("\u0000");

			if (seen.has(key)) {
				continue;
			}

			seen.add(key);
			candidates.push({
				...deinflection,
				candidateOrder,
				inflectionChainLength: deinflection.reasons.length,
			});
			candidateOrder += 1;

			if (candidates.length >= maxLookupCandidates) {
				return candidates;
			}
		}
	}

	return candidates;
}

export function createDictionaryMatches(
	rows: DictionaryTermRowForRanking[],
	candidates: DictionaryLookupCandidate[],
) {
	const candidatesByDictionaryForm = new Map<
		string,
		DictionaryLookupCandidate[]
	>();

	for (const candidate of candidates) {
		const existingCandidates =
			candidatesByDictionaryForm.get(candidate.dictionaryForm) ?? [];
		existingCandidates.push(candidate);
		candidatesByDictionaryForm.set(candidate.dictionaryForm, existingCandidates);
	}

	const matches: DictionaryMatchForRanking[] = [];

	for (const row of rows) {
		const expressionCandidates =
			candidatesByDictionaryForm.get(row.expression) ?? [];
		const readingCandidates = candidatesByDictionaryForm.get(row.reading ?? "") ?? [];

		for (const candidate of expressionCandidates) {
			matches.push({
				row,
				candidate,
				matchSource: "expression",
			});
		}

		for (const candidate of readingCandidates) {
			matches.push({
				row,
				candidate,
				matchSource: "reading",
			});
		}
	}

	return matches;
}

export function getGroupKey(match: DictionaryMatchForRanking) {
	if (match.row.sequence !== null && match.row.sequence !== undefined) {
		return `sequence:${match.row.sequence}`;
	}

	return `term:${match.row.expression}\u0000${match.row.reading ?? ""}`;
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
	return candidate.inflectionChainLength > 0 && getRuleConfidence(candidate) >= 2;
}

function isWeakDeinflection(candidate: DictionaryLookupCandidate) {
	return candidate.inflectionChainLength > 0 && getRuleConfidence(candidate) < 2;
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

	if (isKanjiOnly && !isExactFullSurfaceExpression && !isExactFullSurfaceReading) {
		return "kanji-only-fallback";
	}

	if (
		match.candidate.inflectionChainLength > 0 &&
		!isRuleCompatible(match)
	) {
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

function getMatchSourceStrength(groupMatches: DictionaryMatchForRanking[]) {
	if (groupMatches.some(isFullSurfaceExactExpression)) {
		return 5;
	}

	if (
		groupMatches.some(
			(match) =>
				match.matchSource === "expression" && isFullSurfaceDeinflection(match),
		)
	) {
		return 4;
	}

	if (groupMatches.some(isFullSurfaceExactReading)) {
		return 3;
	}

	if (
		groupMatches.some(
			(match) => match.matchSource === "reading" && isFullSurfaceDeinflection(match),
		)
	) {
		return 2;
	}

	if (groupMatches.some((match) => match.matchSource === "expression")) {
		return 1;
	}

	return 0;
}

function getSingleMatchSourceStrength(match: DictionaryMatchForRanking) {
	if (isFullSurfaceExactExpression(match)) {
		return 5;
	}

	if (match.matchSource === "expression" && isFullSurfaceDeinflection(match)) {
		return 4;
	}

	if (isFullSurfaceExactReading(match)) {
		return 3;
	}

	if (match.matchSource === "reading" && isFullSurfaceDeinflection(match)) {
		return 2;
	}

	if (match.matchSource === "expression") {
		return 1;
	}

	return 0;
}

function pickRepresentative(groupMatches: DictionaryMatchForRanking[]) {
	return [...groupMatches].sort((a, b) => {
		return (
			getSingleMatchSourceStrength(b) - getSingleMatchSourceStrength(a) ||
			textLength(b.candidate.surfaceForm) - textLength(a.candidate.surfaceForm) ||
			a.candidate.inflectionChainLength - b.candidate.inflectionChainLength ||
			(b.row.score ?? 0) - (a.row.score ?? 0) ||
			a.candidate.candidateOrder - b.candidate.candidateOrder ||
			a.row.expression.localeCompare(b.row.expression)
		);
	})[0];
}

export function createRankedDictionaryMatchGroups(
	matches: DictionaryMatchForRanking[],
	_input: string,
	options: {
		maxLookupLength?: number;
	} = {},
) {
	const fullSourceLength =
		matches.length > 0
			? Math.max(
					...matches.map((match) => textLength(match.candidate.surfaceForm)),
				)
			: textLength(
					normalizeLookupSource(
						_input,
						options.maxLookupLength ?? defaultMaxLookupLength,
					).join(""),
				);
	const matchesByGroupKey = new Map<string, DictionaryMatchForRanking[]>();

	for (const match of matches) {
		const groupKey = getGroupKey(match);
		const groupMatches = matchesByGroupKey.get(groupKey) ?? [];
		groupMatches.push(match);
		matchesByGroupKey.set(groupKey, groupMatches);
	}

	return [...matchesByGroupKey.entries()]
		.map(([groupKey, groupMatches]) => {
			const representative = pickRepresentative(groupMatches);
			const maxSurfaceLength = Math.max(
				...groupMatches.map((match) => textLength(match.candidate.surfaceForm)),
			);
			const primaryMatches = groupMatches.filter(
				(match) => textLength(match.candidate.surfaceForm) === maxSurfaceLength,
			);
			const exactExpressionMatchCount =
				primaryMatches.filter(isFullSurfaceExactExpression).length;
			const exactReadingMatchCount =
				primaryMatches.filter(isFullSurfaceExactReading).length;
			const deinflectionChainLength = Math.min(
				...primaryMatches.map((match) => match.candidate.inflectionChainLength),
			);
			const ruleConfidence = Math.max(
				...primaryMatches.map((match) => getRuleConfidence(match.candidate)),
			);
			const bestScore = Math.max(
				...primaryMatches.map((match) => match.row.score ?? 0),
			);
			const bestTagScore = Math.max(
				...primaryMatches.map((match) =>
					getDictionaryPriorityScore(match.row),
				),
			);
			const bestGlossCount = Math.max(
				...primaryMatches.map((match) => match.row.gloss_count ?? 0),
			);
			const frequencyScores = primaryMatches
				.map((match) => match.row.jpdb_frequency_score)
				.filter(
					(score): score is number =>
						typeof score === "number" && Number.isFinite(score),
				);
			const bestFrequencyScore =
				frequencyScores.length > 0 ? Math.min(...frequencyScores) : null;
			const termBankOrder = Math.min(
				...primaryMatches.map((match) => match.row.term_bank_order ?? Number.MAX_SAFE_INTEGER),
			);
			const dictionaryId = Math.min(
				...primaryMatches.map((match) => match.row.dictionary_id ?? Number.MAX_SAFE_INTEGER),
			);
			const candidateOrder = Math.min(
				...primaryMatches.map((match) => match.candidate.candidateOrder),
			);
			const isSingleCharacter = isSingleCharacterExpression(
				representative.row.expression,
			);
			const isKanjiOnly =
				(representative.row.score !== null && representative.row.score < 0) ||
				isSingleKanjiExpression(representative.row.expression);
			const matchSourceStrength = getMatchSourceStrength(primaryMatches);
			const sourceClasses = primaryMatches.map((match) =>
				classifyMatchSource(match, fullSourceLength),
			);
			const sourceClass = [...sourceClasses].sort(
				(a, b) => sourceClassRanks[a] - sourceClassRanks[b],
			)[0];

			return {
				groupKey,
				groupMatches,
				representative,
				rank: {
					matchSourceStrength,
					maxSurfaceLength,
					exactExpressionMatchCount,
					exactReadingMatchCount,
					deinflectionChainLength,
					ruleConfidence,
					sourceClass,
					sourceClassRank: sourceClassRanks[sourceClass],
					bestScore,
					bestTagScore,
					bestFrequencyScore,
					bestGlossCount,
					termBankOrder,
					dictionaryId,
					isSingleCharacter,
					isKanjiOnly,
					candidateOrder,
				},
			};
		})
		.sort(compareSourceClassRankedGroups);
}

export function compareSourceClassRankedGroups(
	a: RankedDictionaryMatchGroup,
	b: RankedDictionaryMatchGroup,
) {
	const left = a.rank;
	const right = b.rank;
	const longStrongSurfaceComparison =
		compareLongStrongSurfaceAgainstShortPrefixDeinflection(left, right);

	if (longStrongSurfaceComparison !== 0) {
		return longStrongSurfaceComparison;
	}

	return (
		left.sourceClassRank - right.sourceClassRank ||
		right.maxSurfaceLength - left.maxSurfaceLength ||
		right.matchSourceStrength - left.matchSourceStrength ||
		right.ruleConfidence - left.ruleConfidence ||
		right.bestScore - left.bestScore ||
		(left.bestFrequencyScore ?? Number.MAX_SAFE_INTEGER) -
			(right.bestFrequencyScore ?? Number.MAX_SAFE_INTEGER) ||
		right.bestTagScore - left.bestTagScore ||
		right.bestGlossCount - left.bestGlossCount ||
		left.dictionaryId - right.dictionaryId ||
		left.termBankOrder - right.termBankOrder ||
		left.deinflectionChainLength - right.deinflectionChainLength ||
		Number(left.isSingleCharacter) - Number(right.isSingleCharacter) ||
		Number(left.isKanjiOnly) - Number(right.isKanjiOnly) ||
		left.candidateOrder - right.candidateOrder ||
		a.representative.row.expression.localeCompare(b.representative.row.expression)
	);
}

function compareLongStrongSurfaceAgainstShortPrefixDeinflection(
	left: DictionaryRankFields,
	right: DictionaryRankFields,
) {
	const leftWins =
		isStrongFullSurfaceSource(left) &&
		isPrefixDeinflectionSource(right) &&
		left.maxSurfaceLength - right.maxSurfaceLength >= 2;
	const rightWins =
		isStrongFullSurfaceSource(right) &&
		isPrefixDeinflectionSource(left) &&
		right.maxSurfaceLength - left.maxSurfaceLength >= 2;

	if (leftWins && !rightWins) {
		return -1;
	}

	if (rightWins && !leftWins) {
		return 1;
	}

	return 0;
}

function isStrongFullSurfaceSource(rank: DictionaryRankFields) {
	return (
		rank.sourceClass === "strong-deinflection-full-source-expression" ||
		rank.sourceClass === "strong-deinflection-full-source-reading"
	);
}

function isPrefixDeinflectionSource(rank: DictionaryRankFields) {
	return (
		rank.sourceClass === "deinflection-prefix-expression" ||
		rank.sourceClass === "deinflection-prefix-reading"
	);
}
