export const dictionaryTapScript = `
(() => {
	const maxTapMovement = 10;
	const contextRadius = 20;

	function postDictionaryMessage(message) {
		const reactNativeWebview =
			window.ReactNativeWebView !== undefined && window.ReactNativeWebView !== null
				? window.ReactNativeWebView
				: window;

		reactNativeWebview.postMessage(JSON.stringify(message));
	}

	function postDictionaryTap(payload) {
		postDictionaryMessage({
			type: "dictionary-tap",
			payload
		});
	}

	function postDictionaryClose() {
		postDictionaryMessage({
			type: "dictionary-close"
		});
	}

	function postReaderBackgroundTap() {
		postDictionaryMessage({
			type: "reader-background-tap"
		});
	}

	function getHighlightDocuments() {
		const docs = [document];

		if (typeof rendition !== "undefined" && rendition.getContents) {
			for (const content of rendition.getContents()) {
				if (content && content.document && !docs.includes(content.document)) {
					docs.push(content.document);
				}
			}
		}

		return docs;
	}

	function ensureDictionaryHighlightStyle(doc) {
		if (!doc || doc.getElementById("suzume-dictionary-highlight-style")) {
			return;
		}

		const style = doc.createElement("style");
		style.id = "suzume-dictionary-highlight-style";
		style.textContent = [
			".suzume-dictionary-highlight {",
			"background-color: rgba(90, 70, 40, 0.14);",
			"box-shadow: 0 0 0 1px rgba(90, 70, 40, 0.14);",
			"border-radius: 2px;",
			"-webkit-box-decoration-break: clone;",
			"box-decoration-break: clone;",
			"}"
		].join("");

		(doc.head || doc.documentElement).appendChild(style);
	}

	function unwrapDictionaryHighlight(highlight) {
		const parent = highlight.parentNode;

		if (!parent) {
			return;
		}

		while (highlight.firstChild) {
			parent.insertBefore(highlight.firstChild, highlight);
		}

		parent.removeChild(highlight);
		parent.normalize && parent.normalize();
	}

	function clearDictionaryHighlightInDocument(doc, options) {
		if (!doc) {
			return;
		}

		const highlights = Array.from(
			doc.querySelectorAll(".suzume-dictionary-highlight")
		);

		for (const highlight of highlights) {
			unwrapDictionaryHighlight(highlight);
		}

		if (!options || options.clearAnchor !== false) {
			doc.__suzumeDictionaryHighlightAnchor = null;
		}
	}

	function clearDictionaryHighlights() {
		for (const doc of getHighlightDocuments()) {
			clearDictionaryHighlightInDocument(doc);
		}
	}

	function clearDictionaryHighlightSpans() {
		for (const doc of getHighlightDocuments()) {
			clearDictionaryHighlightInDocument(doc, { clearAnchor: false });
		}
	}

	window.__suzumeClearDictionaryHighlight = clearDictionaryHighlights;

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

	function cleanContextText(text) {
		return text.replace(/\\s+/g, "");
	}

	function hasExcludedTextAncestor(node) {
		let current = node && node.parentElement;

		while (current) {
			const tagName = current.tagName ? current.tagName.toLowerCase() : "";

			if (
				tagName === "rt" ||
				tagName === "rp" ||
				tagName === "script" ||
				tagName === "style"
			) {
				return true;
			}

			current = current.parentElement;
		}

		return false;
	}

	function getVisibleTextNodes(doc) {
		const root = doc.body || doc.documentElement;

		if (!root) {
			return [];
		}

		const nodeFilter = doc.defaultView ? doc.defaultView.NodeFilter : NodeFilter;
		const walker = doc.createTreeWalker(
			root,
			nodeFilter.SHOW_TEXT,
			{
				acceptNode(node) {
					if (hasExcludedTextAncestor(node)) {
						return nodeFilter.FILTER_REJECT;
					}

					return cleanContextText(node.textContent || "")
						? nodeFilter.FILTER_ACCEPT
						: nodeFilter.FILTER_REJECT;
				}
			}
		);
		const nodes = [];
		let node = walker.nextNode();

		while (node) {
			nodes.push(node);
			node = walker.nextNode();
		}

		return nodes;
	}

	function takeLastCharacters(text, maxLength) {
		return Array.from(text).slice(-maxLength).join("");
	}

	function takeFirstCharacters(text, maxLength) {
		return Array.from(text).slice(0, maxLength).join("");
	}

	function buildBeforeFromVisibleTextNodes(visibleTextNodes, nodeIndex, utf16Offset) {
		let before = cleanContextText(
			(visibleTextNodes[nodeIndex].textContent || "").slice(0, utf16Offset)
		);

		for (
			let index = nodeIndex - 1;
			index >= 0 && Array.from(before).length < contextRadius;
			index -= 1
		) {
			before = cleanContextText(visibleTextNodes[index].textContent || "") + before;
		}

		return takeLastCharacters(before, contextRadius);
	}

	function buildAfterFromVisibleTextNodes(visibleTextNodes, nodeIndex, utf16Offset) {
		let after = cleanContextText(
			(visibleTextNodes[nodeIndex].textContent || "").slice(utf16Offset)
		);
		const maxAfterLength = contextRadius + 1;

		for (
			let index = nodeIndex + 1;
			index < visibleTextNodes.length && Array.from(after).length < maxAfterLength;
			index += 1
		) {
			after += cleanContextText(visibleTextNodes[index].textContent || "");
		}

		return takeFirstCharacters(after, maxAfterLength);
	}

	function buildDictionaryPayload(node, utf16Offset) {
		const rawText = node.textContent || "";
		const character = getUnicodeCharacterAtUtf16Offset(rawText, utf16Offset);

		if (!isDictionaryCharacter(character)) {
			return null;
		}

		if (hasExcludedTextAncestor(node)) {
			return null;
		}

		const doc = node.ownerDocument || document;
		const visibleTextNodes = getVisibleTextNodes(doc);
		const nodeIndex = visibleTextNodes.indexOf(node);

		if (nodeIndex < 0) {
			return null;
		}

		doc.__suzumeDictionaryHighlightAnchor = {
			node,
			utf16Offset
		};

		const before = buildBeforeFromVisibleTextNodes(
			visibleTextNodes,
			nodeIndex,
			utf16Offset
		);
		const after = buildAfterFromVisibleTextNodes(
			visibleTextNodes,
			nodeIndex,
			utf16Offset
		);

		return {
			character,
			before,
			after,
			context: before + after
		};
	}

	function collectHighlightSegments(
		visibleTextNodes,
		nodeIndex,
		utf16Offset,
		surfaceLength
	) {
		const segments = [];
		let remaining = surfaceLength;

		for (
			let index = nodeIndex;
			index < visibleTextNodes.length && remaining > 0;
			index += 1
		) {
			const node = visibleTextNodes[index];
			const text = node.textContent || "";
			const characters = Array.from(text);
			let currentUtf16Offset = 0;
			let segmentStart = null;
			let segmentEnd = null;

			for (const character of characters) {
				const nextUtf16Offset = currentUtf16Offset + character.length;
				const isBeforeStart =
					index === nodeIndex && nextUtf16Offset <= utf16Offset;

				if (!isBeforeStart && remaining > 0) {
					if (segmentStart === null) {
						segmentStart = Math.max(currentUtf16Offset, utf16Offset);
					}

					segmentEnd = nextUtf16Offset;

					if (!/\\s/.test(character)) {
						remaining -= 1;
					}
				}

				currentUtf16Offset = nextUtf16Offset;

				if (remaining <= 0) {
					break;
				}
			}

			if (
				segmentStart !== null &&
				segmentEnd !== null &&
				segmentEnd > segmentStart
			) {
				segments.push({
					node,
					start: segmentStart,
					end: segmentEnd
				});
			}
		}

		return remaining === 0 ? segments : [];
	}

	function wrapHighlightSegment(doc, segment) {
		const range = doc.createRange();
		range.setStart(segment.node, segment.start);
		range.setEnd(segment.node, segment.end);

		const highlight = doc.createElement("span");
		highlight.className = "suzume-dictionary-highlight";
		highlight.setAttribute("data-suzume-dictionary-highlight", "true");
		highlight.appendChild(range.extractContents());
		range.insertNode(highlight);
		range.detach && range.detach();
	}

	function highlightDictionarySurface(surfaceText) {
		const matchedText = cleanContextText(surfaceText || "");

		clearDictionaryHighlightSpans();

		if (!matchedText) {
			return;
		}

		for (const doc of getHighlightDocuments()) {
			const anchor = doc.__suzumeDictionaryHighlightAnchor;

			if (!anchor || !anchor.node || !anchor.node.isConnected) {
				continue;
			}

			const visibleTextNodes = getVisibleTextNodes(doc);
			const nodeIndex = visibleTextNodes.indexOf(anchor.node);

			if (nodeIndex < 0) {
				continue;
			}

			const segments = collectHighlightSegments(
				visibleTextNodes,
				nodeIndex,
				anchor.utf16Offset,
				Array.from(matchedText).length
			);

			if (segments.length === 0) {
				continue;
			}

			ensureDictionaryHighlightStyle(doc);

			for (let index = segments.length - 1; index >= 0; index -= 1) {
				wrapHighlightSegment(doc, segments[index]);
			}

			return;
		}
	}

	window.__suzumeHighlightDictionaryMatch = highlightDictionarySurface;

	function getDictionaryPayloadFromCaret(doc, x, y) {
		const range = getRangeFromPoint(doc, x, y);
		const node = range && range.startContainer;
		const offset = range ? range.startOffset : -1;

		if (!node || node.nodeType !== Node.TEXT_NODE) {
			return null;
		}

		const character = getUnicodeCharacterAtUtf16Offset(node.textContent || "", offset);

		return isDictionaryCharacter(character)
			? buildDictionaryPayload(node, offset)
			: null;
	}

	function rectContainsPoint(rect, x, y) {
		return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
	}

	function findDictionaryPayloadInTextNode(doc, node, x, y) {
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
					return buildDictionaryPayload(node, utf16Offset);
				}
			}

			utf16Offset = nextOffset;
		}

		return null;
	}

	function hasTextCharacterAtPointInTextNode(doc, node, x, y) {
		const text = node.textContent || "";
		const characters = Array.from(text);
		let utf16Offset = 0;

		for (const character of characters) {
			const nextOffset = utf16Offset + character.length;

			if (!/\\s/.test(character)) {
				const range = doc.createRange();
				range.setStart(node, utf16Offset);
				range.setEnd(node, nextOffset);

				const rects = Array.from(range.getClientRects());
				range.detach && range.detach();

				if (rects.some((rect) => rectContainsPoint(rect, x, y))) {
					return true;
				}
			}

			utf16Offset = nextOffset;
		}

		return false;
	}

	function getTextNodesUnderPoint(doc, x, y) {
		const element = doc.elementFromPoint(x, y);

		if (!element) {
			return [];
		}

		const nodeFilter = doc.defaultView ? doc.defaultView.NodeFilter : NodeFilter;
		const walker = doc.createTreeWalker(
			element,
			nodeFilter.SHOW_TEXT,
			{
				acceptNode(node) {
					return hasExcludedTextAncestor(node)
						? nodeFilter.FILTER_REJECT
						: nodeFilter.FILTER_ACCEPT;
				}
			}
		);
		const nodes = [];
		let node = walker.nextNode();

		while (node) {
			nodes.push(node);
			node = walker.nextNode();
		}

		return nodes;
	}

	function getDictionaryPayloadFromMeasuredRanges(doc, x, y) {
		const nodes = getTextNodesUnderPoint(doc, x, y);

		for (const node of nodes) {
			const payload = findDictionaryPayloadInTextNode(doc, node, x, y);

			if (payload) {
				return payload;
			}
		}

		return null;
	}

	function hasTextCharacterAtPoint(doc, x, y) {
		const nodes = getTextNodesUnderPoint(doc, x, y);

		for (const node of nodes) {
			if (hasTextCharacterAtPointInTextNode(doc, node, x, y)) {
				return true;
			}
		}

		return false;
	}

	function getDictionaryPayloadFromPoint(doc, x, y) {
		return (
			getDictionaryPayloadFromCaret(doc, x, y) ||
			getDictionaryPayloadFromMeasuredRanges(doc, x, y)
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

			clearDictionaryHighlights();

			const payload = getDictionaryPayloadFromPoint(doc, touch.clientX, touch.clientY);

			if (payload) {
				postDictionaryTap(payload);
			} else if (hasTextCharacterAtPoint(doc, touch.clientX, touch.clientY)) {
				postDictionaryClose();
			} else {
				postReaderBackgroundTap();
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
