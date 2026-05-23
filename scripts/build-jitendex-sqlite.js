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
	score INTEGER,
	sequence INTEGER,
	dictionary_name TEXT NOT NULL
);

CREATE TABLE dictionary_glosses (
	id INTEGER PRIMARY KEY,
	term_id INTEGER NOT NULL,
	glossary_index INTEGER NOT NULL,
	glossary_text TEXT NOT NULL,
	FOREIGN KEY (term_id) REFERENCES dictionary_terms(id) ON DELETE CASCADE
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

function termInsertSql(term, dictionaryName, termId) {
	const expression = term[0] || "";

	if (!expression) {
		return { sql: "", glossCount: 0 };
	}

	const glosses = extractGlosses(term[5] || []);
	const termSql = `INSERT INTO dictionary_terms (
	id,
	expression,
	reading,
	score,
	sequence,
	dictionary_name
) VALUES (
	${termId},
	${quoteSql(expression)},
	${quoteSql(term[1] || "")},
	${numberOrNull(term[4]) ?? 0},
	${numberOrNull(term[6]) ?? "NULL"},
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

function finalSql(termCount, glossCount) {
	return `
INSERT OR REPLACE INTO dictionary_metadata (key, value)
VALUES ('term_count', ${quoteSql(termCount)});

INSERT OR REPLACE INTO dictionary_metadata (key, value)
VALUES ('gloss_count', ${quoteSql(glossCount)});

CREATE INDEX idx_dictionary_terms_expression
	ON dictionary_terms(expression);

CREATE INDEX idx_dictionary_terms_reading
	ON dictionary_terms(reading);

CREATE INDEX idx_dictionary_glosses_term_id
	ON dictionary_glosses(term_id);

PRAGMA optimize;
VACUUM;
`;
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

	console.log(`Dictionary: ${dictionaryName}`);
	console.log(`Term banks: ${termBanks.length}`);
	console.log(`Writing ${path.relative(projectRoot, outputDatabasePath)}`);

	const sqlite = runSqlite(outputDatabasePath);
	let insertedEntries = 0;
	let insertedGlosses = 0;
	let nextTermId = 1;

	await writeSql(sqlite, createSchemaSql());
	await writeSql(sqlite, metadataSql(index));

	for (let bankIndex = 0; bankIndex < termBanks.length; bankIndex += 1) {
		const termBank = termBanks[bankIndex];
		const terms = JSON.parse(await zip.file(termBank).async("text"));

		console.log(
			`[${bankIndex + 1}/${termBanks.length}] ${termBank} (${terms.length} entries)`,
		);

		for (let index = 0; index < terms.length; index += batchSize) {
			const batch = terms.slice(index, index + batchSize);
			const inserts = [];

			for (const term of batch) {
				const insert = termInsertSql(term, dictionaryName, nextTermId);

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

	console.log("Creating indexes...");
	await writeSql(sqlite, finalSql(insertedEntries, insertedGlosses));
	await closeSqlite(sqlite);

	const sizeInMb = fs.statSync(outputDatabasePath).size / 1024 / 1024;
	console.log(
		`Done. Wrote ${insertedEntries} terms and ${insertedGlosses} glosses to ${path.relative(
			projectRoot,
			outputDatabasePath,
		)} (${sizeInMb.toFixed(1)} MB).`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
