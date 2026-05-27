import * as SQLite from "expo-sqlite";
import { Asset } from "expo-asset";
import * as ExpoFileSystem from "expo-file-system/legacy";

const databaseName = "suzume-dictionaries.db";
const bundledJitendexDatabaseName = "jitendex.sqlite";

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let bundledJitendexDatabasePromise: Promise<SQLite.SQLiteDatabase | null> | null =
	null;

export async function getDictionaryDatabase() {
	if (!databasePromise) {
		databasePromise = SQLite.openDatabaseAsync(databaseName).then(async (db) => {
			await initializeDictionaryDatabase(db);
			return db;
		});
	}

	return databasePromise;
}

async function initializeDictionaryDatabase(db: SQLite.SQLiteDatabase) {
	await db.execAsync(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;

		CREATE TABLE IF NOT EXISTS dictionaries (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			import_key TEXT NOT NULL UNIQUE,
			title TEXT NOT NULL,
			revision TEXT,
			format INTEGER,
			source_language TEXT,
			target_language TEXT,
			attribution TEXT,
			term_count INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'complete',
			imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS dictionary_terms (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			dictionary_id INTEGER NOT NULL,
			expression TEXT NOT NULL,
			reading TEXT,
			definition_tags TEXT,
			rules TEXT,
			score INTEGER,
			sequence INTEGER,
			term_tags TEXT,
			glossary_json TEXT NOT NULL,
			raw_json TEXT NOT NULL,
			FOREIGN KEY (dictionary_id) REFERENCES dictionaries(id) ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS idx_dictionary_terms_expression
			ON dictionary_terms(expression);

		CREATE INDEX IF NOT EXISTS idx_dictionary_terms_dictionary_expression
			ON dictionary_terms(dictionary_id, expression);

		CREATE INDEX IF NOT EXISTS idx_dictionary_terms_reading
			ON dictionary_terms(reading);
	`);
}

export async function getImportedDictionaryByKey(importKey: string) {
	const db = await getDictionaryDatabase();

	return db.getFirstAsync<{
		id: number;
		title: string;
		revision: string | null;
		term_count: number;
		status: string;
	}>(
		`SELECT id, title, revision, term_count, status
		 FROM dictionaries
		 WHERE import_key = ?`,
		importKey,
	);
}

export async function deleteDictionaryImport(importKey: string) {
	const db = await getDictionaryDatabase();

	await db.runAsync("DELETE FROM dictionaries WHERE import_key = ?", importKey);
}

async function copyBundledSqliteAssetIfNeeded(
	assetModule: number,
	databaseFileName: string,
) {
	const destinationUri = `${ExpoFileSystem.documentDirectory}${databaseFileName}`;
	const markerUri = `${destinationUri}.asset.json`;
	const asset = Asset.fromModule(assetModule);
	await asset.downloadAsync();

	if (!asset.localUri) {
		throw new Error("Bundled dictionary database asset was not downloaded");
	}

	const [destinationInfo, markerInfo, assetInfo] = await Promise.all([
		ExpoFileSystem.getInfoAsync(destinationUri),
		ExpoFileSystem.getInfoAsync(markerUri),
		ExpoFileSystem.getInfoAsync(asset.localUri),
	]);
	const destinationSize =
		destinationInfo.exists && "size" in destinationInfo
			? destinationInfo.size
			: null;
	const assetSize = assetInfo.exists && "size" in assetInfo ? assetInfo.size : null;
	const assetHash = asset.hash ?? null;
	const marker = markerInfo.exists
		? await ExpoFileSystem.readAsStringAsync(markerUri)
				.then((value) => JSON.parse(value) as { hash?: string | null; size?: number | null })
				.catch(() => null)
		: null;
	const isCurrentCopy =
		destinationInfo.exists &&
		assetSize !== null &&
		destinationSize === assetSize &&
		(!assetHash || marker?.hash === assetHash);

	if (isCurrentCopy) {
		return;
	}

	if (destinationInfo.exists) {
		await ExpoFileSystem.deleteAsync(destinationUri, { idempotent: true });
	}
	await ExpoFileSystem.deleteAsync(markerUri, { idempotent: true });

	await ExpoFileSystem.copyAsync({
		from: asset.localUri,
		to: destinationUri,
	});
	await ExpoFileSystem.writeAsStringAsync(
		markerUri,
		JSON.stringify({
			hash: assetHash,
			size: assetSize,
			copiedAt: new Date().toISOString(),
		}),
	);
}

export async function openBundledDictionaryDatabase(
	databaseFileName: string,
	assetModule?: number | null,
) {
	if (!assetModule) {
		return null;
	}

	await copyBundledSqliteAssetIfNeeded(assetModule, databaseFileName);

	return SQLite.openDatabaseAsync(
		databaseFileName,
		undefined,
		ExpoFileSystem.documentDirectory ?? undefined,
	);
}

export function getBundledJitendexDatabase() {
	if (!bundledJitendexDatabasePromise) {
		bundledJitendexDatabasePromise = openBundledDictionaryDatabase(
			bundledJitendexDatabaseName,
			getBundledJitendexSqliteAssetModule(),
		);
	}

	return bundledJitendexDatabasePromise;
}

function getBundledJitendexSqliteAssetModule(): number | null {
	return require("../../../assets/dictionaries/jitendex.sqlite");
}
