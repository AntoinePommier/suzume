import AsyncStorage from "@react-native-async-storage/async-storage";

export type StoredReadingProgress = {
	bookId: string;
	location?: string;
	progress?: number | null;
	updatedAt: string;
};

export type ReadingProgressState = {
	byBookId: Record<string, StoredReadingProgress>;
	lastOpenedBookId?: string;
};

const readingProgressStorageKey = "suzume:reading-progress";
const emptyReadingProgressState: ReadingProgressState = {
	byBookId: {},
};

export function normalizeReadingProgress(
	progress: number | null | undefined,
): number | null {
	if (typeof progress !== "number" || !Number.isFinite(progress)) {
		return null;
	}

	const normalizedProgress =
		progress >= 0 && progress <= 1 ? progress * 100 : progress;

	if (normalizedProgress < 0 || normalizedProgress > 100) {
		return null;
	}

	return normalizedProgress;
}

export async function getReadingProgressState() {
	try {
		const progressJson = await AsyncStorage.getItem(readingProgressStorageKey);

		if (!progressJson) {
			return emptyReadingProgressState;
		}

		const progressState = JSON.parse(progressJson) as ReadingProgressState;

		return {
			...emptyReadingProgressState,
			...progressState,
			byBookId: progressState.byBookId ?? {},
		};
	} catch {
		return emptyReadingProgressState;
	}
}

async function writeReadingProgressState(progressState: ReadingProgressState) {
	await AsyncStorage.setItem(
		readingProgressStorageKey,
		JSON.stringify(progressState),
	);
}

export async function saveReadingProgress(progress: {
	bookId: string;
	location?: string;
	progress?: number | null;
}) {
	const currentState = await getReadingProgressState();
	const currentProgress = currentState.byBookId[progress.bookId];
	const normalizedProgress = normalizeReadingProgress(progress.progress);
	const nextProgress: StoredReadingProgress = {
		bookId: progress.bookId,
		location: progress.location ?? currentProgress?.location,
		progress: normalizedProgress ?? currentProgress?.progress ?? null,
		updatedAt: new Date().toISOString(),
	};

	await writeReadingProgressState({
		byBookId: {
			...currentState.byBookId,
			[progress.bookId]: nextProgress,
		},
		lastOpenedBookId: progress.bookId,
	});

	return nextProgress;
}

export async function markBookOpened(bookId: string) {
	const currentState = await getReadingProgressState();
	const currentProgress = currentState.byBookId[bookId];
	const updatedAt = new Date().toISOString();

	await writeReadingProgressState({
		byBookId: {
			...currentState.byBookId,
			[bookId]: currentProgress
				? {
						...currentProgress,
						updatedAt,
					}
				: {
						bookId,
						progress: null,
						updatedAt,
					},
		},
		lastOpenedBookId: bookId,
	});
}

export async function deleteReadingProgress(
	bookId: string,
	remainingBookIds?: string[],
) {
	const currentState = await getReadingProgressState();
	const { [bookId]: _deletedProgress, ...remainingProgressByBookId } =
		currentState.byBookId;
	const remainingBookIdSet = remainingBookIds
		? new Set(remainingBookIds)
		: null;
	const nextLastOpenedBookId =
		currentState.lastOpenedBookId === bookId
			? Object.values(remainingProgressByBookId)
					.filter((progress) =>
						remainingBookIdSet ? remainingBookIdSet.has(progress.bookId) : true,
					)
					.sort(
						(a, b) =>
							(Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
					)[0]?.bookId
			: currentState.lastOpenedBookId;

	await writeReadingProgressState({
		byBookId: remainingProgressByBookId,
		lastOpenedBookId: nextLastOpenedBookId,
	});
}
