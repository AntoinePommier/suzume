#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const ts = require("typescript");

require.extensions[".ts"] = function loadTypeScriptModule(module, filename) {
	const source = require("node:fs").readFileSync(filename, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			esModuleInterop: true,
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2020,
		},
	});
	module._compile(output.outputText, filename);
};

const {
	classifyMatchSource,
	createDictionaryMatches,
	createLookupCandidates,
	createLookupPrefixes,
	createRankedDictionaryMatchGroups,
	getRuleConfidence,
	isSingleKanjiExpression,
	textLength,
} = require("../src/features/dictionary/lookup/rankDictionaryMatches.ts");

const projectRoot = path.resolve(__dirname, "..");
const dbPath = path.join(projectRoot, "assets", "dictionaries", "jitendex.sqlite");
const maxBulkRows = 1000;
const maxDisplayedResults = 30;

function sqlString(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

function runSqlJson(sql) {
	const output = execFileSync("sqlite3", ["-json", dbPath, sql], {
		encoding: "utf8",
	});

	return output.trim() ? JSON.parse(output) : [];
}

function getRowsForCandidates(candidates) {
	const terms = [...new Set(candidates.map((candidate) => candidate.dictionaryForm))];

	if (terms.length === 0) {
		return [];
	}

	const values = terms.map(sqlString).join(", ");

	return runSqlJson(`
		SELECT
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
			(
				SELECT MIN(meta.frequency_score)
				FROM dictionary_term_meta AS meta
				WHERE meta.mode = 'freq'
				  AND meta.expression = terms.expression
				  AND (meta.reading = terms.reading OR meta.reading IS NULL)
			) AS jpdb_frequency_score,
			COALESCE(MAX(tags.score), 0) AS tag_score,
			(
				SELECT COUNT(*)
				FROM dictionary_glosses AS glosses
				WHERE glosses.term_id = terms.id
			) AS gloss_count
		FROM dictionary_terms AS terms
		LEFT JOIN dictionary_tags AS tags
		  ON tags.dictionary_name = terms.dictionary_name
		 AND instr(
			' ' || COALESCE(terms.term_tags, '') || ' ' || COALESCE(terms.definition_tags, '') || ' ',
			' ' || tags.name || ' '
		) > 0
		WHERE terms.expression IN (${values})
		   OR terms.reading IN (${values})
		GROUP BY terms.id
		LIMIT ${maxBulkRows}
	`);
}

function getFrequencyRowsForDictionaryRows(rows) {
	const terms = [
		...new Set(
			rows
				.flatMap((row) => [row.expression, row.reading])
				.filter((term) => term && String(term).trim()),
		),
	];

	if (terms.length === 0) {
		return [];
	}

	const values = terms.map(sqlString).join(", ");

	return runSqlJson(`
		SELECT
			dictionary_name,
			expression,
			reading,
			mode,
			data_json,
			frequency_score
		FROM dictionary_term_meta
		WHERE mode = 'freq'
		  AND expression IN (${values})
		ORDER BY frequency_score IS NULL, frequency_score ASC
		LIMIT 2000
	`);
}

function createFrequencyIndex(frequencyRows) {
	const index = new Map();

	for (const row of frequencyRows) {
		const key = `${row.expression}\u0000${row.reading ?? ""}`;
		const existing = index.get(key) ?? [];
		existing.push(row);
		index.set(key, existing);
	}

	return index;
}

function getFrequencyRowsForTerm(frequencyIndex, expression, reading) {
	const rows = [
		...(frequencyIndex.get(`${expression}\u0000${reading ?? ""}`) ?? []),
		...(frequencyIndex.get(`${expression}\u0000`) ?? []),
	];

	if (reading) {
		rows.push(...(frequencyIndex.get(`${reading}\u0000`) ?? []));
	}

	const seen = new Set();

	return rows.filter((row) => {
		const key = [
			row.dictionary_name,
			row.expression,
			row.reading ?? "",
			row.frequency_score ?? "",
			row.data_json,
		].join("\u0000");

		if (seen.has(key)) {
			return false;
		}

		seen.add(key);
		return true;
	});
}

function formatFrequencyRows(frequencyRows) {
	if (frequencyRows.length === 0) {
		return "freq=[]";
	}

	return `freq=[${frequencyRows
		.slice(0, 4)
		.map((row) => {
			let displayValue = "";

			try {
				const data = JSON.parse(row.data_json);
				displayValue =
					data?.displayValue || data?.frequency?.displayValue || "";
			} catch {
				displayValue = "";
			}

			return [
				row.expression,
				row.reading ? `/${row.reading}` : "",
				":",
				row.frequency_score ?? "?",
				displayValue ? `(${displayValue})` : "",
			].join("");
		})
		.join(",")}${frequencyRows.length > 4 ? ",..." : ""}]`;
}

function createCurrentRuntimeOrder(rows, candidates) {
	const candidatesByTerm = new Map();
	const orderByTerm = new Map();

	for (const candidate of candidates) {
		if (!candidatesByTerm.has(candidate.dictionaryForm)) {
			candidatesByTerm.set(candidate.dictionaryForm, candidate);
			orderByTerm.set(candidate.dictionaryForm, candidate.candidateOrder);
		}
	}

	return rows
		.map((row) => {
			const expressionOrder = orderByTerm.get(row.expression);
			const readingOrder = orderByTerm.get(row.reading ?? "");
			const order =
				expressionOrder !== undefined && readingOrder !== undefined
					? Math.min(expressionOrder, readingOrder)
					: (expressionOrder ?? readingOrder);
			const candidate =
				candidatesByTerm.get(row.expression) ??
				candidatesByTerm.get(row.reading ?? "");

			if (order === undefined || !candidate) {
				return null;
			}

			return {
				row,
				candidate,
				order,
				surfaceLength: textLength(candidate.surfaceForm),
				dictionaryLength: textLength(candidate.dictionaryForm),
				isExactSurface:
					row.expression === candidate.surfaceForm ||
					row.reading === candidate.surfaceForm,
				isKanjiOnlyEntry:
					(row.score !== null && row.score < 0) ||
					isSingleKanjiExpression(row.expression),
			};
		})
		.filter(Boolean)
		.sort((a, b) => {
			return (
				Number(a.isKanjiOnlyEntry) - Number(b.isKanjiOnlyEntry) ||
				Number(b.isExactSurface) - Number(a.isExactSurface) ||
				(b.row.score ?? 0) - (a.row.score ?? 0) ||
				a.surfaceLength - b.surfaceLength ||
				b.dictionaryLength - a.dictionaryLength ||
				a.order - b.order
			);
		});
}

function formatList(items, formatter, limit = maxDisplayedResults) {
	if (items.length === 0) {
		return ["  (none)"];
	}

	const lines = items.slice(0, limit).map(formatter);

	if (items.length > limit) {
		lines.push(`  ... ${items.length - limit} more`);
	}

	return lines;
}

function formatGroupLine(group, index, frequencyIndex = new Map()) {
	const { representative, rank } = group;
	const frequencyRows = getFrequencyRowsForTerm(
		frequencyIndex,
		representative.row.expression,
		representative.row.reading,
	);

	return [
		`  ${String(index + 1).padStart(2, " ")}.`,
		`${representative.row.expression} / ${representative.row.reading ?? ""}`,
		formatFrequencyRows(frequencyRows),
		`groupKey=${group.groupKey}`,
		`matchSourceStrength=${rank.matchSourceStrength}`,
		`maxSurfaceLength=${rank.maxSurfaceLength}`,
		`exactExpressionMatchCount=${rank.exactExpressionMatchCount}`,
		`exactReadingMatchCount=${rank.exactReadingMatchCount}`,
		`deinflectionChainLength=${rank.deinflectionChainLength}`,
		`ruleConfidence=${rank.ruleConfidence}`,
		`sourceClass=${rank.sourceClass}`,
		`sourceClassRank=${rank.sourceClassRank}`,
		`bestScore=${rank.bestScore}`,
		`bestTagScore=${rank.bestTagScore}`,
		`bestFrequencyScore=${rank.bestFrequencyScore ?? ""}`,
		`bestGlossCount=${rank.bestGlossCount}`,
		`termBankOrder=${rank.termBankOrder}`,
		`dictionaryId=${rank.dictionaryId}`,
		`isSingleCharacter=${Number(rank.isSingleCharacter)}`,
		`isKanjiOnly=${Number(rank.isKanjiOnly)}`,
		`candidateOrder=${rank.candidateOrder}`,
	].join(" ");
}

function printDetailedGroupFields(input, groups, frequencyIndex) {
	console.log(`\nSource-class rank fields for ${input}`);

	for (const [index, group] of groups.entries()) {
		const { representative, rank } = group;
		const primaryLength = rank.maxSurfaceLength;
		const primaryMatches = group.groupMatches.filter(
			(match) => textLength(match.candidate.surfaceForm) === primaryLength,
		);

		console.log(formatGroupLine(group, index, frequencyIndex));

		for (const match of primaryMatches) {
			const frequencyRows = getFrequencyRowsForTerm(
				frequencyIndex,
				match.row.expression,
				match.row.reading,
			);
			console.log(
				[
					"      match:",
					`expression=${match.row.expression}`,
					`reading=${match.row.reading ?? ""}`,
					formatFrequencyRows(frequencyRows),
					`matchSource=${match.matchSource}`,
					`surfaceForm=${match.candidate.surfaceForm}`,
					`dictionaryForm=${match.candidate.dictionaryForm}`,
					`reasons=[${match.candidate.reasons.join(",")}]`,
					`rules=[${match.candidate.rules.join(",")}]`,
					`inflectionChainLength=${match.candidate.inflectionChainLength}`,
					`surfaceLength=${textLength(match.candidate.surfaceForm)}`,
					`score=${match.row.score ?? 0}`,
					`sequence=${match.row.sequence ?? ""}`,
					`definitionTags=[${match.row.definition_tags ?? ""}]`,
					`rules=[${match.row.rules ?? ""}]`,
					`termTags=[${match.row.term_tags ?? ""}]`,
					`tagScore=${match.row.tag_score ?? 0}`,
					`rankingFreq=${match.row.jpdb_frequency_score ?? ""}`,
					`glossCount=${match.row.gloss_count ?? 0}`,
					`termBankOrder=${match.row.term_bank_order ?? ""}`,
					`candidateOrder=${match.candidate.candidateOrder}`,
					`ruleConfidence=${getRuleConfidence(match.candidate)}`,
					`sourceClass=${classifyMatchSource(match, textLength(input.replace(/\s+/g, "")))}`,
				].join(" "),
			);
		}
	}
}

function debugInput(input) {
	const prefixes = createLookupPrefixes(input);
	const candidates = createLookupCandidates(input);
	const rows = getRowsForCandidates(candidates);
	const frequencyRows = getFrequencyRowsForDictionaryRows(rows);
	const frequencyIndex = createFrequencyIndex(frequencyRows);
	const rawMatches = createDictionaryMatches(rows, candidates);
	const rankedGroups = createRankedDictionaryMatchGroups(rawMatches, input);
	const currentOrder = createCurrentRuntimeOrder(rows, candidates);

	console.log(`# ${input}`);

	console.log("\nGenerated prefixes");
	console.log(
		formatList(
			prefixes,
			(prefix, index) => `  ${String(index + 1).padStart(2, " ")}. ${prefix}`,
			30,
		).join("\n"),
	);

	console.log("\nDeinflection candidates");
	console.log(
		formatList(
			candidates,
			(candidate) =>
				[
					`  ${String(candidate.candidateOrder).padStart(3, " ")}.`,
					`surface=${candidate.surfaceForm}`,
					`dictionary=${candidate.dictionaryForm}`,
					`reasons=[${candidate.reasons.join(",")}]`,
					`rules=[${candidate.rules.join(",")}]`,
				].join(" "),
			80,
		).join("\n"),
	);

	console.log("\nRaw SQLite matches");
	console.log(
		formatList(
			rawMatches,
			(match, index) =>
				[
					`  ${String(index + 1).padStart(3, " ")}.`,
					`${match.row.expression} / ${match.row.reading ?? ""}`,
					formatFrequencyRows(
						getFrequencyRowsForTerm(
							frequencyIndex,
							match.row.expression,
							match.row.reading,
						),
					),
					`matchSource=${match.matchSource}`,
					`surface=${match.candidate.surfaceForm}`,
					`dictionary=${match.candidate.dictionaryForm}`,
					`score=${match.row.score ?? 0}`,
					`sequence=${match.row.sequence ?? ""}`,
					`definitionTags=[${match.row.definition_tags ?? ""}]`,
					`rules=[${match.row.rules ?? ""}]`,
					`termTags=[${match.row.term_tags ?? ""}]`,
					`tagScore=${match.row.tag_score ?? 0}`,
					`rankingFreq=${match.row.jpdb_frequency_score ?? ""}`,
					`glossCount=${match.row.gloss_count ?? 0}`,
				].join(" "),
			80,
		).join("\n"),
	);

	console.log("\nNew source-class prototype order");
	console.log(
		formatList(rankedGroups, (group, index) =>
			formatGroupLine(group, index, frequencyIndex),
		).join("\n"),
	);

	printDetailedGroupFields(input, rankedGroups, frequencyIndex);

	console.log("\nOld/current runtime order approximation");
	console.log(
		formatList(currentOrder, (match, index) => {
			return [
				`  ${String(index + 1).padStart(2, " ")}.`,
				`${match.row.expression} / ${match.row.reading ?? ""}`,
				`surface=${match.candidate.surfaceForm}`,
				`dictionary=${match.candidate.dictionaryForm}`,
				`exact=${Number(match.isExactSurface)}`,
				`kanjiOnly=${Number(match.isKanjiOnlyEntry)}`,
				`score=${match.row.score ?? 0}`,
				`order=${match.order}`,
			].join(" ");
		}).join("\n"),
	);
}

const inputs =
	process.argv.length > 2
		? process.argv.slice(2)
		: [
				"構えし",
				"したり",
				"低く",
				"する",
				"ダウンロード",
				"あります",
				"します",
				"できません",
			];

for (const [index, input] of inputs.entries()) {
	if (index > 0) {
		console.log("\n---\n");
	}

	debugInput(input);
}
