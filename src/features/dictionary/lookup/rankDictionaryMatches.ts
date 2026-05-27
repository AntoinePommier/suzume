import { buildRankedDictionaryMatchGroups } from "./groupDictionaryMatches";
import type {
	DictionaryMatchForRanking,
	DictionaryRankFields,
	RankedDictionaryMatchGroup,
} from "./types";

export {
	classifyMatchSource,
	getDictionaryPriorityScore,
	getRuleConfidence,
	isFullSurfaceDeinflection,
	isFullSurfaceExactExpression,
	isFullSurfaceExactReading,
	isRuleCompatible,
	isSingleCharacterExpression,
	isSingleKanjiExpression,
	sourceClassRanks,
	splitDictionaryTags,
} from "./classifyDictionaryMatch";
export {
	characters,
	createLookupCandidates,
	createLookupPrefixes,
	defaultMaxLookupCandidates,
	defaultMaxLookupLength,
	normalizeLookupSource,
	textLength,
} from "./createLookupCandidates";
export {
	buildRankedDictionaryMatchGroups,
	createDictionaryMatches,
	getGroupKey,
} from "./groupDictionaryMatches";
export type {
	DictionaryLookupCandidate,
	DictionaryMatchForRanking,
	DictionaryMatchSource,
	DictionaryRankFields,
	DictionarySourceClass,
	DictionaryTermRowForRanking,
	RankedDictionaryMatchGroup,
} from "./types";

export function createRankedDictionaryMatchGroups(
	matches: DictionaryMatchForRanking[],
	_input: string,
	options: {
		maxLookupLength?: number;
	} = {},
) {
	return buildRankedDictionaryMatchGroups(matches, _input, options).sort(
		compareSourceClassRankedGroups,
	);
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
		a.representative.row.expression.localeCompare(
			b.representative.row.expression,
		)
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
