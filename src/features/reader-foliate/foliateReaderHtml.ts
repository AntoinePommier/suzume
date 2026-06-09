import { foliateBundle } from "./foliateBundle";

// Bridge script injected after the foliate bundle.
// Runs inside the WebView; communicates with RN via ReactNativeWebView.postMessage.
const BRIDGE = `(function () {
  var rnPost = function (type, payload) {
    try {
      var msg = JSON.stringify({ type: type, payload: payload });
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(msg);
      }
    } catch (_) {}
  };

  var view = document.getElementById("fv");
  var bookDir = "rtl";
  var sessionId = Math.random().toString(36).slice(2, 8);
  var relocateCount = 0;
  // Dedup key for the view-level relocate: cfi + section index.
  var lastRelocateKey = null;
  // Tracked from load and relocate events; used to compute global page.
  var currentSectionIndex = 0;
  // Set once measurement is complete via window.__setGlobalPagination().
  var globalPagination = null;
  // Last global page successfully displayed. Held across spine transitions so
  // the footer never goes blank while Foliate briefly enters a sentinel state.
  var lastDisplayedGlobalPage = null;
  var isMeasuring = false;
  // Set to true while a goLeft/goRight call is in flight (including async
  // goToSpread at spine boundaries). Prevents concurrent navigations that
  // would race on Foliate's internal spread state.
  var isPaging = false;
  var pendingNavAction = null;
  var pagingTimeoutId = null;
  // Mirrored from RN via window.__suzumeSetDictionaryOpen(). When true the touch
  // handler short-circuits: taps post dictionary-close, swipes are ignored.
  var isDictionaryOpen = false;
  // Set true to enable verbose navigation/touch diagnostics in the RN console.
  var DEBUG_NAV = false;
  function navLog(msg) { if (DEBUG_NAV) rnPost("log", msg); }
  rnPost("log", "[FOLIATE-SPIKE] bridge init sessionId=" + sessionId);

  // Write the page counter into view.renderer.feet (Foliate's built-in footer zone).
  // feet[0] is a div[part="foot"] whose CSS is handled by the paginator shadow DOM.
  // Called from the paginator-level relocate, which fires after columnize() recreates feet.
  function updateFeet() {
    var r = view.renderer;
    if (!r || !r.feet || r.feet.length === 0) return;
    var rawPage = r.page;   // 1-based content page; 0 and pages-1 are blank sentinels
    var rawPages = r.pages; // total including 2 blank sentinels
    var contentTotal = rawPages - 2;
    var isValid = rawPage >= 1 && rawPage <= contentTotal && contentTotal > 0;
    var text = "";
    if (isValid && globalPagination) {
      var offset = (globalPagination.sectionOffsets[currentSectionIndex] || 0);
      var globalPage = offset + rawPage;
      lastDisplayedGlobalPage = globalPage;
      text = String(globalPage);
      navLog(
        "[FOLIATE-PAGE] sec=" + currentSectionIndex +
        " raw=" + rawPage + "/" + rawPages +
        " local=" + rawPage +
        " offset=" + offset +
        " global=" + globalPage + "/" + globalPagination.totalPages
      );
    } else if (globalPagination && lastDisplayedGlobalPage !== null) {
      // Spine transition: rawPage temporarily out of range during layout.
      // Hold the last known page to avoid a visible blank flash in the footer.
      text = String(lastDisplayedGlobalPage);
    }
    // No globalPagination yet → footer stays empty.
    for (var i = 0; i < r.feet.length; i++) {
      r.feet[i].textContent = text;
    }
  }

  // Called from RN via injectJavaScript once measurement is complete.
  window.__setGlobalPagination = function (data) {
    globalPagination = data;
    rnPost("log",
      "[FOLIATE-SPIKE] __setGlobalPagination totalPages=" + data.totalPages
    );
    updateFeet();
  };

  // Called from RN via injectJavaScript after the WebView loads.
  window.__openBook = function (b64) {
    rnPost("log", "[FOLIATE-SPIKE] __openBook called");
    try {
      var binary = atob(b64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      var file = new File([bytes], "book.epub", {
        type: "application/epub+zip",
      });
      view
        .open(file)
        .then(function () {
          bookDir = (view.book && view.book.dir) ? view.book.dir : "rtl";
          rnPost("log", "[FOLIATE-SPIKE] book opened dir=" + bookDir);
          // Force single-column — prevents the paginator from showing two
          // columns (spread) on a portrait mobile screen with vertical-rl.
          view.renderer.setAttribute("max-column-count", "1");
          rnPost("log", "[FOLIATE-SPIKE] set max-column-count=1");

          // Listen to the paginator-level relocate to update the feet counter.
          // This fires after columnize() so feet is always the current array.
          view.renderer.addEventListener("relocate", function () {
            updateFeet();
          });

          rnPost("log", "[FOLIATE-SPIKE] calling goToFraction(0)");
          return view.goToFraction(0);
        })
        .then(function () {
          rnPost("log", "[FOLIATE-SPIKE] goToFraction(0) resolved");
          rnPost("ready", {});
        })
        .catch(function (e) {
          rnPost(
            "error",
            "[FOLIATE-SPIKE] open failed: " + (e && e.message ? e.message : String(e))
          );
        });
    } catch (e) {
      rnPost(
        "error",
        "[FOLIATE-SPIKE] __openBook threw: " + (e && e.message ? e.message : String(e))
      );
    }
  };

  // Navigation — called from RN via injectJavaScript.
  // view.next() / view.prev() always mean "forward/backward in reading order",
  // regardless of RTL/LTR. They are distinct from goLeft()/goRight() which are
  // direction-aware aliases.
  window.__navNext = function () {
    rnPost("log", "[FOLIATE-SPIKE] nav next()");
    view.next();
  };
  window.__navPrev = function () {
    rnPost("log", "[FOLIATE-SPIKE] nav prev()");
    view.prev();
  };
  // goLeft/goRight are direction-aware: Foliate maps them to next/prev
  // depending on book.dir (RTL or LTR), so swipe direction matches screen space.
  window.__navGoLeft = function () {
    view.goLeft();
  };
  window.__navGoRight = function () {
    view.goRight();
  };
  window.__goTo = function (cfi) {
    rnPost("log", "[FOLIATE-SPIKE] goTo " + cfi);
    view.goTo(cfi).catch(function (e) {
      rnPost("error", "[FOLIATE-SPIKE] goTo failed: " + String(e));
    });
  };

  // ── global pagination measurement ────────────────────────────────────────
  // Navigates every spine section sequentially in the main reader, reads
  // renderer.pages - 2 for each, posts "pagination-ready" when done, then
  // returns to the initial reading position. The preparation overlay on the
  // RN side covers the reader while pages flip, so the user sees nothing.
  // measureSection: navigate to targetIndex, then poll renderer.pages across
  // requestAnimationFrame ticks until the value is stable (same on two consecutive
  // frames) and > 2 (actual content pages, not just the two blank sentinels).
  // goTo().then() is not sufficient on its own: it can resolve before the paginator
  // finishes columnize(), leaving renderer.pages=2 (sentinels only).
  // Fallback: after MAX_FRAMES retries, use content=1 instead of 0 — a section
  // that resolved but couldn't stabilise likely has at least one real page.
  function measureSection(targetIndex) {
    var MAX_FRAMES = 12;
    return new Promise(function (resolve) {
      var sectionConfirmed = false;
      function onRelocate(e) {
        var sec = ((e.detail || {}).section || {}).current;
        if (sec === targetIndex) sectionConfirmed = true;
      }
      view.addEventListener("relocate", onRelocate);
      view.goTo(targetIndex)
        .then(function () {
          view.removeEventListener("relocate", onRelocate);
          if (!sectionConfirmed) {
            rnPost("log", "[MEASURE] sec=" + targetIndex + " WARNING no-relocate-confirm");
          }
          var prevRaw = 0;
          var attempt = 0;
          function tick() {
            var raw = view.renderer.pages;
            if (raw > 2 && raw === prevRaw) {
              resolve(raw - 2);
              return;
            }
            if (attempt >= MAX_FRAMES) {
              var content = raw > 2 ? raw - 2 : 1;
              rnPost("log",
                "[MEASURE] sec=" + targetIndex +
                " WARNING unstable-or-empty rawPages=" + raw +
                " fallback=" + content
              );
              resolve(content);
              return;
            }
            prevRaw = raw;
            attempt++;
            requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
        })
        .catch(function (e) {
          view.removeEventListener("relocate", onRelocate);
          rnPost("log", "[MEASURE] sec=" + targetIndex + " goTo-error=" + String(e));
          resolve(0);
        });
    });
  }

  window.__startMeasurement = function (initialCfi) {
    if (isMeasuring || !view.book) return;
    isMeasuring = true;
    var totalSections = view.book.sections.length;
    rnPost("log", "[FOLIATE-SPIKE] measurement-start totalSections=" + totalSections);
    var sectionPageCounts = {};
    var index = 0;

    function step() {
      if (index >= totalSections) return Promise.resolve();
      var i = index++;
      return measureSection(i).then(function (pages) {
        sectionPageCounts[i] = pages;
        return step();
      });
    }

    step()
      .then(function () {
        var sectionOffsets = {};
        var total = 0;
        for (var i = 0; i < totalSections; i++) {
          sectionOffsets[i] = total;
          total += sectionPageCounts[i] || 0;
        }
        rnPost("log", "[FOLIATE-SPIKE] measurement-complete totalPages=" + total);
        // Log the full table so we can verify stability across remeasures.
        for (var j = 0; j < totalSections; j++) {
          rnPost("log",
            "[MEASURE-TABLE] sec=" + j +
            " content=" + (sectionPageCounts[j] || 0) +
            " offset=" + (sectionOffsets[j] || 0)
          );
        }
        rnPost("pagination-ready", {
          sectionPageCounts: sectionPageCounts,
          sectionOffsets: sectionOffsets,
          totalPages: total,
        });
        isMeasuring = false;
        return initialCfi
          ? view.goTo(initialCfi).catch(function () { return view.goToFraction(0); })
          : view.goToFraction(0);
      })
      .catch(function (e) {
        isMeasuring = false;
        rnPost("log", "[FOLIATE-SPIKE] measurement-error: " + String(e));
        rnPost("pagination-error", { message: String(e) });
      });
  };
  // ─────────────────────────────────────────────────────────────────────────

  // Location events.
  rnPost("log", "[FOLIATE-SPIKE] attaching relocate listener sid=" + sessionId);
  view.addEventListener("relocate", function (e) {
    relocateCount++;
    var d = e.detail || {};
    var cfi = d.cfi || null;
    var fraction = d.fraction != null ? d.fraction : null;
    var section = d.section || {};
    var location = d.location || {};

    // Always track the section index, even for deduped events.
    if (section.current != null) {
      currentSectionIndex = section.current;
    }

    // Pages flip under the preparation overlay during measurement — no need
    // to post relocated messages; the user sees nothing.
    if (isMeasuring) return;

    // Sentinel detection: paginator.js always emits a relocate on page 0 or
    // pages-1 as the first step of any spine crossing (#scrollPrev/#scrollNext
    // scroll to the sentinel column before calling #goTo on the adjacent section).
    // Content pages are structurally 1..pages-2 (see #scrollToAnchor formula).
    // Releasing isPaging on a sentinel would open a window where #locked is still
    // true inside Foliate, so any swipe would be silently discarded by #turnPage.
    var rendPage = view.renderer.page;
    var rendPages = view.renderer.pages;
    var isSentinel = rendPages <= 2 || rendPage < 1 || rendPage > rendPages - 2;

    // Diagnostic log — always, including sentinels.
    var key = (cfi || "") + "|" + (section.current != null ? section.current : "");
    navLog(
      "[FOLIATE-NAV] RELOCATE-FIRE #" + relocateCount +
      " sec=" + (section.current != null ? section.current : "?") +
      " page=" + rendPage + "/" + rendPages +
      (isSentinel ? " [SENTINEL — guard held]" : "") +
      " key=" + key.slice(0, 50)
    );

    if (isSentinel) {
      // Crossing in progress: keep isPaging locked, skip the relocated post.
      // The content-page relocate following the new spine's load will release it.
      return;
    }

    // On a real content page: Foliate has fully landed after navigation.
    releasePaging("relocate");
    if (key && key === lastRelocateKey) {
      navLog(
        "[FOLIATE-SPIKE] relocate #" + relocateCount + " ignored (dup sid=" + sessionId + ")"
      );
      return;
    }
    lastRelocateKey = key;

    rnPost("relocated", {
      cfi: cfi,
      fraction: fraction,
      sectionCurrent: section.current != null ? section.current : null,
      sectionTotal: section.total != null ? section.total : null,
      locationCurrent: location.current != null ? location.current : null,
      locationTotal: location.total != null ? location.total : null,
    });
    navLog(
      "[FOLIATE-SPIKE] RELOCATED #" + relocateCount +
        " sid=" + sessionId +
        " sec=" + section.current + "/" + section.total +
        " loc=" + (location.current != null ? location.current + "/" + location.total : "n/a") +
        " frac=" + (fraction != null ? fraction.toFixed(4) : "n/a") +
        " cfi=" + (cfi ? cfi.slice(0, 60) : "n/a")
    );
  });

  view.addEventListener("load", function (e) {
    var d = e.detail || {};
    if (d.index != null) {
      currentSectionIndex = d.index;
    }
    if (view.book && view.book.dir) {
      bookDir = view.book.dir;
    }
    // Re-attach on every section load: each spine section gets a fresh iframe
    // with a new contentDocument, so the previous listeners are gone.
    attachToAllContents();
    if (isMeasuring) return;
    rnPost("loaded", { index: d.index });
    rnPost(
      "log",
      "[FOLIATE-SPIKE] LOADED spine=" + d.index + " bookDir=" + bookDir
    );
  });

  // ── touch: swipe navigation + background tap ─────────────────────────────
  // Foliate renders each spine section in an iframe inside a closed shadow DOM.
  // Touch events do not bubble across iframe boundaries, so document.addEventListener
  // on the outer WebView document never fires for book content touches.
  // We attach listeners directly to each iframe's contentDocument via
  // view.renderer.getContents(), re-attaching on every "load" event because
  // each section gets a fresh iframe (and a fresh contentDocument).
  //
  // Future dictionary tap: replace the reader-background-tap branch with
  // caretRangeFromPoint(doc, x, y) to distinguish text vs. background,
  // then post dictionary-tap or reader-background-tap accordingly.
  var TAP_MAX_PX = 10;
  var SWIPE_MIN_PX = 50;
  var SWIPE_VERT_RATIO = 1.5;

  // ── dictionary tap ────────────────────────────────────────────────────────
  // Ported from dictionaryTapScript.ts; adapted for Foliate's iframe API.
  // getHighlightDocuments() uses view.renderer.getContents() (.doc field).
  // All functions run inside attachTouchListeners' closure (doc is in scope).
  var DICT_CONTEXT_RADIUS = 20;

  function isDictionaryCharacter(character) {
    if (!character || /\\s/.test(character)) return false;
    if (/^[\\u3000-\\u303f\\u30fb\\uff00-\\uff65!"#$%&'()*+,\\-./:;<=>?@[\\]^_\`{|}~]$/.test(character)) return false;
    return true;
  }

  function getUnicodeCharacterAtUtf16Offset(text, offset) {
    if (!text || offset < 0 || offset >= text.length) return "";
    var prefixLength = Array.from(text.slice(0, offset)).length;
    return Array.from(text)[prefixLength] || "";
  }

  function cleanContextText(text) {
    return text.replace(/\\s+/g, "");
  }

  function hasExcludedTextAncestor(node) {
    var current = node && node.parentElement;
    while (current) {
      var tagName = current.tagName ? current.tagName.toLowerCase() : "";
      if (tagName === "rt" || tagName === "rp" || tagName === "script" || tagName === "style") return true;
      current = current.parentElement;
    }
    return false;
  }

  function getVisibleTextNodes(doc) {
    var root = doc.body || doc.documentElement;
    if (!root) return [];
    var nf = doc.defaultView ? doc.defaultView.NodeFilter : NodeFilter;
    var walker = doc.createTreeWalker(root, nf.SHOW_TEXT, {
      acceptNode: function (n) {
        if (hasExcludedTextAncestor(n)) return nf.FILTER_REJECT;
        return cleanContextText(n.textContent || "") ? nf.FILTER_ACCEPT : nf.FILTER_REJECT;
      }
    });
    var nodes = [];
    var n = walker.nextNode();
    while (n) { nodes.push(n); n = walker.nextNode(); }
    return nodes;
  }

  function takeLastCharacters(text, maxLen) { return Array.from(text).slice(-maxLen).join(""); }
  function takeFirstCharacters(text, maxLen) { return Array.from(text).slice(0, maxLen).join(""); }

  function buildBeforeFromVisibleTextNodes(nodes, nodeIndex, utf16Offset) {
    var before = cleanContextText((nodes[nodeIndex].textContent || "").slice(0, utf16Offset));
    for (var i = nodeIndex - 1; i >= 0 && Array.from(before).length < DICT_CONTEXT_RADIUS; i--) {
      before = cleanContextText(nodes[i].textContent || "") + before;
    }
    return takeLastCharacters(before, DICT_CONTEXT_RADIUS);
  }

  function buildAfterFromVisibleTextNodes(nodes, nodeIndex, utf16Offset) {
    var after = cleanContextText((nodes[nodeIndex].textContent || "").slice(utf16Offset));
    var maxLen = DICT_CONTEXT_RADIUS + 1;
    for (var i = nodeIndex + 1; i < nodes.length && Array.from(after).length < maxLen; i++) {
      after += cleanContextText(nodes[i].textContent || "");
    }
    return takeFirstCharacters(after, maxLen);
  }

  function buildDictionaryPayload(node, utf16Offset) {
    var rawText = node.textContent || "";
    var character = getUnicodeCharacterAtUtf16Offset(rawText, utf16Offset);
    if (!isDictionaryCharacter(character) || hasExcludedTextAncestor(node)) return null;
    var ownerDoc = node.ownerDocument || document;
    var visNodes = getVisibleTextNodes(ownerDoc);
    var nodeIndex = visNodes.indexOf(node);
    if (nodeIndex < 0) return null;
    ownerDoc.__suzumeDictionaryHighlightAnchor = { node: node, utf16Offset: utf16Offset };
    var before = buildBeforeFromVisibleTextNodes(visNodes, nodeIndex, utf16Offset);
    var after = buildAfterFromVisibleTextNodes(visNodes, nodeIndex, utf16Offset);
    return { character: character, before: before, after: after, context: before + after };
  }

  function getRangeFromPoint(doc, x, y) {
    if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
    if (doc.caretPositionFromPoint) {
      var pos = doc.caretPositionFromPoint(x, y);
      if (!pos) return null;
      var r = doc.createRange();
      r.setStart(pos.offsetNode, pos.offset);
      r.collapse(true);
      return r;
    }
    return null;
  }

  function rectContainsPoint(rect, x, y) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  // Verify the character at [off, off+len) in node is rendered at (x, y).
  // Returns a tap action object or null (rect miss or empty offset).
  function checkCharAt(doc, text, node, off, x, y) {
    if (off < 0 || off >= text.length) return null;
    var ch = getUnicodeCharacterAtUtf16Offset(text, off);
    if (!ch) return null;
    var verify = doc.createRange();
    verify.setStart(node, off);
    verify.setEnd(node, off + ch.length);
    var rects = Array.from(verify.getClientRects());
    verify.detach && verify.detach();
    if (!rects.some(function(r) { return rectContainsPoint(r, x, y); })) return null;
    if (isDictionaryCharacter(ch)) {
      var payload = buildDictionaryPayload(node, off);
      return payload ? { action: "dict", payload: payload } : { action: "text" };
    }
    return { action: "text" };
  }

  // Classify a tap at (x, y) into one of three actions using caretRangeFromPoint only.
  // Returns { action: "dict", payload } | { action: "text" } | { action: "background" }
  //   "dict"       — visible Japanese character under tap; payload ready for SQLite lookup
  //   "text"       — visible non-lookupable text (punctuation, Latin, …); close dictionary
  //   "background" — no visible text at tap: empty zone, off-screen Foliate column, ruby
  //
  // caretRangeFromPoint returns a caret BOUNDARY between two characters, not a point
  // inside a character. For hollow glyphs (ロ, 口, 田…) tapping the hollow centre
  // places the caret AFTER the character (at its end = start of next char). We
  // therefore check both sides of the caret: the character starting at offset AND
  // the character ending at offset (offset - 1 for every BMP Japanese character).
  //
  // Off-screen adjacent-column characters are rejected in checkCharAt because their
  // rects lie outside the current viewport (x < 0 or x > W), never near (x, y).
  function classifyTap(doc, x, y) {
    var range = getRangeFromPoint(doc, x, y);
    var node = range && range.startContainer;
    var offset = range ? range.startOffset : -1;
    if (!node || node.nodeType !== Node.TEXT_NODE) return { action: "background" };
    if (hasExcludedTextAncestor(node)) return { action: "background" };
    var text = node.textContent || "";
    return checkCharAt(doc, text, node, offset, x, y)
        || (offset > 0 && checkCharAt(doc, text, node, offset - 1, x, y))
        || { action: "background" };
  }

  function getHighlightDocuments() {
    var docs = [];
    var contents = view.renderer.getContents();
    for (var i = 0; i < contents.length; i++) {
      var d = contents[i] && contents[i].doc;
      if (d && docs.indexOf(d) < 0) docs.push(d);
    }
    return docs;
  }

  function ensureDictionaryHighlightStyle(doc) {
    if (!doc || doc.getElementById("suzume-dictionary-highlight-style")) return;
    var style = doc.createElement("style");
    style.id = "suzume-dictionary-highlight-style";
    style.textContent = ".suzume-dictionary-highlight{background-color:rgba(90,70,40,0.14);box-shadow:0 0 0 1px rgba(90,70,40,0.14);border-radius:2px;-webkit-box-decoration-break:clone;box-decoration-break:clone;}";
    (doc.head || doc.documentElement).appendChild(style);
  }

  function unwrapDictionaryHighlight(hl) {
    var parent = hl.parentNode;
    if (!parent) return;
    while (hl.firstChild) parent.insertBefore(hl.firstChild, hl);
    parent.removeChild(hl);
    parent.normalize && parent.normalize();
  }

  function clearDictionaryHighlightInDocument(doc, options) {
    if (!doc) return;
    var hls = Array.from(doc.querySelectorAll(".suzume-dictionary-highlight"));
    for (var i = 0; i < hls.length; i++) unwrapDictionaryHighlight(hls[i]);
    if (!options || options.clearAnchor !== false) doc.__suzumeDictionaryHighlightAnchor = null;
  }

  function clearDictionaryHighlights() {
    var docs = getHighlightDocuments();
    for (var i = 0; i < docs.length; i++) clearDictionaryHighlightInDocument(docs[i]);
  }

  function clearDictionaryHighlightSpans() {
    var docs = getHighlightDocuments();
    for (var i = 0; i < docs.length; i++) clearDictionaryHighlightInDocument(docs[i], { clearAnchor: false });
  }

  function collectHighlightSegments(visNodes, nodeIndex, utf16Offset, surfaceLength) {
    var segments = [];
    var remaining = surfaceLength;
    for (var index = nodeIndex; index < visNodes.length && remaining > 0; index++) {
      var node = visNodes[index];
      var text = node.textContent || "";
      var chars = Array.from(text);
      var curOffset = 0;
      var segStart = null;
      var segEnd = null;
      for (var ci = 0; ci < chars.length; ci++) {
        var ch = chars[ci];
        var nextOffset = curOffset + ch.length;
        var isBeforeStart = index === nodeIndex && nextOffset <= utf16Offset;
        if (!isBeforeStart && remaining > 0) {
          if (segStart === null) segStart = Math.max(curOffset, utf16Offset);
          segEnd = nextOffset;
          if (!/\\s/.test(ch)) remaining--;
        }
        curOffset = nextOffset;
        if (remaining <= 0) break;
      }
      if (segStart !== null && segEnd !== null && segEnd > segStart) {
        segments.push({ node: node, start: segStart, end: segEnd });
      }
    }
    return remaining === 0 ? segments : [];
  }

  function wrapHighlightSegment(doc, seg) {
    var range = doc.createRange();
    range.setStart(seg.node, seg.start);
    range.setEnd(seg.node, seg.end);
    var hl = doc.createElement("span");
    hl.className = "suzume-dictionary-highlight";
    hl.setAttribute("data-suzume-dictionary-highlight", "true");
    hl.appendChild(range.extractContents());
    range.insertNode(hl);
    range.detach && range.detach();
  }

  function highlightDictionarySurface(surfaceText) {
    var matchedText = cleanContextText(surfaceText || "");
    clearDictionaryHighlightSpans();
    if (!matchedText) return;
    var docs = getHighlightDocuments();
    for (var di = 0; di < docs.length; di++) {
      var hDoc = docs[di];
      var anchor = hDoc.__suzumeDictionaryHighlightAnchor;
      if (!anchor || !anchor.node || !anchor.node.isConnected) continue;
      var visNodes = getVisibleTextNodes(hDoc);
      var nodeIndex = visNodes.indexOf(anchor.node);
      if (nodeIndex < 0) continue;
      var segments = collectHighlightSegments(
        visNodes, nodeIndex, anchor.utf16Offset, Array.from(matchedText).length
      );
      if (segments.length === 0) continue;
      ensureDictionaryHighlightStyle(hDoc);
      for (var si = segments.length - 1; si >= 0; si--) wrapHighlightSegment(hDoc, segments[si]);
      return;
    }
  }

  window.__suzumeClearDictionaryHighlight = clearDictionaryHighlights;
  window.__suzumeHighlightDictionaryMatch = highlightDictionarySurface;
  window.__suzumeSetDictionaryOpen = function(open) { isDictionaryOpen = !!open; };
  // ─────────────────────────────────────────────────────────────────────────

  function releasePaging(reason) {
    if (!isPaging) return;
    isPaging = false;
    if (pagingTimeoutId) {
      clearTimeout(pagingTimeoutId);
      pagingTimeoutId = null;
    }
    navLog(
      "[FOLIATE-NAV] paging released by " + reason +
      " action=" + (pendingNavAction || "?") +
      " sec=" + currentSectionIndex +
      " page=" + view.renderer.page + "/" + view.renderer.pages
    );
    pendingNavAction = null;
  }

  function attachTouchListeners(doc) {
    if (!doc || doc.__suzumeTouchAttached) return;
    doc.__suzumeTouchAttached = true;
    var t0X = 0, t0Y = 0;
    // Capture phase so our listeners fire before Foliate's bubbling listeners
    // (paginator.js registers touchstart/touchmove/touchend on the same
    // contentDocument). stopImmediatePropagation prevents Foliate's
    // #onTouchStart/#onTouchMove/#onTouchEnd from firing, which would otherwise
    // run a concurrent snap()/#goTo on the same swipe (no #locked guard in snap).
    doc.addEventListener("touchstart", function (e) {
      e.stopImmediatePropagation();
      var t = e.changedTouches[0];
      t0X = t.clientX;
      t0Y = t.clientY;
    }, { capture: true, passive: true });
    doc.addEventListener("touchmove", function (e) {
      e.stopImmediatePropagation();
    }, { capture: true, passive: true });
    doc.addEventListener("touchend", function (e) {
      e.stopImmediatePropagation();
      if (isMeasuring) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - t0X;
      var dy = t.clientY - t0Y;
      var absX = Math.abs(dx);
      var absY = Math.abs(dy);
      if (isDictionaryOpen) {
        if (absX <= TAP_MAX_PX && absY <= TAP_MAX_PX) {
          rnPost("dictionary-close", {});
        }
        // swipes and other gestures are silently ignored while dict is open
        return;
      }
      if (absX <= TAP_MAX_PX && absY <= TAP_MAX_PX) {
        var tapX = t.clientX;
        var tapY = t.clientY;
        clearDictionaryHighlights();
        var tap = classifyTap(doc, tapX, tapY);
        if (tap.action === "dict") {
          navLog("[FOLIATE-TOUCH] tap dictionary char=" + tap.payload.character);
          rnPost("dictionary-tap", tap.payload);
        } else if (tap.action === "text") {
          navLog("[FOLIATE-TOUCH] tap text (non-dict)");
          rnPost("dictionary-close", {});
        } else {
          navLog("[FOLIATE-TOUCH] tap background");
          rnPost("reader-background-tap", {});
        }
        return;
      }
      if (absX >= SWIPE_MIN_PX && absX >= absY * SWIPE_VERT_RATIO) {
        if (isPaging) {
          navLog("[FOLIATE-NAV] swipe ignored (isPaging)");
          return;
        }
        isPaging = true;
        pendingNavAction = dx > 0 ? "goLeft" : "goRight";
        navLog(
          "[FOLIATE-NAV] paging locked action=" + pendingNavAction +
          " sec=" + currentSectionIndex +
          " page=" + view.renderer.page + "/" + view.renderer.pages
        );
        // Primary release: the content-page relocate after navigation completes.
        // Fallback: 1000ms timeout in case Foliate emits no content relocate.
        pagingTimeoutId = setTimeout(function () {
          pagingTimeoutId = null;
          releasePaging("timeout");
        }, 1000);
        // Secondary: Promise resolves immediately for intra-section navigation.
        // For spine crossings it may not resolve — the relocate handler covers that.
        Promise.resolve(dx > 0 ? view.goLeft() : view.goRight())
          .then(function () { releasePaging("promise"); })
          .catch(function (e) {
            releasePaging("error");
            rnPost("log", "[FOLIATE-NAV] nav error: " + String(e));
          });
      }
    }, { capture: true, passive: true });
  }

  function attachToAllContents() {
    var contents = view.renderer.getContents();
    navLog("[FOLIATE-TOUCH] attached contents=" + contents.length);
    for (var i = 0; i < contents.length; i++) {
      attachTouchListeners(contents[i].doc);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Auto-open if the book base64 was pre-injected before page load.
  if (window.__BOOK_B64) {
    window.__openBook(window.__BOOK_B64);
  }
})();`;

export function buildFoliateHtml(): string {
	return [
		"<!DOCTYPE html>",
		"<html>",
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">',
		"<style>",
		"* { margin: 0; padding: 0; box-sizing: border-box; }",
		"html, body { width: 100%; height: 100%; overflow: hidden; background: #F1E2C9; }",
		"#fv { display: block; width: 100%; height: 100%; }",
		"</style>",
		"</head>",
		"<body>",
		'<foliate-view id="fv"></foliate-view>',
		"<script>",
		foliateBundle,
		"</script>",
		"<script>",
		BRIDGE,
		"</script>",
		"</body>",
		"</html>",
	].join("\n");
}
