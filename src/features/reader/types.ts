export type ReadingDirection = "ltr" | "rtl";

export type ReaderLocation = {
	start?: {
		cfi?: string;
		displayed?: {
			page?: number;
			total?: number;
		};
		href?: string;
		index?: number;
	};
	end?: {
		cfi?: string;
		displayed?: {
			page?: number;
			total?: number;
		};
	};
};

export type RenderedPaginationMessage =
	| {
			type: "rendered-pagination-loading";
			payload?: {
				layoutKey?: string;
				spineCount?: number;
			};
	  }
	| {
			type: "rendered-pagination-ready";
			payload?: {
				layoutKey?: string;
				pageCountsBySpineIndex?: Record<string, number>;
				totalPages?: number;
			};
	  }
	| {
			type: "rendered-pagination-error";
			payload?: {
				error?: string;
				layoutKey?: string;
			};
	  };

export type RenderedPaginationState =
	| {
			status: "idle" | "loading" | "error";
			layoutKey?: string;
			error?: string;
	  }
	| {
			status: "ready";
			layoutKey?: string;
			pageCountsBySpineIndex: Record<number, number>;
			offsetsBySpineIndex: Record<number, number>;
			totalPages: number;
	  };
