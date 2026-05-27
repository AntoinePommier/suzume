#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const jszipSource =
	require("../node_modules/@epubjs-react-native/core/lib/commonjs/jszip.js")
		.default;

const projectRoot = path.resolve(__dirname, "..");
const dictionariesDir = path.join(projectRoot, "assets", "dictionaries");
const sourceZipPath = path.join(dictionariesDir, "jitendex-yomitan.zip");
const jpdbFrequencyZipPath = path.join(
	dictionariesDir,
	"JPDB_v2.2_Frequency_Kana_2024-10-13.zip",
);
const outputDatabasePath = path.join(dictionariesDir, "jitendex.sqlite");
const batchSize = 500;

function createJSZip() {
	const scope = {};
	const create = new Function(
		"scope",
		`
			var window = scope;
			var global = scope;
			var self = scope;
			var module = { exports: undefined };
			var exports = module.exports;

			${jszipSource}

			return module.exports || scope.JSZip;
		`,
	);

	const JSZip = create(scope);

	if (!JSZip) {
		throw new Error("Unable to initialize JSZip");
	}

	return JSZip;
}

function quoteSql(value) {
	if (value === null || value === undefined) {
		return "NULL";
	}

	return `'${String(value).replaceAll("'", "''")}'`;
}

function numberOrNull(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeGlossaryText(value) {
	return String(value).replace(/\s+/g, " ").trim();
}

function asArray(value) {
	if (value === undefined || value === null) {
		return [];
	}

	return Array.isArray(value) ? value : [value];
}

function collectGlossaryText(value, parts) {
	if (typeof value === "string") {
		const text = normalizeGlossaryText(value);

		if (text) {
			parts.push(text);
		}

		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			collectGlossaryText(item, parts);
		}

		return;
	}

	if (!value || typeof value !== "object") {
		return;
	}

	if (value.data?.content === "attribution") {
		return;
	}

	if ("content" in value) {
		collectGlossaryText(value.content, parts);
		return;
	}

	if ("text" in value) {
		collectGlossaryText(value.text, parts);
	}
}

function shouldSkipDisplayNode(value) {
	if (!value || typeof value !== "object") {
		return false;
	}

	const dataContent = String(value.data?.content || "");

	return (
		dataContent === "attribution" ||
		dataContent === "extra-info" ||
		dataContent === "forms" ||
		dataContent === "example" ||
		dataContent === "examples" ||
		dataContent === "sentence" ||
		dataContent === "sentences" ||
		dataContent === "note" ||
		dataContent === "notes"
	);
}

function collectGlossarySenseParts(value, parts) {
	if (typeof value === "string") {
		const text = normalizeGlossaryText(value);

		if (text) {
			parts.push(text);
		}

		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			collectGlossarySenseParts(item, parts);
		}

		return;
	}

	if (!value || typeof value !== "object" || shouldSkipDisplayNode(value)) {
		return;
	}

	if ("content" in value) {
		collectGlossarySenseParts(value.content, parts);
	}

	if ("text" in value) {
		collectGlossarySenseParts(value.text, parts);
	}
}

function collectGlossarySenseText(value) {
	const parts = [];
	collectGlossarySenseParts(value, parts);

	return normalizeGlossaryText([...new Set(parts)].join("; "));
}

function isGlossaryNode(value, contentName) {
	if (!value || typeof value !== "object") {
		return false;
	}

	const dataContent = String(value.data?.content || "");
	const dataClass = String(value.data?.class || "");

	if (dataContent === contentName) {
		return true;
	}

	return (
		contentName === "glossary-brief" &&
		(dataContent.includes("glossary-brief") ||
			dataContent.includes("brief-glossary") ||
			dataClass.includes("glossary-brief") ||
			dataClass.includes("brief-glossary"))
	);
}

