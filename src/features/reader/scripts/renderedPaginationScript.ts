export function createRenderedPaginationScript(background: string) {
	return `
(() => {
	if (window.__suzumeRenderedPaginationAttached) {
		return;
	}

	window.__suzumeRenderedPaginationAttached = true;

	const reactNativeWebview =
		window.ReactNativeWebView !== undefined && window.ReactNativeWebView !== null
			? window.ReactNativeWebView
			: window;

	let computeTimer = null;
	let activeLayoutKey = null;
	let isComputing = false;
	let needsRecompute = false;

	function postMessage(type, payload) {
		reactNativeWebview.postMessage(JSON.stringify({ type, payload }));
	}

	function waitForFrames(frameCount) {
		return new Promise((resolve) => {
			function step(remainingFrames) {
				if (remainingFrames <= 0) {
					resolve();
					return;
				}

				requestAnimationFrame(() => step(remainingFrames - 1));
			}

			step(frameCount);
		});
	}

	function getViewerSize() {
		const viewer = document.getElementById("viewer");
		const bounds = viewer && viewer.getBoundingClientRect();
		const width =
			(bounds && Math.round(bounds.width)) ||
			(viewer && viewer.clientWidth) ||
			window.innerWidth;
		const height =
			(bounds && Math.round(bounds.height)) ||
			(viewer && viewer.clientHeight) ||
			window.innerHeight;

		return { width, height };
	}

	function getLayoutKey() {
		const size = getViewerSize();
		const settings = rendition && rendition.settings ? rendition.settings : {};

		return [
			size.width,
			size.height,
			settings.flow || "auto",
			settings.spread || "none",
			settings.direction || "ltr",
			document.documentElement && document.documentElement.clientWidth,
			document.documentElement && document.documentElement.clientHeight,
		].join("|");
	}

	function getLinearSpineItems() {
		const items =
			book &&
			book.spine &&
			Array.isArray(book.spine.spineItems)
				? book.spine.spineItems
				: [];

		return items.filter((item) => item && item.linear !== "no");
	}

	async function computeRenderedPagination() {
		if (
			isComputing ||
			typeof book === "undefined" ||
			typeof rendition === "undefined"
		) {
			if (isComputing) {
				needsRecompute = true;
			}

			return;
		}

		const layoutKey = getLayoutKey();

		if (activeLayoutKey === layoutKey) {
			return;
		}

		isComputing = true;
		activeLayoutKey = layoutKey;

		const spineItems = getLinearSpineItems();
		postMessage("rendered-pagination-loading", {
			layoutKey,
			spineCount: spineItems.length,
		});

		let measuringRendition = null;
		let measuringContainer = null;

		try {
			await book.ready;
			await waitForFrames(2);

			const size = getViewerSize();
			measuringContainer = document.createElement("div");
			measuringContainer.id = "suzume-rendered-pagination-measurer";
			measuringContainer.setAttribute("aria-hidden", "true");
			measuringContainer.style.position = "fixed";
			measuringContainer.style.left = "-100000px";
			measuringContainer.style.top = "0";
			measuringContainer.style.width = size.width + "px";
			measuringContainer.style.height = size.height + "px";
			measuringContainer.style.overflow = "hidden";
			measuringContainer.style.opacity = "0";
			measuringContainer.style.pointerEvents = "none";
			measuringContainer.style.backgroundColor = ${JSON.stringify(background)};
			document.body.appendChild(measuringContainer);

			measuringRendition = book.renderTo(measuringContainer, {
				width: size.width,
				height: size.height,
				manager: "default",
				flow: "paginated",
				snap: undefined,
				spread: "none",
				fullsize: undefined,
				allowPopups: typeof allowPopups !== "undefined" ? allowPopups : false,
				allowScriptedContent:
					typeof allowScriptedContent !== "undefined"
						? allowScriptedContent
						: false,
			});

			measuringRendition.themes.register({ theme });
			measuringRendition.themes.select("theme");
			measuringRendition.direction(
				rendition.settings && rendition.settings.direction
					? rendition.settings.direction
					: "ltr",
			);

			const pageCountsBySpineIndex = {};
			let totalPages = 0;

			for (const item of spineItems) {
				await measuringRendition.display(item.index);
				await waitForFrames(2);

				const location = measuringRendition.currentLocation();
				const displayedTotal =
					location &&
					location.start &&
					location.start.displayed &&
					Number(location.start.displayed.total);
				const fallbackTotal =
					location &&
					location.end &&
					location.end.displayed &&
					Number(location.end.displayed.total);
				const pageCount = Math.max(1, displayedTotal || fallbackTotal || 1);

				pageCountsBySpineIndex[item.index] = pageCount;
				totalPages += pageCount;
			}

			postMessage("rendered-pagination-ready", {
				layoutKey,
				pageCountsBySpineIndex,
				totalPages,
			});
		} catch (error) {
			activeLayoutKey = null;
			postMessage("rendered-pagination-error", {
				layoutKey,
				error: error && error.message ? error.message : "Unable to paginate book",
			});
		} finally {
			if (measuringRendition && measuringRendition.destroy) {
				measuringRendition.destroy();
			}

			if (measuringContainer && measuringContainer.parentNode) {
				measuringContainer.parentNode.removeChild(measuringContainer);
			}

			isComputing = false;

			if (needsRecompute) {
				needsRecompute = false;
				activeLayoutKey = null;
				scheduleRenderedPagination();
			}
		}
	}

	function scheduleRenderedPagination() {
		if (computeTimer) {
			clearTimeout(computeTimer);
		}

		computeTimer = setTimeout(computeRenderedPagination, 250);
	}

	if (typeof rendition !== "undefined") {
		rendition.on("resized", () => {
			activeLayoutKey = null;
			scheduleRenderedPagination();
		});

		rendition.on("layout", () => {
			activeLayoutKey = null;
			scheduleRenderedPagination();
		});
	}

	scheduleRenderedPagination();
})();
true;
`;
}
