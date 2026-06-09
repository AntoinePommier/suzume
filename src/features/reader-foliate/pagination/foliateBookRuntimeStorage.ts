import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
	BookRuntimeState,
	FoliateReadingPosition,
	FoliateRenderedPagination,
} from "./foliatePaginationTypes";

const KEY_PREFIX = "suzume:book-runtime-state:v1:";

async function load(bookId: string): Promise<BookRuntimeState | null> {
	try {
		const raw = await AsyncStorage.getItem(KEY_PREFIX + bookId);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as BookRuntimeState;
		return parsed.version === 1 ? parsed : null;
	} catch {
		return null;
	}
}

async function persist(state: BookRuntimeState): Promise<void> {
	try {
		await AsyncStorage.setItem(
			KEY_PREFIX + state.bookId,
			JSON.stringify(state),
		);
	} catch {
		// Storage errors are non-fatal; pagination will be remeasured next time.
	}
}

export async function getFoliatePagination(
	bookId: string,
	bookFingerprint: string,
	layoutKey: string,
): Promise<FoliateRenderedPagination | null> {
	const state = await load(bookId);
	if (!state || state.bookFingerprint !== bookFingerprint) return null;
	return state.engineStates.foliate?.paginationByLayoutKey[layoutKey] ?? null;
}

export async function getFoliateLastPosition(
	bookId: string,
	bookFingerprint: string,
): Promise<FoliateReadingPosition | null> {
	const state = await load(bookId);
	if (!state || state.bookFingerprint !== bookFingerprint) return null;
	return state.engineStates.foliate?.lastPosition ?? null;
}

export async function upsertFoliateLastPosition(
	bookId: string,
	bookFingerprint: string,
	position: FoliateReadingPosition,
): Promise<void> {
	const existing = await load(bookId);
	const base: BookRuntimeState =
		existing?.bookFingerprint === bookFingerprint
			? existing
			: { version: 1, bookId, bookFingerprint, engineStates: {} };
	const foliate = base.engineStates.foliate ?? { paginationByLayoutKey: {} };
	foliate.lastPosition = position;
	await persist({ ...base, engineStates: { ...base.engineStates, foliate } });
}

export async function upsertFoliatePagination(
	bookId: string,
	bookFingerprint: string,
	pagination: FoliateRenderedPagination,
): Promise<void> {
	const existing = await load(bookId);
	// If the fingerprint changed, discard stale engine states for this book.
	const base: BookRuntimeState =
		existing?.bookFingerprint === bookFingerprint
			? existing
			: { version: 1, bookId, bookFingerprint, engineStates: {} };

	const foliate = base.engineStates.foliate ?? { paginationByLayoutKey: {} };
	foliate.paginationByLayoutKey[pagination.layoutKey] = pagination;
	await persist({ ...base, engineStates: { ...base.engineStates, foliate } });
}