function collectGlossaryItems(
	value,
	glosses,
	contentName,
	isInsideGlossary = false,
) {
	if (typeof value === "string") {
		const text = isInsideGlossary ? normalizeGlossaryText(value) : "";

		if (text) {
			glosses.push(text);
		}

		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			collectGlossaryItems(item, glosses, contentName, isInsideGlossary);
		}

		return;
	}

	if (!value || typeof value !== "object") {
		return;
	}

	if (isGlossaryNode(value, contentName)) {
		const text = collectGlossarySenseText(value.content);

		if (text) {
			glosses.push(text);
		}

		return;
	}

	for (const item of asArray(value.content)) {
		if (shouldSkipDisplayNode(item)) {
			continue;
		}

		collectGlossaryItems(item, glosses, contentName, isInsideGlossary);
	}
}

function collectGlossesByContentName(items, contentName) {
	const glosses = [];

	for (const item of items) {
		collectGlossaryItems(item, glosses, contentName);
	}

	return [...new Set(glosses)];
}

function extractGlosses(glossary) {
	const items = Array.isArray(glossary) ? glossary : [glossary];
	const briefGlosses = collectGlossesByContentName(items, "glossary-brief");

	if (briefGlosses.length > 0) {
		return briefGlosses;
	}

	const glosses = collectGlossesByContentName(items, "glossary");

	if (glosses.length > 0) {
		return glosses;
	}

	return items
		.flatMap((item) => {
			const parts = [];
			collectGlossaryText(item, parts);
			return [normalizeGlossaryText(parts.join(" "))];
		})
		.filter(Boolean);
}

function termBankNumber(fileName) {
	return Number(fileName.match(/\d+/)?.[0] ?? 0);
}

function isTermBank(fileName) {
	return /(^|\/)term_bank_\d+\.json$/.test(fileName);
}

function isTagBank(fileName) {
	return /(^|\/)tag_bank_\d+\.json$/.test(fileName);
}

function isTermMetaBank(fileName) {
	return /(^|\/)term_meta_bank_\d+\.json$/.test(fileName);
}

function findIndexFile(fileNames) {
	return (
		fileNames.find((name) => name === "index.json") ||
		fileNames.find((name) => /(^|\/)index\.json$/.test(name))
	);
}

function writeSql(sqlite, sql) {
	return new Promise((resolve, reject) => {
		const onError = (error) => {
			sqlite.stdin.off("drain", onDrain);
			reject(error);
		};
		const onDrain = () => {
			sqlite.stdin.off("error", onError);
			resolve();
		};

		if (sqlite.stdin.write(sql, "utf8")) {
			resolve();
			return;
		}

		sqlite.stdin.once("drain", onDrain);
		sqlite.stdin.once("error", onError);
	});
}

function runSqlite(databasePath) {
	const sqlite = spawn("sqlite3", [databasePath], {
		stdio: ["pipe", "ignore", "inherit"],
	});

	sqlite.on("error", (error) => {
		throw error;
	});

	return sqlite;
}

function closeSqlite(sqlite) {
	return new Promise((resolve, reject) => {
		sqlite.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`sqlite3 exited with code ${code}`));
			}
		});

		sqlite.stdin.end();
	});
}

function createSchemaSql() {
	return `
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
PRAGMA temp_store = MEMORY;
PRAGMA locking_mode = EXCLUSIVE;

DROP TABLE IF EXISTS dictionary_glosses;
DROP TABLE IF EXISTS dictionary_term_meta;
DROP TABLE IF EXISTS dictionary_tags;
DROP TABLE IF EXISTS dictionary_terms;
DROP TABLE IF EXISTS dictionary_metadata;

CREATE TABLE dictionary_metadata (
	key TEXT PRIMARY KEY,
	value TEXT
);

CREATE TABLE dictionary_terms (
	id INTEGER PRIMARY KEY,
	expression TEXT NOT NULL,
	reading TEXT,
	definition_tags TEXT,
	rules TEXT,
	score INTEGER,
	sequence INTEGER,
	term_tags TEXT,
	term_bank_order INTEGER NOT NULL,
	dictionary_id INTEGER NOT NULL,
	dictionary_name TEXT NOT NULL
);

CREATE TABLE dictionary_glosses (
	id INTEGER PRIMARY KEY,
	term_id INTEGER NOT NULL,
	glossary_index INTEGER NOT NULL,
	glossary_text TEXT NOT NULL,
	FOREIGN KEY (term_id) REFERENCES dictionary_terms(id) ON DELETE CASCADE
);

CREATE TABLE dictionary_tags (
	dictionary_name TEXT NOT NULL,
	name TEXT NOT NULL,
	category TEXT,
	sort_order INTEGER,
	notes TEXT,
	score INTEGER,
	PRIMARY KEY (dictionary_name, name)
);

CREATE TABLE dictionary_term_meta (
	dictionary_name TEXT NOT NULL,
	expression TEXT NOT NULL,
	reading TEXT,
	mode TEXT NOT NULL,
	data_json TEXT NOT NULL,
	frequency_score INTEGER
);
`;
}

