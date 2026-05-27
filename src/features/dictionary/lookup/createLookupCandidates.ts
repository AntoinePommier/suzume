import { deinflectJapaneseTerm } from "../japaneseDeinflector";
import type { DictionaryLookupCandidate } from "./types";

export const defaultMaxLookupLength = 20;
export const defaultMaxLookupCandidates = 400;

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
