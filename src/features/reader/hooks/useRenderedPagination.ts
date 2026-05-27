import { useCallback, useMemo, useState } from "react";
import type {
	ReaderLocation,
	RenderedPaginationMessage,
	RenderedPaginationState,
} from "../types";

export function useRenderedPagination(
	currentReaderLocation: ReaderLocation | null,
) {
	const [renderedPagination, setRenderedPagination] =
		useState<RenderedPaginationState>({ status: "idle" });

	const renderedPageIndicator = useMemo(() => {
		if (
			renderedPagination.status !== "ready" ||
			!currentReaderLocation?.start?.displayed?.page ||
			currentReaderLocation.start.index === undefined ||
			renderedPagination.totalPages <= 0
		) {
			return null;
		}

		const currentSpineIndex = currentReaderLocation.start.index;
		const currentLocalPage = currentReaderLocation.start.displayed.page;
		const currentPageCount =
			renderedPagination.pageCountsBySpineIndex[currentSpineIndex] ?? 0;

		if (currentPageCount <= 0) {
			return null;
		}

		const clampedLocalPage = Math.min(
			Math.max(1, currentLocalPage),
			currentPageCount,
		);
		const currentGlobalPage =
			(renderedPagination.offsetsBySpineIndex[currentSpineIndex] ?? 0) +
			clampedLocalPage;

		return {
			currentPage: currentGlobalPage,
			totalPages: renderedPagination.totalPages,
		};
	}, [currentReaderLocation, renderedPagination]);

	const handleRenderedPaginationMessage = useCallback(
		(message: RenderedPaginationMessage | { type?: string }) => {
			if (message.type === "rendered-pagination-loading") {
				const payload =
					"payload" in message && message.payload ? message.payload : {};

				setRenderedPagination({
					status: "loading",
					layoutKey: payload.layoutKey,
				});
				return true;
			}

			if (message.type === "rendered-pagination-ready") {
				const payload =
					"payload" in message && message.payload ? message.payload : {};
				const pageCountsBySpineIndex = Object.fromEntries(
					Object.entries(payload.pageCountsBySpineIndex ?? {})
						.map(([spineIndex, pageCount]) => [
							Number(spineIndex),
							Number(pageCount),
						])
						.filter(
							([spineIndex, pageCount]) =>
								Number.isFinite(spineIndex) &&
								Number.isFinite(pageCount) &&
								pageCount > 0,
						),
				);
				const sortedSpineIndexes = Object.keys(pageCountsBySpineIndex)
					.map(Number)
					.sort((a, b) => a - b);
				const offsetsBySpineIndex: Record<number, number> = {};
				let totalPages = 0;

				for (const spineIndex of sortedSpineIndexes) {
					offsetsBySpineIndex[spineIndex] = totalPages;
					totalPages += pageCountsBySpineIndex[spineIndex];
				}

				setRenderedPagination({
					status: "ready",
					layoutKey: payload.layoutKey,
					pageCountsBySpineIndex,
					offsetsBySpineIndex,
					totalPages: payload.totalPages || totalPages,
				});
				return true;
			}

			if (message.type === "rendered-pagination-error") {
				const payload =
					"payload" in message && message.payload ? message.payload : {};

				setRenderedPagination({
					status: "error",
					layoutKey: payload.layoutKey,
					error: payload.error,
				});
				return true;
			}

			return false;
		},
		[],
	);

	return {
		renderedPagination,
		setRenderedPagination,
		renderedPageIndicator,
		handleRenderedPaginationMessage,
	};
}