function metadataSql(index) {
	const metadata = {
		title: index.title || "Jitendex",
		revision: index.revision || null,
		format: numberOrNull(index.format),
		source_language: index.sourceLanguage || null,
		target_language: index.targetLanguage || null,
		attribution: index.attribution || null,
		built_at: new Date().toISOString(),
	};

	return `
${Object.entries(metadata)
	.map(
		([key, value]) =>
			`INSERT INTO dictionary_metadata (key, value) VALUES (${quoteSql(
				key,
			)}, ${quoteSql(value)});`,
	)
	.join("\n")}
`;
}

function termInsertSql(term, dictionaryName, dictionaryId, termId, termBankOrder) {
	const expression = term[0] || "";

	if (!expression) {
		return { sql: "", glossCount: 0 };
	}

	const glosses = extractGlosses(term[5] || []);
	const termSql = `INSERT INTO dictionary_terms (
	id,
	expression,
	reading,
	definition_tags,
	rules,
	score,
	sequence,
	term_tags,
	term_bank_order,
	dictionary_id,
	dictionary_name
) VALUES (
	${termId},
	${quoteSql(expression)},
	${quoteSql(term[1] || "")},
	${quoteSql(term[2] || "")},
	${quoteSql(term[3] || "")},
	${numberOrNull(term[4]) ?? 0},
	${numberOrNull(term[6]) ?? "NULL"},
	${quoteSql(term[7] || "")},
	${termBankOrder},
	${dictionaryId},
	${quoteSql(dictionaryName)}
);\n`;

	const glossSql = glosses
		.map(
			(gloss, glossaryIndex) => `INSERT INTO dictionary_glosses (
	term_id,
	glossary_index,
	glossary_text
) VALUES (
	${termId},
	${glossaryIndex},
	${quoteSql(gloss)}
);\n`,
		)
		.join("");

	return { sql: `${termSql}${glossSql}`, glossCount: glosses.length };
}

function tagInsertSql(tag, dictionaryName) {
	if (!Array.isArray(tag) || !tag[0]) {
		return "";
	}

	return `INSERT OR REPLACE INTO dictionary_tags (
	dictionary_name,
	name,
	category,
	sort_order,
	notes,
	score
) VALUES (
	${quoteSql(dictionaryName)},
	${quoteSql(tag[0] || "")},
	${quoteSql(tag[1] || "")},
	${numberOrNull(tag[2]) ?? "NULL"},
	${quoteSql(tag[3] || "")},
	${numberOrNull(tag[4]) ?? "NULL"}
);\n`;
}

function termMetaInsertSql(meta, dictionaryName) {
	if (!Array.isArray(meta) || !meta[0] || !meta[1]) {
		return "";
	}

	const data = meta[2] ?? null;
	const reading =
		data && typeof data === "object" && typeof data.reading === "string"
			? data.reading
			: null;
	const frequency =
		data && typeof data === "object" && typeof data.value === "number"
			? data.value
			: data &&
					typeof data === "object" &&
					data.frequency &&
					typeof data.frequency.value === "number"
				? data.frequency.value
				: null;

	return `INSERT INTO dictionary_term_meta (
	dictionary_name,
	expression,
	reading,
	mode,
	data_json,
	frequency_score
) VALUES (
	${quoteSql(dictionaryName)},
	${quoteSql(meta[0] || "")},
	${quoteSql(reading)},
	${quoteSql(meta[1] || "")},
	${quoteSql(JSON.stringify(data))},
	${numberOrNull(frequency) ?? "NULL"}
);\n`;
}

