// Bump this constant whenever the measurement logic, bundle, or layout
// defaults change in a way that would produce different page counts.
export const FOLIATE_ENGINE_BUILD_ID = "foliate-js-spike-v8" as const;

// Parameters that fully describe a layout configuration.
// Only include fields that are EXPLICITLY applied — omit fields whose value
// is determined by Foliate defaults that we do not override.
export type ReaderLayoutProfile = {
	engine: "foliate";
	engineBuildId: string;
	viewportWidth: number;
	viewportHeight: number;
	pixelRatio: number;
	orientation: "portrait" | "landscape";
	// Set only when explicitly applied (e.g. via renderer.setAttribute):
	maxColumnCount: number;
	flow: "paginated";
	// Optional — set only when we explicitly control them:
	direction?: "ltr" | "rtl" | null;
	writingMode?: "horizontal-tb" | "vertical-rl" | string | null;
	fontFamily?: string | null;
	fontSize?: number | null;
	lineHeight?: number | null;
	margin?: number | null;
	gap?: number | null;
	maxInlineSize?: number | null;
	maxBlockSize?: number | null;
};

export type FoliateReadingPosition = {
	cfi: string;
	fraction: number;
	sectionIndex: number;
	savedAt: number;
};

export type FoliateRenderedPagination = {
	version: 1;
	layoutKey: string;
	layoutProfile: ReaderLayoutProfile;
	createdAt: number;
	sectionPageCounts: Record<number, number>;
	sectionOffsets: Record<number, number>;
	totalPages: number;
};

export type FoliateBookEngineState = {
	lastPosition?: FoliateReadingPosition;
	paginationByLayoutKey: Record<string, FoliateRenderedPagination>;
};

// Placeholder — not implemented yet.
export type EpubJsBookEngineState = Record<string, never>;

export type BookRuntimeState = {
	version: 1;
	bookId: string;
	bookFingerprint: string;
	engineStates: {
		foliate?: FoliateBookEngineState;
		epubjs?: EpubJsBookEngineState;
	};
};
