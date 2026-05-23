export const rtlSwipeScript = `
(() => {
	const minSwipeDistance = 60;
	const maxVerticalRatio = 1.5;
	let isPaging = false;

	function attachSwipe(target) {
		if (!target || target.__suzumeRtlSwipeAttached) {
			return;
		}

		target.__suzumeRtlSwipeAttached = true;

		let startX = 0;
		let startY = 0;

		target.addEventListener("touchstart", (event) => {
			const touch = event.changedTouches && event.changedTouches[0];

			if (!touch) {
				return;
			}

			startX = touch.clientX;
			startY = touch.clientY;
		}, { passive: true });

		target.addEventListener("touchend", (event) => {
			const touch = event.changedTouches && event.changedTouches[0];

			if (!touch || isPaging || typeof rendition === "undefined") {
				return;
			}

			const deltaX = touch.clientX - startX;
			const deltaY = touch.clientY - startY;

			if (
				Math.abs(deltaX) < minSwipeDistance ||
				Math.abs(deltaX) < Math.abs(deltaY) * maxVerticalRatio
			) {
				return;
			}

			isPaging = true;

			const pageTurn = deltaX > 0 ? rendition.next() : rendition.prev();

			Promise.resolve(pageTurn)
				.catch(() => {})
				.finally(() => {
					setTimeout(() => {
						isPaging = false;
						attachToRenderedContents();
					}, 250);
				});
		}, { passive: true });
	}

	function attachSwipeToContents(contents) {
		if (!contents) {
			return;
		}

		attachSwipe(contents.window);
		attachSwipe(contents.document);
		attachSwipe(contents.document && contents.document.documentElement);
		attachSwipe(contents.document && contents.document.body);
	}

	function attachToRenderedContents() {
		attachSwipe(window);
		attachSwipe(document);
		attachSwipe(document.documentElement);
		attachSwipe(document.body);

		if (typeof rendition === "undefined" || !rendition.getContents) {
			return;
		}

		rendition.getContents().forEach(attachSwipeToContents);
	}

	attachToRenderedContents();

	if (typeof rendition !== "undefined") {
		if (rendition.hooks && rendition.hooks.content) {
			rendition.hooks.content.register((contents) => {
				attachSwipeToContents(contents);
			});
		}

		rendition.on("rendered", attachToRenderedContents);
		rendition.on("relocated", attachToRenderedContents);
		rendition.on("resized", attachToRenderedContents);
	}

	setInterval(attachToRenderedContents, 1000);
})();
true;
`;