function finalSql(termCount, glossCount, tagCount, termMetaCount) {
	return `
INSERT OR REPLACE INTO dictionary_metadata (key, value)
VALUES ('term_count', ${quoteSql(termCount)});

INSERT OR REPLACE INTO dictionary_metadata (key, value)
VALUES ('gloss_count', ${quoteSql(glossCount)});

INSERT OR REPLACE INTO dictionary_metadata (key, value)
VALUES ('tag_count', ${quoteSql(tagCount)});

INSERT OR REPLACE INTO dictionary_metadata (key, value)
VALUES ('term_meta_count', ${quoteSql(termMetaCount)});

CREATE INDEX idx_dictionary_terms_expression
	ON dictionary_terms(expression);

CREATE INDEX idx_dictionary_terms_reading
	ON dictionary_terms(reading);

CREATE INDEX idx_dictionary_terms_sequence
	ON dictionary_terms(sequence);

CREATE INDEX idx_dictionary_glosses_term_id
	ON dictionary_glosses(term_id);

CREATE INDEX idx_dictionary_term_meta_expression_reading_mode
	ON dictionary_term_meta(expression, reading, mode);

CREATE INDEX idx_dictionary_term_meta_expression_mode
	ON dictionary_term_meta(expression, mode);

CREATE INDEX idx_dictionary_term_meta_frequency_score
	ON dictionary_term_meta(frequency_score);

PRAGMA optimize;
VACUUM;
`;
}

async function importTermMetaBanks({
	zip,
	fileNames,
	sqlite,
	dictionaryName,
	label,
}) {
	const termMetaBanks = fileNames
		.filter(isTermMetaBank)
		.sort((a, b) => termBankNumber(a) - termBankNumber(b));
	let insertedTermMeta = 0;

	console.log(`${label} term meta banks: ${termMetaBanks.length}`);

	for (let bankIndex = 0; bankIndex < termMetaBanks.length; bankIndex += 1) {
		const termMetaBank = termMetaBanks[bankIndex];
		const termMeta = JSON.parse(await zip.file(termMetaBank).async("text"));

		console.log(
			`[${label} term meta ${bankIndex + 1}/${termMetaBanks.length}] ${termMetaBank} (${termMeta.length} entries)`,
		);

		for (let index = 0; index < termMeta.length; index += batchSize) {
			const batch = termMeta.slice(index, index + batchSize);
			const inserts = batch
				.map((meta) => termMetaInsertSql(meta, dictionaryName))
				.filter(Boolean);

			if (inserts.length > 0) {
				insertedTermMeta += inserts.length;
				await writeSql(sqlite, `BEGIN;\n${inserts.join("")}COMMIT;\n`);
			}
		}
	}

	return insertedTermMeta;
}

