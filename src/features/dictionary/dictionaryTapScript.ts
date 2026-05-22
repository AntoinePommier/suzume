export const dictionaryTapScript = `
(() => {
	const maxTapMovement = 10;

	function postDictionaryMessage(message) {
		const reactNativeWebview =
			window.ReactNativeWebView !== undefined && window.ReactNativeWebView !== null
				? window.ReactNativeWebView
				: window;

		reactNativeWebview.postMessage(JSON.stringify(message));
	}

	function postDictionaryTap(text) {
		postDictionaryMessage({
			type: "dictionary-tap",
			payload: { text }
		});
	}

	function postDictionaryClose() {
		postDictionaryMessage({
			type: "dictionary-close"
		});
	}

	function getRangeFromPoint(doc, x, y) {
		if (doc.caretRangeFromPoint) {
			return doc.caretRangeFromPoint(x, y);
		}

		if (doc.caretPositionFromPoint) {
			const position = doc.caretPositionFromPoint(x, y);

			if (!position) {
				return null;
			}

			const range = doc.createRange();
			range.setStart(position.offsetNode, position.offset);
			range.collapse(true);

			return range;
		}

		return null;
	}

	function isDictionaryCharacter(character) {
		if (!character || /\\s/.test(character)) {
			return false;
		}

		if (/^[\\u3000-\\u303f\\u30fb\\uff00-\\uff65!"#$%&'()*+,\\-./:;<=>?@[\\]^_\`{|}~]$/.test(character)) {
			return false;
		}

		return true;
	}

	function getUnicodeCharacterAtUtf16Offset(text, offset) {
		if (!text || offset < 0 || offset >= text.length) {
			return "";
		}

		const prefixLength = Array.from(text.slice(0, offset)).length;
		const characters = Array.from(text);

		return characters[prefixLength] || "";
	}

	function getCharacterFromCaret(doc, x, y) {
		const range = getRangeFromPoint(doc, x, y);
		const node = range && range.startContainer;
		const offset = range ? range.startOffset : -1;

		if (!node || node.nodeType !== Node.TEXT_NODE) {
			return "";
		}

		const character = getUnicodeCharacterAtUtf16Offset(node.textContent || "", offset);

		return isDictionaryCharacter(character) ? character : "";
	}

	function rectContainsPoint(rect, x, y) {
		return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
	}

	function findCharacterInTextNode(doc, node, x, y) {
		const text = node.textContent || "";
		const characters = Array.from(text);
		let utf16Offset = 0;

		for (const character of characters) {
			const nextOffset = utf16Offset + character.length;

			if (isDictionaryCharacter(character)) {
				const range = doc.createRange();
				range.setStart(node, utf16Offset);
				range.setEnd(node, nextOffset);

				const rects = Array.from(range.getClientRects());
				range.detach && range.detach();

				if (rects.some((rect) => rectContainsPoint(rect, x, y))) {
					return character;
				}
			}

			utf16Offset = nextOffset;
		}

		return "";
	}

	function getTextNodesUnderPoint(doc, x, y) {
		const element = doc.elementFromPoint(x, y);

		if (!element) {
			return [];
		}

		const nodeFilter = doc.defaultView ? doc.defaultView.NodeFilter : NodeFilter;
		const walker = doc.createTreeWalker(element, nodeFilter.SHOW_TEXT);
		const nodes = [];
		let node = walker.nextNode();

		while (node) {
			nodes.push(node);
			node = walker.nextNode();
		}

		return nodes;
	}

	function getCharacterFromMeasuredRanges(doc, x, y) {
		const nodes = getTextNodesUnderPoint(doc, x, y);

		for (const node of nodes) {
			const character = findCharacterInTextNode(doc, node, x, y);

			if (character) {
				return character;
			}
		}

		return "";
	}

	function getCharacterFromPoint(doc, x, y) {
		return (
			getCharacterFromCaret(doc, x, y) ||
			getCharacterFromMeasuredRanges(doc, x, y)
		);
	}

	function attachDictionaryTap(contents) {
		const doc = contents && contents.document ? contents.document : document;

		if (!doc || doc.__suzumeDictionaryTapAttached) {
			return;
		}

		doc.__suzumeDictionaryTapAttached = true;

		let startX = 0;
		let startY = 0;

		doc.addEventListener("touchstart", (event) => {
			const touch = event.changedTouches && event.changedTouches[0];

			if (!touch) {
				return;
			}

			startX = touch.clientX;
			startY = touch.clientY;
		}, { passive: true });

		doc.addEventListener("touchend", (event) => {
			const touch = event.changedTouches && event.changedTouches[0];

			if (!touch) {
				return;
			}

			const deltaX = touch.clientX - startX;
			const deltaY = touch.clientY - startY;

			if (Math.abs(deltaX) > maxTapMovement || Math.abs(deltaY) > maxTapMovement) {
				return;
			}

			const text = getCharacterFromPoint(doc, touch.clientX, touch.clientY);

			if (text) {
				postDictionaryTap(text);
			} else {
				postDictionaryClose();
			}
		}, { passive: true });
	}

	function attachToRenderedContents() {
		attachDictionaryTap({ document });

		if (typeof rendition === "undefined" || !rendition.getContents) {
			return;
		}

		rendition.getContents().forEach(attachDictionaryTap);
	}

	attachToRenderedContents();

	if (typeof rendition !== "undefined") {
		if (rendition.hooks && rendition.hooks.content) {
			rendition.hooks.content.register(attachDictionaryTap);
		}

		rendition.on("rendered", attachToRenderedContents);
		rendition.on("relocated", attachToRenderedContents);
	}

	setInterval(attachToRenderedContents, 1000);
})();
true;
`;
