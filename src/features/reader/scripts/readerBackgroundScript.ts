export function createReaderBackgroundScript(background: string) {
	return `
(() => {
	const readerBackground = ${JSON.stringify(background)};

	function applyDocumentBackground(document) {
		if (!document) {
			return;
		}

		const root = document.documentElement;
		const body = document.body;
		const viewer = document.getElementById("viewer");

		if (root) {
			root.style.setProperty("background-color", readerBackground, "important");
		}

		if (body) {
			body.style.setProperty("background-color", readerBackground, "important");
		}

		if (viewer) {
			viewer.style.setProperty("background-color", readerBackground, "important");
		}
	}

	function applyContentBackground(contents) {
		if (!contents || !contents.document) {
			return;
		}

		applyDocumentBackground(contents.document);
	}

	function applyAllBackgrounds() {
		applyDocumentBackground(document);

		if (typeof rendition === "undefined" || !rendition.getContents) {
			return;
		}

		rendition.getContents().forEach(applyContentBackground);
	}

	if (typeof rendition !== "undefined") {
		if (rendition.hooks && rendition.hooks.content) {
			rendition.hooks.content.register((contents) => {
				applyContentBackground(contents);
			});
		}

		rendition.on("rendered", applyAllBackgrounds);
		rendition.on("relocated", applyAllBackgrounds);
		rendition.on("resized", applyAllBackgrounds);
	}

	applyAllBackgrounds();
})();
true;
`;
}