async function main() {
	if (!fs.existsSync(sourceZipPath)) {
		throw new Error(`Missing source zip: ${sourceZipPath}`);
	}

	fs.mkdirSync(dictionariesDir, { recursive: true });

	if (fs.existsSync(outputDatabasePath)) {
		fs.rmSync(outputDatabasePath);
	}

	console.log(`Reading ${path.relative(projectRoot, sourceZipPath)}`);

	const JSZip = createJSZip();
	const zip = await JSZip.loadAsync(fs.readFileSync(sourceZipPath));
	const fileNames = Object.keys(zip.files);
	const indexFile = findIndexFile(fileNames);

	if (!indexFile) {
		throw new Error("Invalid Yomitan zip: missing index.json");
	}

	const index = JSON.parse(await zip.file(indexFile).async("text"));
	const dictionaryName = index.title || "Jitendex";
	const termBanks = fileNames
		.filter(isTermBank)
		.sort((a, b) => termBankNumber(a) - termBankNumber(b));
	const tagBanks = fileNames
		.filter(isTagBank)
		.sort((a, b) => termBankNumber(a) - termBankNumber(b));

	console.log(`Dictionary: ${dictionaryName}`);
	console.log(`Term banks: ${termBanks.length}`);
	console.log(`Tag banks: ${tagBanks.length}`);
	console.log(`Writing ${path.relative(projectRoot, outputDatabasePath)}`);

	const sqlite = runSqlite(outputDatabasePath);
	let insertedEntries = 0;
	let insertedGlosses = 0;
	let insertedTags = 0;
	let insertedTermMeta = 0;
	let nextTermId = 1;
	const dictionaryId = 1;

	await writeSql(sqlite, createSchemaSql());
	await writeSql(sqlite, metadataSql(index));

	for (let bankIndex = 0; bankIndex < tagBanks.length; bankIndex += 1) {
		const tagBank = tagBanks[bankIndex];
		const tags = JSON.parse(await zip.file(tagBank).async("text"));

		console.log(
			`[tags ${bankIndex + 1}/${tagBanks.length}] ${tagBank} (${tags.length} entries)`,
		);

		for (let index = 0; index < tags.length; index += batchSize) {
			const batch = tags.slice(index, index + batchSize);
			const inserts = batch.map((tag) => tagInsertSql(tag, dictionaryName)).filter(Boolean);

			if (inserts.length > 0) {
				insertedTags += inserts.length;
				await writeSql(sqlite, `BEGIN;\n${inserts.join("")}COMMIT;\n`);
			}
		}
	}

	for (let bankIndex = 0; bankIndex < termBanks.length; bankIndex += 1) {
		const termBank = termBanks[bankIndex];
		const terms = JSON.parse(await zip.file(termBank).async("text"));

		console.log(
			`[${bankIndex + 1}/${termBanks.length}] ${termBank} (${terms.length} entries)`,
		);

		for (let index = 0; index < terms.length; index += batchSize) {
			const batch = terms.slice(index, index + batchSize);
			const inserts = [];

			for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
				const term = batch[batchIndex];
				const termBankOrder = bankIndex * 1000000 + index + batchIndex;
				const insert = termInsertSql(
					term,
					dictionaryName,
					dictionaryId,
					nextTermId,
					termBankOrder,
				);

				if (insert.sql) {
					inserts.push(insert.sql);
					insertedEntries += 1;
					insertedGlosses += insert.glossCount;
					nextTermId += 1;
				}
			}

			if (inserts.length > 0) {
				await writeSql(sqlite, `BEGIN;\n${inserts.join("")}COMMIT;\n`);
			}
		}

		console.log(
			`Inserted entries: ${insertedEntries} terms, ${insertedGlosses} glosses`,
		);
	}

	insertedTermMeta += await importTermMetaBanks({
		zip,
		fileNames,
		sqlite,
		dictionaryName,
		label: "Jitendex",
	});

	if (fs.existsSync(jpdbFrequencyZipPath)) {
		console.log(`Reading ${path.relative(projectRoot, jpdbFrequencyZipPath)}`);

		const jpdbZip = await JSZip.loadAsync(fs.readFileSync(jpdbFrequencyZipPath));
		const jpdbFileNames = Object.keys(jpdbZip.files);
		const jpdbIndexFile = findIndexFile(jpdbFileNames);

		if (!jpdbIndexFile) {
			throw new Error("Invalid JPDB frequency zip: missing index.json");
		}

		const jpdbIndex = JSON.parse(await jpdbZip.file(jpdbIndexFile).async("text"));
		const jpdbDictionaryName =
			jpdbIndex.title || jpdbIndex.revision || "JPDB Frequency";

		insertedTermMeta += await importTermMetaBanks({
			zip: jpdbZip,
			fileNames: jpdbFileNames,
			sqlite,
			dictionaryName: jpdbDictionaryName,
			label: "JPDB",
		});
	} else {
		console.warn(
			`Skipping JPDB frequency metadata; missing ${path.relative(
				projectRoot,
				jpdbFrequencyZipPath,
			)}`,
		);
	}

	console.log("Creating indexes...");
	await writeSql(
		sqlite,
		finalSql(insertedEntries, insertedGlosses, insertedTags, insertedTermMeta),
	);
	await closeSqlite(sqlite);

	const sizeInMb = fs.statSync(outputDatabasePath).size / 1024 / 1024;
	console.log(
		`Done. Wrote ${insertedEntries} terms, ${insertedGlosses} glosses, ${insertedTags} tags, and ${insertedTermMeta} term metadata rows to ${path.relative(
			projectRoot,
			outputDatabasePath,
		)} (${sizeInMb.toFixed(1)} MB).`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
