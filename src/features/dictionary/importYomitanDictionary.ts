import jszipSource from "@epubjs-react-native/core/lib/module/jszip";
import { Asset } from "expo-asset";
import * as ExpoFileSystem from "expo-file-system/legacy";

import {
	deleteDictionaryImport,
	getDictionaryDatabase,
	getImportedDictionaryByKey,
} from "./dictionaryDatabase";
import type {
	DictionaryImportProgress,
	DictionaryImportResult,
	YomitanDictionaryIndex,
	YomitanTermBankEntry,
} from "./types";

type ImportYomitanDictionaryOptions = {
	assetModule: number;
	importKey: string;
	onProgress?: (progress: DictionaryImportProgress) => void;
};

let JSZipConstructor: any;

function getJSZipConstructor() {
	if (JSZipConstructor) {
		return JSZipConstructor;
	}

	const scope: { JSZip?: any } = {};
	const source =
		typeof jszipSource === "string"
			? jszipSource
			: (jszipSource as { default?: string }).default;

	if (!source) {
		throw new Error("Unable to load Yomitan zip parser source");
	}

	const createJSZip = new Function(
		"scope",
		`
			var window = scope;
			var global = scope;
			var self = scope;
			var module = { exports: undefined };
			var exports = module.exports;

			${source}

			return module.exports || scope.JSZip;
		`,
	);

	JSZipConstructor = createJSZip(scope);

	if (!JSZipConstructor) {
		throw new Error("Unable to initialize Yomitan zip parser");
	}

	return JSZipConstructor;
}

function yieldToEventLoop() {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function getTermBankNumber(fileName: string) {
	return Number(fileName.match(/\d+/)?.[0] ?? 0);
}

function isYomitanTermBank(fileName: string) {
	return /(^|\/)term_bank_\d+\.json$/.test(fileName);
}

function findYomitanIndexFileName(fileNames: string[]) {
	return (
		fileNames.find((name) => name === "index.json") ??
		fileNames.find((name) => /(^|\/)index\.json$/.test(name))
	);
}

async function readAssetAsBase64(assetModule: number) {
	const asset = Asset.fromModule(assetModule);
	await asset.downloadAsync();

	if (!asset.localUri) {
		throw new Error("Dictionary asset was not downloaded locally");
	}

	return ExpoFileSystem.readAsStringAsync(asset.localUri, {
		encoding: "base64",
	});
}

async function createDictionaryImport(
	index: YomitanDictionaryIndex,
	importKey: string,
) {
	const db = await getDictionaryDatabase();
	const result = await db.runAsync(
		`INSERT INTO dictionaries (
			import_key,
			title,
			revision,
			format,
			source_language,
			target_language,
			attribution,
			status
		) VALUES (?, ?, ?, ?, ?, ?, ?, 'importing')`,
		importKey,
		index.title ?? "Untitled Yomitan Dictionary",
		index.revision ?? null,
		index.format ?? null,
		index.sourceLanguage ?? null,
		index.targetLanguage ?? null,
		index.attribution ?? null,
	);

	return result.lastInsertRowId;
}

async function insertTermBank(
	dictionaryId: number,
	terms: YomitanTermBankEntry[],
) {
	const db = await getDictionaryDatabase();

	await db.withExclusiveTransactionAsync(async (txn) => {
		const statement = await txn.prepareAsync(
			`INSERT INTO dictionary_terms (
				dictionary_id,
				expression,
				reading,
				definition_tags,
				rules,
				score,
				sequence,
				term_tags,
				glossary_json,
				raw_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);

		try {
			for (const term of terms) {
				await statement.executeAsync([
					dictionaryId,
					term[0],
					term[1] ?? "",
					term[2] ?? "",
					term[3] ?? "",
					typeof term[4] === "number" ? term[4] : 0,
					typeof term[6] === "number" ? term[6] : null,
					term[7] ?? "",
					JSON.stringify(term[5] ?? []),
					JSON.stringify(term),
				]);
			}
		} finally {
			await statement.finalizeAsync();
		}
	});
}

async function finalizeDictionaryImport(dictionaryId: number, termCount: number) {
	const db = await getDictionaryDatabase();

	await db.runAsync(
		`UPDATE dictionaries
		 SET status = 'complete', term_count = ?, imported_at = CURRENT_TIMESTAMP
		 WHERE id = ?`,
		termCount,
		dictionaryId,
	);
}

export async function importYomitanDictionary({
	assetModule,
	importKey,
	onProgress,
}: ImportYomitanDictionaryOptions): Promise<DictionaryImportResult> {
	onProgress?.({ phase: "checking" });

	const existingImport = await getImportedDictionaryByKey(importKey);

	if (existingImport?.status === "complete") {
		return {
			dictionaryId: existingImport.id,
			title: existingImport.title,
			revision: existingImport.revision,
			termsImported: existingImport.term_count,
			skipped: true,
		};
	}

	if (existingImport) {
		await deleteDictionaryImport(importKey);
	}

	onProgress?.({ phase: "loading-zip" });

	const dictionaryBase64 = await readAssetAsBase64(assetModule);
	const JSZip = getJSZipConstructor();
	const zip = await JSZip.loadAsync(dictionaryBase64, { base64: true });

	onProgress?.({ phase: "parsing-index" });

	const fileNames = Object.keys(zip.files);
	const indexFileName = findYomitanIndexFileName(fileNames);
	const indexText = indexFileName
		? await zip.file(indexFileName)?.async("text")
		: null;

	if (!indexText) {
		throw new Error("Invalid Yomitan dictionary: missing index.json");
	}

	const index = JSON.parse(indexText) as YomitanDictionaryIndex;
	const termBankNames = fileNames
		.filter(isYomitanTermBank)
		.sort((a, b) => getTermBankNumber(a) - getTermBankNumber(b));
	const dictionaryId = await createDictionaryImport(index, importKey);
	let termsImported = 0;

	try {
		for (let bankIndex = 0; bankIndex < termBankNames.length; bankIndex += 1) {
			const termBankName = termBankNames[bankIndex];
			const termBankText = await zip.file(termBankName)?.async("text");

			if (!termBankText) {
				continue;
			}

			const terms = JSON.parse(termBankText) as YomitanTermBankEntry[];

			await insertTermBank(dictionaryId, terms);

			termsImported += terms.length;

			onProgress?.({
				phase: "importing-terms",
				dictionaryTitle: index.title,
				banksImported: bankIndex + 1,
				totalBanks: termBankNames.length,
				termsImported,
			});

			await yieldToEventLoop();
		}

		await finalizeDictionaryImport(dictionaryId, termsImported);

		onProgress?.({
			phase: "complete",
			dictionaryTitle: index.title,
			banksImported: termBankNames.length,
			totalBanks: termBankNames.length,
			termsImported,
		});

		return {
			dictionaryId,
			title: index.title ?? "Untitled Yomitan Dictionary",
			revision: index.revision ?? null,
			termsImported,
			skipped: false,
		};
	} catch (error) {
		await deleteDictionaryImport(importKey);
		throw error;
	}
}
