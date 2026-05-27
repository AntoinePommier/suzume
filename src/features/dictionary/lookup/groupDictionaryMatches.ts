import {
	classifyMatchSource,
	getDictionaryPriorityScore,
	getRuleConfidence,
	isFullSurfaceDeinflection,
	isFullSurfaceExactExpression,
	isFullSurfaceExactReading,
	isSingleCharacterExpression,
	isSingleKanjiExpression,
	sourceClassRanks,
} from "./classifyDictionaryMatch";
import {
	defaultMaxLookupLength,
	normalizeLookupSource,
	textLength,
} from "./createLookupCandidates";
import type {
	DictionaryLookupCandidate,
	DictionaryMatchForRanking,
	DictionaryTermRowForRanking,
	RankedDictionaryMatchGroup,
} from "./types";

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
		candidatesByDictionaryForm.set(
			candidate.dictionaryForm,
			existingCandidates,
		);
	}

	const matches: DictionaryMatchForRanking[] = [];

	for (const row of rows) {
		const expressionCandidates =
			candidatesByDictionaryForm.get(row.expression) ?? [];
		const readingCandidates =
			candidatesByDictionaryForm.get(row.reading ?? "") ?? [];

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
			(match) =>
				match.matchSource === "reading" && isFullSurfaceDeinflection(match),
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
			textLength(b.candidate.surfaceForm) -
				textLength(a.candidate.surfaceForm) ||
			a.candidate.inflectionChainLength - b.candidate.inflectionChainLength ||
			(b.row.score ?? 0) - (a.row.score ?? 0) ||
			a.candidate.candidateOrder - b.candidate.candidateOrder ||
			a.row.expression.localeCompare(b.row.expression)
		);
	})[0];
}

export function buildRankedDictionaryMatchGroups(
	matches: DictionaryMatchForRanking[],
	_input: string,
	options: {
		maxLookupLength?: number;
	} = {},
): RankedDictionaryMatchGroup[] {
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

	return [...matchesByGroupKey.entries()].map(([groupKey, groupMatches]) => {
		const representative = pickRepresentative(groupMatches);
		const maxSurfaceLength = Math.max(
			...groupMatches.map((match) => textLength(match.candidate.surfaceForm)),
		);
		const primaryMatches = groupMatches.filter(
			(match) => textLength(match.candidate.surfaceForm) === maxSurfaceLength,
		);
		const exactExpressionMatchCount = primaryMatches.filter(
			isFullSurfaceExactExpression,
		).length;
		const exactReadingMatchCount = primaryMatches.filter(
			isFullSurfaceExactReading,
		).length;
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
			...primaryMatches.map((match) => getDictionaryPriorityScore(match.row)),
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
			...primaryMatches.map(
				(match) => match.row.term_bank_order ?? Number.MAX_SAFE_INTEGER,
			),
		);
		const dictionaryId = Math.min(
			...primaryMatches.map(
				(match) => match.row.dictionary_id ?? Number.MAX_SAFE_INTEGER,
			),
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
	});
}
