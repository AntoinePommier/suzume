import { foliateBundle } from "./foliateBundle";

// Prototype flag — snapshot page-turn (capture + horizontal slide above the
// reader, see SnapshotPageTurn.tsx). Single source of truth: interpolated into
// the bridge below AND imported by foliate-reader.tsx. Set to false to restore
// the exact pre-prototype behavior (direct in-bridge navigation on swipe).
// Paused in favor of the ghost-iframe prototype below.
export const SNAPSHOT_PAGE_TURN_ENABLED = false;

// Prototype flag — ghost-iframe page-turn. A second iframe in the outer
// WebView document mirrors the current section (same blob, same styles) and
// plays the moving page surface: forward = current page slides out revealing
// the real next page; backward = previous page slides in over the current
// one, the real view swapping underneath at full cover. Bridge-only; set to
// false to restore instant turns. Both prototype flags must not be true at
// the same time (the ghost path takes precedence in the bridge if they are).
export const GHOST_PAGE_TURN_ENABLED = true;

// Reader layout tuning — THE single place to iterate on the visual base.
// Foliate defaults are margin 48px / gap 7% / UA font 16px, which reads
// small and over-padded next to iBooks. Every field here is optional:
// null = keep the Foliate/book default AND keep existing pagination caches
// valid (null fields are omitted from the layout cache key).
// Flow: embedded as window.__READER_LAYOUT in buildFoliateHtml (outside the
// BRIDGE template — no new interpolations), applied by the bridge to the
// real renderer (setAttribute margin/gap + setStyles for font CSS) and the
// SAME font CSS is injected into every ghost/adjacent document before
// style copy and strip measurement, so all surfaces stay in sync. Also
// imported by foliate-reader.tsx into ReaderLayoutProfile so any change
// re-measures pagination (cache key changes).
export const READER_LAYOUT = {
	// Percentage applied to the section root (html). 100 = book default
	// (16px in practice). 120 ≈ 19.2px, close to the iBooks feel.
	fontSizePercent: 145 as number | null,
	// Unitless body line-height. Keep null first: most books express
	// line-height as a ratio that scales with the font. Set (e.g. 1.7) only
	// if the post-change fp logs show a fixed px line-height that no longer
	// breathes.
	lineHeight: 1.68 as number | null,
	// Foliate margin attribute (px) — the header/footer rows; in vertical-rl
	// it also bounds the line length via documentElement padding. Default 48.
	marginPx: 28 as number | null,
	// Foliate gap attribute (%) — horizontal page padding in vertical-rl.
	// Default 7.
	gapPercent: 2.5 as number | null,
};

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
  // Prototype flags, mirrored from the RN build (single source:
  // SNAPSHOT_PAGE_TURN_ENABLED / GHOST_PAGE_TURN_ENABLED in foliateReaderHtml.ts).
  var SNAPSHOT_TURN = ${SNAPSHOT_PAGE_TURN_ENABLED};
  var GHOST_TURN = ${GHOST_PAGE_TURN_ENABLED};
  // Set true to enable verbose navigation/touch diagnostics in the RN console.
  var DEBUG_NAV = false;
  function navLog(msg) { if (DEBUG_NAV) rnPost("log", msg); }

  // Layout tuning injected by buildFoliateHtml (single source: READER_LAYOUT
  // in foliateReaderHtml.ts — also part of the RN pagination cache key).
  var READER_LAYOUT_CFG = window.__READER_LAYOUT || {};

  // User CSS shared by the real view (renderer.setStyles) and every
  // ghost/adjacent document (applyReaderCssTo): the surfaces MUST render
  // with the same font metrics as the real view, or their strip
  // measurements and the visual swap would diverge.
  function readerUserCss() {
    var rules = [];
    if (READER_LAYOUT_CFG.fontSizePercent != null) {
      rules.push("html { font-size: " + READER_LAYOUT_CFG.fontSizePercent + "%; }");
    }
    if (READER_LAYOUT_CFG.lineHeight != null) {
      rules.push("body { line-height: " + READER_LAYOUT_CFG.lineHeight + "; }");
    }
    return rules.join("\\n");
  }

  function applyReaderCssTo(doc) {
    var css = readerUserCss();
    if (!css || !doc || !doc.head) return;
    var el = doc.createElement("style");
    el.textContent = css;
    doc.head.appendChild(el);
  }

  // Tell RN a real page-turn gesture has started so it drops the chrome —
  // a swipe/drag returns the reader to fullscreen, while a tap toggles it.
  // Fired ONCE at the engagement of a turn (interactive drag of any mode,
  // or a release flick), never after the animation. Idempotent on the RN
  // side (setShowChrome(false) no-ops when already hidden), and it cannot
  // fire while the dictionary is open (swipes are short-circuited then).
  function notifyPageTurnGesture() {
    rnPost("reader-page-turn", {});
  }
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
          // Layout tuning (READER_LAYOUT): attributes feed Foliate's own
          // geometry (inline styles → inherited by the ghost style copy);
          // the font CSS goes through setStyles so every section doc gets
          // it, and the same CSS is injected into ghost/adjacent docs.
          // Applied BEFORE the first navigation/measurement so pagination
          // is always measured with these exact settings.
          if (READER_LAYOUT_CFG.marginPx != null) {
            view.renderer.setAttribute("margin", READER_LAYOUT_CFG.marginPx + "px");
          }
          if (READER_LAYOUT_CFG.gapPercent != null) {
            view.renderer.setAttribute("gap", READER_LAYOUT_CFG.gapPercent + "%");
          }
          var userCss = readerUserCss();
          if (userCss) view.renderer.setStyles(userCss);
          rnPost(
            "log",
            "[FOLIATE-SPIKE] layout applied margin=" +
              (READER_LAYOUT_CFG.marginPx != null ? READER_LAYOUT_CFG.marginPx + "px" : "default") +
              " gap=" +
              (READER_LAYOUT_CFG.gapPercent != null ? READER_LAYOUT_CFG.gapPercent + "%" : "default") +
              " fontSize=" +
              (READER_LAYOUT_CFG.fontSizePercent != null ? READER_LAYOUT_CFG.fontSizePercent + "%" : "default") +
              " lineHeight=" +
              (READER_LAYOUT_CFG.lineHeight != null ? READER_LAYOUT_CFG.lineHeight : "default")
          );

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
  // Shared navigation wiring (direct swipe path, snapshot prototype, ghost
  // prototype). Mirrors the original inline promise handling so isPaging is
  // released even when no content relocate fires (dedup edge case).
  // isPaging itself is locked by the caller (touchend swipe branch).
  function runTurnNav(action) {
    Promise.resolve(action === "goLeft" ? view.goLeft() : view.goRight())
      .then(function () { releasePaging("promise"); })
      .catch(function (e) {
        releasePaging("error");
        rnPost("log", "[FOLIATE-NAV] nav error: " + String(e));
      });
  }
  // Snapshot prototype entry point: RN triggers the real navigation once the
  // snapshot overlay is mounted above the reader.
  window.__turnNav = function (action) { runTurnNav(action); };
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
        // During measurement every relocate was suppressed (isMeasuring guard),
        // so lastRelocateKey still holds the key from the initial goToFraction(0)
        // before measurement. The post-measurement navigation often lands on the
        // same position → dedup would silently drop the relocated event, leaving
        // waitingForRestoreRef permanently true and the overlay stuck. Reset it so
        // the first post-measurement relocate always reaches RN.
        lastRelocateKey = null;
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
    if (GHOST_TURN) {
      // Drive the ghost state machine, or (re)build it for the new position.
      if (ghostState === "forward") ghostStartExit("relocate");
      else if (ghostState === "swap") ghostFinishSwap("relocate");
      else if (ghostState === "cancelF") ghostFinishCancelF("relocate");
      else if (ghostState === "xnavF" || ghostState === "xswapB") {
        ghostFinishCrossing("relocate");
      } else if (ghostState === "idle") {
        scheduleGhostBuild();
        scheduleAdjacentBuilds();
      }
      // dragF / dragB / exiting / cover / cancelB / settling: in-flight
      // relocates (early nav, stabilization) — nothing to drive.
    }
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
    // Style observability: timestamp only (passive). The style pulses that
    // briefly lived here forced getComputedStyle/getBoundingClientRect on
    // the section document DURING its load, before Foliate styled it — that
    // froze a WebKit text-autosizing boost into the real view (systematic
    // huge-font regression). Never probe the real doc's computed styles or
    // rects from this event.
    ghostSpineLoadT = Date.now();
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

  // ── ghost-iframe page turn (prototype, GHOST_PAGE_TURN_ENABLED) ──────────
  // A second iframe in the OUTER document (above Foliate's closed shadow DOM)
  // loads the same section blob as the real view and copies the exact inline
  // styles Foliate applied (columnize + expand + image sizing) — identical
  // layout by construction, no bitmap capture, always ready. It plays the
  // moving page surface of an iBooks-style turn:
  //   forward:  ghost = current page, mounted pixel-identical over the real
  //             view (invisible), the real view jumps to the next page
  //             underneath, then the ghost slides out following the finger.
  //   backward: ghost = previous page (same strip, different offset), slides
  //             in over the current page; at full cover the real view jumps
  //             underneath, then the ghost hides — an invisible swap.
  // Spine crossings are animated through a SECOND, reusable surface (the
  // "adjacent" ghost) preloaded with the neighbour section whenever the
  // reader sits on a boundary page. Navigation is LATE in both directions —
  // nothing is ever destroyed under the finger (the early-nav crossing
  // experiment was reverted as structurally flawed):
  //   crossing forward:  main ghost (current page) is the moving panel; the
  //             adjacent surface (next section, page 1) sits fully covering
  //             the real view UNDERNEATH; the real nav fires only once the
  //             panel has fully exited, hidden by the adjacent cover.
  //   crossing backward: the adjacent surface (previous section, LAST page)
  //             is itself the moving panel arriving over the current page;
  //             the real nav fires at full cover. Cancels never navigate.
  // Unsupported cases (sentinel state, surfaces not ready or busy,
  // horizontal books, missing pagination cache for backward crossings) fall
  // back to the instant navigation path, with the reason logged.
  // Everything is pointer-events:none; Foliate itself is never modified.
  var GHOST_HOLD_MS = 50;             // spans WKWebView stale-tile frames
  var GHOST_RELOCATE_FALLBACK_MS = 700;
  // Crossing navs land asynchronously (section load + columnize): give the
  // landing relocate more room before force-finishing under the cover.
  var GHOST_CROSSING_FALLBACK_MS = 1800;
  var GHOST_BUILD_DEBOUNCE_MS = 300;
  var GHOST_DIM = 0.22;               // max dim opacity under/around the ghost
  var GHOST_PAGE_RADIUS_PX = 50;      // ghost page corner radius (all corners)
  // Interactive drag (1:1 finger tracking):
  var GHOST_DRAG_ENGAGE_PX = 12;      // min horizontal travel to start dragging
  var GHOST_DRAG_AXIS_RATIO = 1.2;    // |dx| must beat |dy| * ratio at engage
  var GHOST_COMMIT_RATIO = 0.3;       // progress beyond which release commits
  var GHOST_FLICK_VX = 0.5;           // px/ms; a flick overrides the ratio
  // ── duration model (two knobs) ────────────────────────────────────────────
  // GHOST_TURN_MS    : time for a FULL-width travel. Visually: how long the
  //                    page takes to cross the whole screen when released at
  //                    the very start (or in release-triggered turns).
  // GHOST_FINISH_MIN_MS : floor of the finishing glide after release. When
  //                    the remaining distance is small (released near the
  //                    edge, or a committed flick), the page still glides
  //                    for at least this long instead of snapping shut.
  // duration = max(FINISH_MIN, TURN_MS × remainingDistance / width).
  // Velocity never shortens the finish; and since ANY in-flight turn can be
  // fast-completed by the next gesture, long durations never slow flipping.
  var GHOST_TURN_MS = 400;
  var GHOST_FINISH_MIN_MS = 200;
  // Easing is split by the MOTION of the panel, not by goLeft/goRight (the
  // forward/backward decision is already derived from the reading direction,
  // so these apply correctly in both RTL and LTR books):
  // GHOST_EASE_DEPART : a page LEAVING the screen — forward commit/turn and
  //                     backward cancel — accelerates away like a page let go.
  // GHOST_EASE_ARRIVE : a page ARRIVING over the screen — backward
  //                     commit/turn and forward cancel — decelerates into
  //                     place with a soft landing.
  // ARRIVE is the exact time-mirror of DEPART (CSS ease-out reverses
  // ease-in), so both directions read at the same perceived speed. Beware of
  // stronger curves here: expo-out, cubic-bezier(0.16, 1, 0.3, 1), covers
  // half the distance in the first 8 percent of the duration — the arriving
  // page looked near-instant next to the departing one. A slightly softer
  // landing that stays readable: cubic-bezier(0.33, 1, 0.68, 1).
  var GHOST_EASE_DEPART = "ease-in";
  var GHOST_EASE_ARRIVE = "ease-out";
  // A new gesture caught while a purely cosmetic finish is still playing
  // (exiting / cancelB: their navigation is already settled) rushes it to
  // completion over this duration instead of snapping it away — the
  // departing page visibly finishes its travel, it never teleports.
  var GHOST_RUSH_MS = 90;
  var ghostClip = null;   // full-viewport moving panel (page background)
  var ghostMask = null;   // container-sized window clipping the strip
  var ghostFrame = null;  // iframe holding the section strip
  var ghostFoot = null;   // page number carried by the panel (covers real foot)
  var ghostDim = null;    // dim layer between the real view and the ghost
  var ghostReady = false;
  var ghostBuilding = false;
  var ghostSection = -1;  // section currently loaded in the ghost
  // Adjacent surfaces (spine crossings): TWO independent clip/mask/frame/
  // foot stacks, one per direction, so dual-boundary pages (single-content-
  // page sections, where both crossings are possible) animate both ways:
  //   adjNext — next section, page 1; plays UNDER the main panel (forward
  //             crossing, z below the dim);
  //   adjPrev — previous section, LAST page; IS the moving panel (backward
  //             crossing, z above everything).
  // Each surface is built whenever its own boundary condition holds and is
  // unloaded otherwise; on normal boundary pages only one of them is active.
  function makeAdjacentState(role, delta) {
    return {
      role: role,
      delta: delta,
      clip: null, mask: null, frame: null, foot: null,
      ready: false,
      building: false,
      section: -1,   // section currently loaded
      pages: 0,      // its content page count (replicates expand() math)
      timerId: null,
      seq: 0,        // invalidates builds that complete after a move
      loadingSec: -1, // section an in-flight build is loading
      buildT0: 0,    // when that build started (for buildingForMs logs)
      failSec: -1,   // failure backoff (avoid hammering a broken section)
      failCount: 0,
    };
  }
  var adjNext = makeAdjacentState("next", 1);
  var adjPrev = makeAdjacentState("prev", -1);
  // Direction of the last committed crossing (+1/-1): on dual boundaries
  // the continue-direction surface is built first (arriving backward makes
  // another backward step the likely next gesture). Both always build.
  var lastCrossingDelta = 0;
  // The surface a turn currently moves: ghostClip (intra-section + crossing
  // forward) or adjPrev.clip (crossing backward). ghostSetClip and
  // ghostAnimateClipTo always drive this one.
  var ghostMover = null;
  // idle | forward | exiting | cover | swap | settling     (intra pipeline)
  // dragF | dragB | cancelF | cancelB                      (intra drag)
  // dragXF | xexitF | xnavF | xcancelF                     (crossing forward)
  // dragXB | xcoverB | xswapB | xcancelB                   (crossing backward)
  var ghostState = "idle";
  var ghostExitDir = 1;
  var ghostTimerId = null;
  var ghostBuildTimerId = null;
  // Active drag descriptor or null:
  // { mode:"f"|"b", action, reverseAction, fingerDir, width, offset,
  //   lastX, lastT, vx }
  var ghostDrag = null;
  // Invalidates pending finish callbacks when a finishing animation is
  // interrupted by a new drag (rapid page flipping).
  var ghostAnimSeq = 0;
  // Where the panel is heading (last set/animate target) and what should run
  // when it gets there — lets a rush re-issue the same travel with a much
  // shorter duration without changing the pipeline that follows.
  var ghostAnimTarget = 0;
  var ghostAnimDone = null;
  var ghostRushing = false;
  // ── nav debt (étape 2: single owner) ──────────────────────────────────────
  // At most ONE navigation can be owed at any time. Pipelines OWE it
  // (ghostOweNav), and everything that used to run its own retry loop is
  // now just a delivery strategy for THE debt: settle (one verified
  // attempt), pipeline retry (while a state holds), idle flush retry.
  // The key change vs the distributed model: when a delivery strategy dies
  // (its state ends, a new gesture takes over), the debt is INHERITED by
  // the next settle point instead of being dropped — a swipe whose nav was
  // still locked is never swallowed anymore (the old silent retry aborts
  // and the loud "flushed nav LOST (superseded)" both became inheritance).
  var ghostNavDebt = null; // { action, label } or null
  var ghostDebtTimerId = null;

  var ghostLogT0 = Date.now();
  function ghostLog(msg) {
    rnPost("log", "[GHOST +" + (Date.now() - ghostLogT0) + "] " + msg);
  }

  // ── style observability (diagnostic only, no behavior change) ────────────
  // Investigating the intermittent "huge font" after fast swipe chains: is
  // the wrong page the REAL Foliate view (spine styles not applied when a
  // retried nav landed) or a ghost/adjacent surface left visible with
  // incomplete copied styles? These probes make both cases distinguishable
  // in the logs without touching any timing.
  var ghostSpineLoadT = 0;

  function ghostSinceLoad() {
    return ghostSpineLoadT ? (Date.now() - ghostSpineLoadT) + "ms" : "n/a";
  }

  // Compact computed-style fingerprint of a content document: enough to see
  // a font-size/writing-mode/sizing divergence at a glance.
  // ONLY for GHOST/ADJACENT documents (ours, fully loaded strips). Never
  // call it on the REAL section document around load/landing: it forces
  // style+layout resolution, and doing that on a not-yet-styled section
  // document froze a WebKit text-autosizing boost into the real view
  // (systematic huge-font regression, 2026-06-12).
  function ghostStyleFp(doc) {
    try {
      if (!doc || !doc.body || !doc.defaultView) return "no-doc";
      var cs = doc.defaultView.getComputedStyle(doc.body);
      var de = doc.documentElement;
      var r = de.getBoundingClientRect();
      return "fs=" + cs.fontSize +
        " lh=" + cs.lineHeight +
        " wm=" + cs.writingMode +
        " html=" + Math.round(r.width) + "x" + Math.round(r.height) +
        " css=" + (de.style.cssText ? de.style.cssText.length : 0);
    } catch (e) { return "fp-err"; }
  }

  // R1 — the only readiness signal we trust for the real section document:
  // Foliate styles every paginated section by writing inline styles on its
  // documentElement (columnize/expand, resolved px values). Reading
  // style.cssText is a PASSIVE object read — it forces no layout, so it is
  // safe at any time, unlike computed styles/rects which froze a WebKit
  // text-autosizing boost into not-yet-styled documents. Builders defer on
  // this gate (logged + rescheduled) instead of racing the styling window.
  function ghostRealDocStyled(doc) {
    try {
      return !!(doc && doc.documentElement && doc.documentElement.style.cssText);
    } catch (e) { return false; }
  }

  // R2 — writing-mode is a property of the BOOK (publisher CSS, identical
  // across sections in practice): computed ONCE from a styled section
  // document, then memoized for the whole session. The per-build
  // getComputedStyle on a possibly fresh doc was the last forced-layout
  // read left in the builders.
  var ghostBookWm = "";
  function ghostWritingMode(doc) {
    if (ghostBookWm) return ghostBookWm;
    if (!ghostRealDocStyled(doc)) return "";
    var wm = "";
    try { wm = doc.defaultView.getComputedStyle(doc.body).writingMode || ""; } catch (e) {}
    if (wm) {
      ghostBookWm = wm;
      ghostLog("book writing-mode memoized: " + wm);
    }
    return wm;
  }

  // Style-readiness of the REAL frame. Post-expand() invariant for vertical
  // books: Foliate sets documentElement height to exactly ONE page (size)
  // via inline style.
  // NO AUTOMATIC CALL SITES — calling this at spine-load (and within the
  // landing window) CAUSED the systematic huge-font regression: the forced
  // layout on the unstyled section document baked a WebKit text-autosizing
  // boost into the real view. Kept for MANUAL use from the inspector only,
  // on a long-settled page.
  function ghostRealStylePulse(tag) {
    var info = getRealFrame();
    if (!info) {
      ghostLog("real style pulse (" + tag + "): frame unavailable");
      return false;
    }
    var size = view.renderer.size;
    var h = 0;
    var styled = false;
    try {
      h = info.doc.documentElement.getBoundingClientRect().height;
      styled = !!info.doc.documentElement.style.cssText;
    } catch (e) {}
    var stable = styled && size > 0 && Math.abs(h - size) <= 2;
    ghostLog(
      "real style " + (stable ? "stable" : "UNSTABLE") + " (" + tag + ")" +
      " size=" + size + " " + ghostStyleFp(info.doc)
    );
    return stable;
  }

  // Leak detector: at idle every surface must be hidden and the dim clear.
  // A visible surface here IS a candidate for the huge-font page — its
  // fingerprint is logged so the font size of the leaked strip is on record.
  function ghostAuditSurfaces(tag) {
    if (!ghostClip) return;
    var leaks = [];
    function chk(name, clipEl, frameEl) {
      if (!clipEl) return;
      if (clipEl.style.visibility !== "hidden") {
        var fp = frameEl && frameEl.contentDocument
          ? ghostStyleFp(frameEl.contentDocument) : "?";
        leaks.push(
          name + "(z=" + clipEl.style.zIndex +
          " tf=" + clipEl.style.transform + " " + fp + ")"
        );
      }
    }
    chk("ghost", ghostClip, ghostFrame);
    chk("next", adjNext.clip, adjNext.frame);
    chk("prev", adjPrev.clip, adjPrev.frame);
    if (ghostDim && ghostDim.style.opacity !== "0") {
      leaks.push("dim(op=" + ghostDim.style.opacity + ")");
    }
    if (leaks.length) {
      ghostLog("SURFACE LEAK (" + tag + ") state=" + ghostState + ": " + leaks.join(" "));
    }
  }

  // ── verified navigation ───────────────────────────────────────────────────
  // Foliate's #turnPage silently DROPS a navigation while its internal
  // #locked flag is held — and it stays held for ~100ms PAST the landing
  // relocate of a crossing (longer with the section load). A fast swipe
  // right after a crossing therefore used to fire a nav into the void: our
  // promise resolved, no relocate, and the ghost revealed the SAME page
  // ("page repeated" bug). Every ghost-driven intra nav now verifies
  // delivery: the page index changes synchronously inside runTurnNav on
  // success — if it did not move, the nav was dropped.
  function ghostNavAttempt(action) {
    var p0 = view.renderer.page;
    var s0 = currentSectionIndex;
    runTurnNav(action);
    return view.renderer.page !== p0 || currentSectionIndex !== s0;
  }

  function ghostStopDebtRetry() {
    if (ghostDebtTimerId) { clearInterval(ghostDebtTimerId); ghostDebtTimerId = null; }
  }

  // Record the single owed nav. Replacing a live debt loses a turn — that
  // should be near-impossible (it needs a third gesture inside the ~300ms
  // a debt can live), so it is logged loudly instead of being designed for.
  function ghostOweNav(action, label) {
    if (ghostNavDebt) {
      ghostLog(
        "NAV DEBT REPLACED (" + ghostNavDebt.label + " -> " + label +
        ") — one turn lost"
      );
    }
    ghostStopDebtRetry();
    ghostNavDebt = { action: action, label: label, t: Date.now() };
  }

  // Hand the autocross safety debt over to the commit pipeline of the SAME
  // turn: ghostAutoCross owes the nav at mount (so a teardown before the
  // 2-rAF commit still flushes it), then its own commit pipeline takes the
  // same action over two frames later. That is a re-label, not a
  // replacement — logging it as REPLACED ("one turn lost") was wrong,
  // nothing is lost. A debt from any OTHER origin still goes through
  // ghostOweNav and its loud replacement log.
  function ghostOweOrHandoff(action, label) {
    if (
      ghostNavDebt &&
      ghostNavDebt.action === action &&
      ghostNavDebt.label === "autocross"
    ) {
      ghostNavDebt.label = label;
      return;
    }
    ghostOweNav(action, label);
  }

  // One verified delivery attempt of THE debt. Intra navs are verified
  // synchronously; a debt whose action would CROSS from the current
  // position is delivered raw exactly once (crossing navs are async — a
  // sync check would read "dropped" and a retry would double-navigate).
  // The context argument is given by the INHERITANCE settle points (engage
  // / drag move / turn entry) so a paid inherited debt is visible in the
  // logs; the retry loops pass nothing (they have their own landed logs).
  function ghostSettleNavDebt(context) {
    var debt = ghostNavDebt;
    if (!debt) return true;
    // Inheritance is meant for rapid gesture chains (a debt lives ~300ms
    // under retries). Paying one long after it was owed would be a
    // surprise turn (e.g. user tapped and read meanwhile, next swipe would
    // jump two pages) — beyond this age the old "drop loudly" wins.
    var age = Date.now() - debt.t;
    if (age > 1500) {
      ghostNavDebt = null;
      ghostStopDebtRetry();
      ghostLog("debt expired unpaid (" + debt.label + ", age=" + age + "ms)");
      return true;
    }
    var p = view.renderer.page;
    var ps = view.renderer.pages;
    var fwd = bookDir === "rtl" ? debt.action === "goLeft" : debt.action === "goRight";
    var crossing =
      ps <= 2 || p < 1 || p > ps - 2 || (fwd ? p + 1 > ps - 2 : p - 1 < 1);
    if (crossing) {
      ghostNavDebt = null;
      ghostStopDebtRetry();
      ghostLog(
        "debt delivered raw (crossing) (" + debt.label + ")" +
        (context ? " at " + context : "")
      );
      runTurnNav(debt.action);
      return true;
    }
    if (ghostNavAttempt(debt.action)) {
      ghostNavDebt = null;
      ghostStopDebtRetry();
      if (context) {
        ghostLog("inherited debt paid (" + debt.label + ") at " + context);
      }
      return true;
    }
    return false;
  }

  // Retry THE debt while its owning pipeline state is still active (the
  // lock clears ~100ms later; 8 x 40ms covers it with margin). If the
  // pipeline is interrupted, the debt is inherited, not dropped.
  function ghostRetryNavWhile(label, stateName) {
    var attempts = 0;
    ghostStopDebtRetry();
    ghostDebtTimerId = setInterval(function () {
      if (!ghostNavDebt) { ghostStopDebtRetry(); return; }
      if (ghostState !== stateName) {
        ghostStopDebtRetry();
        ghostLog("debt inherited (" + label + ") — pipeline interrupted, owed nav kept");
        return;
      }
      attempts++;
      if (ghostSettleNavDebt()) {
        ghostLog("nav landed on retry " + attempts + " (" + label + ")");
      } else if (attempts >= 8) {
        ghostNavDebt = null;
        ghostStopDebtRetry();
        ghostLog("nav ABANDONED after " + attempts + " retries (" + label + ")");
      }
    }, 40);
  }

  // Flush THE debt (fast-complete / hide / direct fallback): one immediate
  // attempt, then retries while idle. A new gesture taking over no longer
  // loses the owed turn — it inherits it (settled at engage / turn entry /
  // drag moves).
  function ghostFlushDebt() {
    var debt = ghostNavDebt;
    if (!debt) return;
    if (ghostSettleNavDebt()) return;
    ghostLog("flushed nav dropped by foliate lock (" + debt.label + ") — retrying");
    var attempts = 0;
    ghostStopDebtRetry();
    ghostDebtTimerId = setInterval(function () {
      if (!ghostNavDebt) { ghostStopDebtRetry(); return; }
      if (ghostState !== "idle") {
        ghostStopDebtRetry();
        ghostLog("debt inherited (" + ghostNavDebt.label + ") by state=" + ghostState);
        return;
      }
      attempts++;
      if (ghostSettleNavDebt()) {
        // sinceLoad shows whether this retried nav landed on a freshly
        // loaded spine — correlate with style stability if fonts act up.
        ghostLog(
          "flushed nav landed on retry " + attempts + " (" + debt.label + ")" +
          " sinceLoad=" + ghostSinceLoad()
        );
      } else if (attempts >= 8) {
        ghostNavDebt = null;
        ghostStopDebtRetry();
        ghostLog("flushed nav LOST after " + attempts + " retries (" + debt.label + ")");
      }
    }, 40);
  }

  // The real iframe lives inside a closed shadow DOM, unreachable by query —
  // but walking UP from the contentDocument is allowed: defaultView.frameElement
  // is the iframe element itself, and its rect encodes the current scroll.
  // Its grandparent is Foliate's #container — the actual visible page area
  // (inset by the header/footer margin rows), whose overflow:hidden is what
  // clips neighbour pages in the real view. The ghost mask must match it.
  function getRealFrame() {
    var contents = view.renderer.getContents();
    if (!contents.length || !contents[0].doc) return null;
    var doc = contents[0].doc;
    var frameEl = null;
    try { frameEl = doc.defaultView ? doc.defaultView.frameElement : null; } catch (_) {}
    if (!frameEl) return null;
    var containerEl =
      frameEl.parentElement && frameEl.parentElement.parentElement
        ? frameEl.parentElement.parentElement
        : null;
    return {
      doc: doc,
      rect: frameEl.getBoundingClientRect(),
      containerRect: containerEl ? containerEl.getBoundingClientRect() : null,
    };
  }

  // One full page surface: clip (full-viewport moving panel, page bg, all
  // four corners rounded — only the trailing edge ever shows, so RTL keeps
  // its left rounding and LTR gets the mirrored right rounding for free) >
  // mask (real #container rect: clips neighbour pages of the strip exactly
  // like the real view) > strip iframe, plus a foot div carrying the page
  // number (the panel covers Foliate's real footer row, so it must show its
  // own — without it the footer area reads blank during covers).
  function makeGhostSurface(zIndex) {
    var clip = document.createElement("div");
    var c = clip.style;
    c.position = "fixed"; c.top = "0"; c.left = "0";
    c.width = "100%"; c.height = "100%";
    c.overflow = "hidden"; c.background = "#F1E2C9";
    c.visibility = "hidden"; c.pointerEvents = "none";
    c.zIndex = zIndex;
    c.borderRadius = GHOST_PAGE_RADIUS_PX + "px";
    var mask = document.createElement("div");
    var m = mask.style;
    m.position = "absolute"; m.overflow = "hidden";
    m.pointerEvents = "none";
    var frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin allow-scripts");
    frame.setAttribute("scrolling", "no");
    var f = frame.style;
    f.position = "absolute"; f.border = "0"; f.pointerEvents = "none";
    var foot = document.createElement("div");
    var ft = foot.style;
    ft.position = "absolute"; ft.pointerEvents = "none";
    mask.appendChild(frame);
    clip.appendChild(mask);
    clip.appendChild(foot);
    document.body.appendChild(clip);
    return { clip: clip, mask: mask, frame: frame, foot: foot };
  }

  function ensureGhostEls() {
    if (ghostClip) return;
    ghostDim = document.createElement("div");
    var d = ghostDim.style;
    d.position = "fixed"; d.top = "0"; d.left = "0";
    d.width = "100%"; d.height = "100%";
    d.background = "#000"; d.opacity = "0";
    d.pointerEvents = "none"; d.zIndex = "2147483600";
    document.body.appendChild(ghostDim);
    // Adjacent surfaces default to the "under" z (below the dim); a backward
    // crossing raises adjPrev above everything for the duration of the turn.
    var sn = makeGhostSurface("2147483599");
    adjNext.clip = sn.clip; adjNext.mask = sn.mask;
    adjNext.frame = sn.frame; adjNext.foot = sn.foot;
    var sp = makeGhostSurface("2147483599");
    adjPrev.clip = sp.clip; adjPrev.mask = sp.mask;
    adjPrev.frame = sp.frame; adjPrev.foot = sp.foot;
    var main = makeGhostSurface("2147483601");
    ghostClip = main.clip; ghostMask = main.mask;
    ghostFrame = main.frame; ghostFoot = main.foot;
    ghostMover = ghostClip;
  }

  // Copy the inline styles Foliate computed and applied to the real document
  // (columnize/expand set everything via element.style with resolved px
  // values) — this is what makes the ghost layout identical without
  // replicating any of Foliate's internal math.
  // withMedia: per-element media styles are copied by index, which is only
  // valid when the frame holds the SAME section as the real doc. The
  // adjacent surface holds a different section: it gets the generic geometry
  // (documentElement/body cssText is viewport-derived, identical across
  // sections) but its media keep their own styles — logged so image-heavy
  // boundary pages can be diagnosed if fidelity suffers.
  function copyStripStyles(frameEl, realDoc, withMedia) {
    var gdoc = frameEl.contentDocument;
    if (!gdoc || !gdoc.documentElement) return false;
    // REFUSE an unstyled source. The builders gate on this at entry, but
    // the blob load between the gate and this copy is async — a crossing
    // can swap the real spine mid-build (observed live: a next-build copied
    // from spine 12 while it was still loading). A copy from an empty
    // cssText would produce a raw-layout strip (the huge-font symptom);
    // returning false routes into the existing style-copy-failed retry
    // paths instead.
    if (!realDoc.documentElement.style.cssText) {
      ghostLog("style copy REFUSED: real doc inline css empty (not styled yet)");
      return false;
    }
    gdoc.documentElement.style.cssText = realDoc.documentElement.style.cssText;
    if (gdoc.body && realDoc.body) {
      gdoc.body.style.cssText = realDoc.body.style.cssText;
    }
    if (withMedia) {
      var a = realDoc.body ? realDoc.body.querySelectorAll("img, svg, video") : [];
      var b = gdoc.body ? gdoc.body.querySelectorAll("img, svg, video") : [];
      for (var i = 0; i < a.length && i < b.length; i++) {
        b[i].style.cssText = a[i].style.cssText;
      }
    } else if (gdoc.body) {
      var n = gdoc.body.querySelectorAll("img, svg, video").length;
      if (n > 0) ghostLog("adjacent media styles approximated n=" + n);
    }
    return true;
  }

  var ghostBuildFailSec = -1;
  var ghostBuildFailCount = 0;
  // In-flight load target of the main ghost build — an owner in the
  // section ledger (the old guards missed it: another surface could revoke
  // the blobs the ghost was loading).
  var ghostLoadingSec = -1;

  function scheduleGhostBuild() {
    if (!GHOST_TURN || isMeasuring) return;
    if (ghostBuildTimerId) clearTimeout(ghostBuildTimerId);
    ghostBuildTimerId = setTimeout(function () {
      ghostBuildTimerId = null;
      buildGhost();
    }, GHOST_BUILD_DEBOUNCE_MS);
  }

  function buildGhost() {
    if (!GHOST_TURN || isMeasuring) return;
    // Same retry rule as buildAdj: an in-flight build may be for a stale
    // section (we crossed meanwhile) — reschedule instead of bailing.
    if (ghostBuilding || ghostState !== "idle") { scheduleGhostBuild(); return; }
    if (ghostReady && ghostSection === currentSectionIndex) return;
    var info = getRealFrame();
    if (!info) {
      // Right after a crossing the section views may still be churning and
      // the real frame can be transiently unreachable. A silent bail here
      // stranded the main ghost on the OLD section until the next relocate
      // (cur=22 ghost=23 adj=23 — forward crossing stuck on ghost-not-ready).
      ghostLog("ghost build deferred (real frame unavailable) — retrying");
      scheduleGhostBuild();
      return;
    }
    if (!ghostRealDocStyled(info.doc)) {
      // R1 gate: the fresh spine has no inline styles yet. Probing its
      // computed styles/rects now is what bakes the WebKit font boost, and
      // a style copy from it would be empty — wait, observably.
      ghostLog("ghost build deferred (real doc not styled yet)");
      scheduleGhostBuild();
      return;
    }
    var wm = ghostWritingMode(info.doc);
    if (wm.indexOf("vertical") !== 0) {
      // Prototype gated to vertical writing — horizontal books keep instant
      // turns. Permanent for the book: no retry, the next relocate re-checks.
      ghostReady = false;
      ghostLog("ghost build skipped (writing-mode=" + (wm || "?") + ")");
      return;
    }
    var sec = currentSectionIndex;
    var prevSec = ghostSection;
    ghostBuilding = true;
    ghostLoadingSec = sec;
    ghostReady = false;
    ghostLog("ghost build start sec=" + sec + " (was " + prevSec + ")");
    ensureGhostEls();
    var t0 = Date.now();
    Promise.resolve(view.book.sections[sec].load())
      .then(function (src) {
        return new Promise(function (resolve, reject) {
          var done = false;
          ghostFrame.addEventListener("load", function onLoad() {
            ghostFrame.removeEventListener("load", onLoad);
            if (!done) { done = true; resolve(); }
          });
          ghostFrame.src = src;
          setTimeout(function () {
            if (!done) { done = true; reject(new Error("ghost-load-timeout")); }
          }, 4000);
        });
      })
      .then(function () {
        // Same user CSS as the real view (font size): without it the ghost
        // strip would render with the book's default metrics and the swap
        // would visibly change the text size.
        applyReaderCssTo(ghostFrame.contentDocument);
        var info2 = getRealFrame();
        if (!info2 || !copyStripStyles(ghostFrame, info2.doc, true)) {
          throw new Error("style-copy-failed");
        }
        ghostFrame.style.width = info2.rect.width + "px";
        ghostFrame.style.height = info2.rect.height + "px";
        // Wait for ghost webfonts (usually instant: same blob URLs as the
        // real view), capped so a stuck font never blocks readiness.
        var gdoc = ghostFrame.contentDocument;
        var fontsReady = gdoc && gdoc.fonts && gdoc.fonts.ready
          ? gdoc.fonts.ready : Promise.resolve();
        var cap = new Promise(function (resolve) { setTimeout(resolve, 800); });
        return Promise.race([fontsReady, cap]);
      })
      .then(function () {
        // Release the previous section blob through the ownership ledger —
        // it refuses while any other consumer (real view, landing crossing,
        // adjacent surface held/loading/wanted) still claims it.
        if (prevSec >= 0 && prevSec !== sec) {
          ghostReleaseSection(prevSec, "ghost", "rebuild");
        }
        ghostSection = sec;
        ghostBuilding = false;
        ghostLoadingSec = -1;
        ghostReady = true;
        ghostBuildFailSec = -1;
        ghostBuildFailCount = 0;
        // Ghost-side fingerprint ONLY. Probing the real doc here (computed
        // style / rects) is forbidden: this completion often runs ~50ms
        // after a crossing landing, inside the same styling window as the
        // font-boost regression (see ghostRealStylePulse).
        var gdocR = ghostFrame.contentDocument;
        ghostLog(
          "ready sec=" + sec + " in " + (Date.now() - t0) + "ms" +
          " ghost{" + (gdocR ? ghostStyleFp(gdocR) : "?") + "}"
        );
      })
      .catch(function (e) {
        ghostBuilding = false;
        ghostLoadingSec = -1;
        ghostReady = false;
        ghostLog("build failed: " + String(e && e.message ? e.message : e));
        // Same retry discipline as buildAdj: a transient failure (e.g. copy
        // REFUSED because a crossing swapped the real spine mid-build) must
        // not strand the ghost until a gesture falls back — but a
        // deterministic failure must not be hammered either.
        if (sec === ghostBuildFailSec) { ghostBuildFailCount++; }
        else { ghostBuildFailSec = sec; ghostBuildFailCount = 1; }
        if (ghostBuildFailCount <= 2) scheduleGhostBuild();
        else ghostLog("ghost build given up sec=" + sec + " (instant fallback)");
      });
  }

  // ── adjacent surface builds (spine crossings) ─────────────────────────────
  // Each surface has its own boundary condition — no preference rule, so a
  // single-content-page section (first AND last page at once) legitimately
  // desires BOTH neighbours and both crossings stay animable.
  function desiredSectionFor(A) {
    var p = view.renderer.page;
    var ps = view.renderer.pages;
    var total = view.book && view.book.sections ? view.book.sections.length : 0;
    if (ps <= 2 || p < 1 || p > ps - 2) return -1;
    if (A.delta > 0) {
      return p === ps - 2 && currentSectionIndex + 1 < total
        ? currentSectionIndex + 1 : -1;
    }
    return p === 1 && currentSectionIndex - 1 >= 0
      ? currentSectionIndex - 1 : -1;
  }

  // ── section ownership ledger (étape 3) ────────────────────────────────────
  // Single source of truth for who holds (or is about to hold) a section's
  // blobs: the real view ("real", plus "real:landing" while a crossing nav
  // is loading its target), the main ghost ("ghost", held or loading), the
  // adjacent surfaces ("next"/"prev", held or loading, plus ":want" for the
  // section their boundary currently desires). The epub.js loader does not
  // count beyond two top-level consumers, so EVERY bridge-side unload goes
  // through ghostReleaseSection exclusively — it refuses (logged) while any
  // other owner claims the section. Replaces sectionHeldElsewhere and the
  // scattered keep-conditions, which were subtly incomplete: none covered
  // the ghost's own in-flight load target, the landing target of a flying
  // crossing, or a currentSectionIndex that drifted during an async build.
  function ghostSectionOwners(sec, except) {
    var o = [];
    if (sec < 0) return o;
    function add(name, cond) {
      if (cond && name.indexOf(except) !== 0) o.push(name);
    }
    add("real", currentSectionIndex === sec);
    add(
      "real:landing",
      (ghostState === "xnavF" || ghostState === "xswapB") &&
        currentSectionIndex + lastCrossingDelta === sec
    );
    add("ghost", ghostSection === sec || ghostLoadingSec === sec);
    add("next", adjNext.section === sec || adjNext.loadingSec === sec);
    add("prev", adjPrev.section === sec || adjPrev.loadingSec === sec);
    add("next:want", desiredSectionFor(adjNext) === sec);
    add("prev:want", desiredSectionFor(adjPrev) === sec);
    return o;
  }

  function ghostReleaseSection(sec, who, reason) {
    if (sec < 0 || !view.book.sections[sec]) return;
    var owners = ghostSectionOwners(sec, who);
    if (owners.length) {
      ghostLog(
        "unload refused sec=" + sec + " by " + who + " (" + reason +
        ") — held by " + owners.join("+")
      );
      return;
    }
    try { view.book.sections[sec].unload(); } catch (e) {}
    ghostLog("section unloaded sec=" + sec + " by " + who + " (" + reason + ")");
  }

  function scheduleAdjBuild(A) {
    if (!GHOST_TURN || isMeasuring) return;
    if (A.timerId) clearTimeout(A.timerId);
    A.timerId = setTimeout(function () {
      A.timerId = null;
      buildAdj(A);
    }, GHOST_BUILD_DEBOUNCE_MS);
  }

  function logDualBoundary() {
    if (desiredSectionFor(adjNext) >= 0 && desiredSectionFor(adjPrev) >= 0) {
      ghostLog(
        "dual boundary: section " + currentSectionIndex +
        " has a single content page — preparing prev AND next"
      );
    }
  }

  function scheduleAdjacentBuilds() {
    logDualBoundary();
    scheduleAdjBuild(adjNext);
    scheduleAdjBuild(adjPrev);
  }

  // Immediate (no debounce) builds, continue-direction first. Used right
  // after a turn settles: the 300ms debounce was most of the window where a
  // quick consecutive crossing fell back on adjacent-not-ready.
  function buildAdjacentsNow() {
    logDualBoundary();
    var first = lastCrossingDelta < 0 ? adjPrev : adjNext;
    var second = first === adjPrev ? adjNext : adjPrev;
    buildAdj(first);
    buildAdj(second);
  }

  // Compact surface state for refusal/fallback logs: held section, plus the
  // in-flight build target and its age when not ready.
  function adjStateStr(A) {
    var s = A.role + "=" + (A.section >= 0 ? A.section : "-");
    if (!A.ready) {
      s += A.building
        ? "(building " + A.loadingSec + " for " +
          (Date.now() - A.buildT0) + "ms)"
        : "(nr)";
    }
    return s;
  }

  // Memory policy: a surface only holds a section while the reader sits on
  // its boundary page; anywhere else it is unloaded.
  function unloadAdj(A, reason) {
    var old = A.section;
    A.ready = false;
    A.section = -1;
    A.pages = 0;
    if (old >= 0) ghostReleaseSection(old, A.role, reason);
  }

  function buildAdj(A) {
    if (!GHOST_TURN || isMeasuring) return;
    // Never bail silently while something is in flight or busy: the
    // in-flight build may be for a stale target (we crossed meanwhile), and
    // without a retry nothing revalidates until the next intra relocate.
    if (A.building || ghostState !== "idle") { scheduleAdjBuild(A); return; }
    var target = desiredSectionFor(A);
    if (target < 0) {
      if (A.section >= 0) unloadAdj(A, "off-boundary");
      return;
    }
    if (A.ready && A.section === target) return;
    var info = getRealFrame();
    if (!info) {
      ghostLog("adjacent " + A.role + " build deferred (real frame unavailable) — retrying");
      scheduleAdjBuild(A);
      return;
    }
    if (!ghostRealDocStyled(info.doc)) {
      // R1 gate — same as buildGhost: never start a build (whose style copy
      // reads the real doc) while the fresh spine is still unstyled.
      ghostLog("adjacent " + A.role + " build deferred (real doc not styled yet)");
      scheduleAdjBuild(A);
      return;
    }
    var wm = ghostWritingMode(info.doc);
    if (wm.indexOf("vertical") !== 0) {
      A.ready = false;
      ghostLog("adjacent " + A.role + " build skipped (writing-mode=" + (wm || "?") + ")");
      return;
    }
    var prevSec = A.section;
    var seq = ++A.seq;
    A.building = true;
    A.ready = false;
    A.loadingSec = target;
    A.buildT0 = Date.now();
    ghostLog(
      "adjacent build start sec=" + target + " role=" + A.role +
      " (cur=" + currentSectionIndex +
      " p=" + view.renderer.page + "/" + view.renderer.pages + ")"
    );
    ensureGhostEls();
    var t0 = Date.now();
    Promise.resolve(view.book.sections[target].load())
      .then(function (src) {
        return new Promise(function (resolve, reject) {
          var done = false;
          A.frame.addEventListener("load", function onLoad() {
            A.frame.removeEventListener("load", onLoad);
            if (!done) { done = true; resolve(); }
          });
          A.frame.src = src;
          setTimeout(function () {
            if (!done) { done = true; reject(new Error("adjacent-load-timeout")); }
          }, 4000);
        });
      })
      .then(function () {
        // Same user CSS as the real view — MUST be in place before the
        // strip measurement below: the adjacent's page count is computed
        // from its own layout, which has to match the real rendering of
        // that section or crossings would land on mis-segmented pages.
        applyReaderCssTo(A.frame.contentDocument);
        var info2 = getRealFrame();
        if (!info2 || !copyStripStyles(A.frame, info2.doc, false)) {
          throw new Error("style-copy-failed");
        }
        A.frame.style.width = info2.rect.width + "px";
        var gdoc = A.frame.contentDocument;
        var fontsReady = gdoc && gdoc.fonts && gdoc.fonts.ready
          ? gdoc.fonts.ready : Promise.resolve();
        var cap = new Promise(function (resolve) { setTimeout(resolve, 800); });
        return Promise.race([fontsReady, cap]);
      })
      .then(function () {
        // Strip measurement replicates Foliate's expand() EXACTLY: after
        // expand, documentElement height is ONE page (its scrollHeight is
        // meaningless) — the strip length is the bounding rect of a Range
        // over the body contents, and pageCount = ceil(contentH / size).
        // The iframe holds CONTENT ONLY (Foliate centers it inside a wrapper
        // element two pages taller — that is where the sentinels live), so
        // content page k sits at iframe segment k-1.
        var gdoc = A.frame.contentDocument;
        if (!gdoc || !gdoc.body) throw new Error("no-body");
        var range = gdoc.createRange();
        range.selectNodeContents(gdoc.body);
        var contentH = range.getBoundingClientRect().height;
        var size = view.renderer.size;
        if (!size || !(contentH > 0)) throw new Error("content-empty");
        var measured = Math.ceil(contentH / size);
        if (measured < 1) throw new Error("adjacent-empty");
        A.frame.style.height = (measured * size) + "px";
        var cachePages = null;
        if (globalPagination) {
          var off = globalPagination.sectionOffsets;
          var next = off[target + 1];
          cachePages = next != null
            ? next - (off[target] || 0)
            : globalPagination.totalPages - (off[target] || 0);
        }
        if (prevSec >= 0 && prevSec !== target) {
          ghostReleaseSection(prevSec, A.role, "retarget");
        }
        A.pages = measured;
        A.section = target;
        A.building = false;
        A.loadingSec = -1;
        A.failSec = -1;
        A.failCount = 0;
        // The reader may have moved during the build (crossed again): a
        // completed build is only READY if it still matches the boundary we
        // are sitting on now; otherwise rebuild for the new position.
        if (seq !== A.seq || desiredSectionFor(A) !== target) {
          // Typical benign cause: a (fallback) navigation started while the
          // build was in flight — the renderer sits on a sentinel page and
          // desired reads -1; the landing reschedules a fresh build anyway.
          var why = seq !== A.seq
            ? "superseded by a newer build"
            : "position changed, desired now " + desiredSectionFor(A);
          A.ready = false;
          ghostLog(
            "adjacent " + A.role + " stale at completion sec=" + target +
            " (" + why + ") — rebuilding"
          );
          scheduleAdjBuild(A);
          return;
        }
        A.ready = true;
        // Adjacent-side fingerprint ONLY — same real-doc probing ban as the
        // main ghost's ready log.
        ghostLog(
          "adjacent ready sec=" + target +
          " role=" + A.role +
          " pages=" + measured +
          " contentH=" + Math.round(contentH) +
          " size=" + size +
          (cachePages != null ? " cache=" + cachePages : "") +
          " in " + (Date.now() - t0) + "ms" +
          (cachePages != null && cachePages !== measured
            ? " WARNING page-count-mismatch" : "") +
          " adj{" + (gdoc ? ghostStyleFp(gdoc) : "?") + "}"
        );
      })
      .catch(function (e) {
        A.building = false;
        A.ready = false;
        A.loadingSec = -1;
        ghostLog("adjacent " + A.role + " build failed: " + String(e && e.message ? e.message : e));
        // A failed build must not strand the boundary — but a section that
        // fails deterministically must not be hammered either: retry twice,
        // then leave it to the next relocate to reschedule.
        if (target === A.failSec) { A.failCount++; } else { A.failSec = target; A.failCount = 1; }
        if (A.failCount <= 2) scheduleAdjBuild(A);
        else ghostLog("adjacent " + A.role + " build given up sec=" + target + " (instant fallback)");
      });
  }

  // Strict validity of the surface serving the crossing about to run: right
  // section relationship for the EXACT requested delta, measured content,
  // not mid-build. delta: +1 forward (adjNext), -1 backward (adjPrev).
  function adjacentValidFor(delta) {
    var A = delta > 0 ? adjNext : adjPrev;
    return (
      A.ready && !A.building && A.pages >= 1 &&
      A.section === currentSectionIndex + delta
    );
  }

  // Place a surface for its crossing. The adjacent iframes hold CONTENT
  // ONLY (no sentinels — Foliate keeps those in the wrapper element), so
  // content page k sits at iframe segment k-1:
  //   adjNext — next section, page 1 → segment 0, full cover at translate 0,
  //             z below the dim ("under");
  //   adjPrev — previous section, LAST content page → segment pages-1, the
  //             surface itself is the moving panel, z above everything.
  function positionAdjacent(A) {
    if (!adjacentValidFor(A.delta)) return false;
    var info = getRealFrame();
    if (!info || !info.containerRect) return false;
    var size = view.renderer.size;
    var cr = info.containerRect;
    A.mask.style.left = cr.left + "px";
    A.mask.style.top = cr.top + "px";
    A.mask.style.width = cr.width + "px";
    A.mask.style.height = cr.height + "px";
    A.frame.style.left = (info.rect.left - cr.left) + "px";
    var segment = A.delta > 0 ? 0 : A.pages - 1;
    A.frame.style.top = (-(segment * size)) + "px";
    A.clip.style.zIndex = A.delta > 0 ? "2147483599" : "2147483602";
    var footText = "";
    if (globalPagination) {
      var off = globalPagination.sectionOffsets;
      footText = A.delta > 0
        ? String((off[A.section] || 0) + 1)
        : String(off[currentSectionIndex] || 0);
    }
    setSurfaceFoot(A.foot, footText);
    ghostLog(
      "adj position role=" + A.role +
      " sec=" + A.section +
      " cur=" + currentSectionIndex + " p=" + view.renderer.page + "/" + view.renderer.pages +
      " segment=" + segment + "/" + A.pages +
      " top=" + (-(segment * size)) + "px foot=" + (footText || "-")
    );
    return true;
  }

  // Place the ghost so it displays the real view's current page shifted by
  // deltaPages. The mask takes the real #container rect (the visible page
  // window); the strip iframe is positioned inside it. The real iframe rect
  // already encodes the current scroll offset — including the sentinel
  // offset — and page p+1 sits exactly one renderer.size further down.
  function positionGhost(deltaPages) {
    var info = getRealFrame();
    if (!info || !info.containerRect) return false;
    var size = view.renderer.size;
    var cr = info.containerRect;
    ghostMask.style.left = cr.left + "px";
    ghostMask.style.top = cr.top + "px";
    ghostMask.style.width = cr.width + "px";
    ghostMask.style.height = cr.height + "px";
    // Frame coordinates are relative to the mask.
    ghostFrame.style.left = (info.rect.left - cr.left) + "px";
    ghostFrame.style.top = (info.rect.top - cr.top - deltaPages * size) + "px";
    // Page number carried by the panel: the number of the page it displays
    // (current page + deltaPages — positionGhost always runs BEFORE any
    // navigation, so renderer.page is still the on-screen page).
    var footText = "";
    if (globalPagination) {
      var fp = view.renderer.page + deltaPages;
      if (fp >= 1 && fp <= view.renderer.pages - 2) {
        footText = String(
          (globalPagination.sectionOffsets[currentSectionIndex] || 0) + fp
        );
      }
    }
    setSurfaceFoot(ghostFoot, footText);
    return true;
  }

  // Mirror Foliate's real foot element onto a surface foot div: same rect,
  // same typography, given text. Rect and computed style are read live from
  // the held reference (the closed shadow root only blocks queries, not
  // references we already hold).
  function setSurfaceFoot(footDiv, text) {
    var feet = view.renderer.feet;
    var foot = feet && feet.length ? feet[0] : null;
    if (foot) {
      var fr = foot.getBoundingClientRect();
      var fs = window.getComputedStyle(foot);
      var ft = footDiv.style;
      ft.left = fr.left + "px";
      ft.top = fr.top + "px";
      ft.width = fr.width + "px";
      ft.height = fr.height + "px";
      ft.fontFamily = fs.fontFamily;
      ft.fontSize = fs.fontSize;
      ft.lineHeight = fs.lineHeight;
      ft.padding = fs.padding;
      ft.color = fs.color;
      ft.opacity = fs.opacity;
      ft.textAlign = fs.textAlign;
    }
    footDiv.textContent = foot ? text : "";
  }

  // Both drive ghostMover: the main panel for intra-section turns and
  // forward crossings, the adjacent surface for backward crossings.
  function ghostSetClip(x) {
    ghostAnimSeq++; // a direct set invalidates any pending finish callback
    ghostAnimTarget = x;
    ghostMover.style.transition = "none";
    ghostMover.style.transform = "translateX(" + x + "px)";
  }

  function ghostAnimateClipTo(x, ms, easing, doneCb) {
    var seq = ++ghostAnimSeq;
    var el = ghostMover;
    ghostAnimTarget = x;
    ghostAnimDone = doneCb;
    navLog("[GHOST] animate target=" + x + " ms=" + ms + " easing=" + easing);
    el.style.transition = "transform " + ms + "ms " + easing;
    el.style.transform = "translateX(" + x + "px)";
    var done = false;
    function finish() {
      el.removeEventListener("transitionend", finish);
      if (done || seq !== ghostAnimSeq) return;
      done = true;
      doneCb();
    }
    el.addEventListener("transitionend", finish);
    setTimeout(finish, ms + 80);
  }

  function resetAdjSurface(A) {
    if (!A.clip) return;
    A.clip.style.visibility = "hidden";
    A.clip.style.transition = "none";
    A.clip.style.transform = "translateX(0px)";
    A.clip.style.zIndex = "2147483599"; // back to the "under" default
  }

  function ghostHide() {
    if (ghostTimerId) { clearTimeout(ghostTimerId); ghostTimerId = null; }
    resetAdjSurface(adjNext);
    resetAdjSurface(adjPrev);
    ghostMover = ghostClip;
    if (ghostClip) {
      ghostClip.style.visibility = "hidden";
      ghostSetClip(0);
    }
    if (ghostDim) {
      ghostDim.style.transition = "none";
      ghostDim.style.opacity = "0";
    }
    // Safety net: a turn that still owes its navigation must never be
    // dropped silently (the page would not actually turn).
    if (ghostNavDebt && !ghostDebtTimerId) {
      // A debt whose retry timer is already running (started by the
      // fast-complete flush an instant ago) must not be re-flushed here.
      ghostLog("flushing pending nav on hide");
      ghostFlushDebt();
    }
    ghostDrag = null;
    ghostState = "idle";
    ghostRushing = false;
    // Follow the landed position: rebuild the main ghost if the section
    // changed, and re-evaluate the adjacent preload (both self-no-op).
    // Follow the landed position immediately — the builders are self-guarded
    // and self-rescheduling, so direct calls are safe and shave the 300ms
    // debounce off the window where a quick next crossing would fall back.
    if (ghostSection !== currentSectionIndex) buildGhost();
    buildAdjacentsNow();
    // Leak audit one frame later: hide is synchronous, so a surface visible
    // on the NEXT frame means something re-showed it after cleanup.
    requestAnimationFrame(function () {
      if (ghostState === "idle") ghostAuditSurfaces("post-hide");
    });
  }

  // Visible fast completion of a purely cosmetic finish (exiting / cancelB,
  // whose navigation is already settled): the panel completes its remaining
  // travel in GHOST_RUSH_MS instead of being snapped away. Used when a new
  // gesture starts while one of these is still playing — the next touchmoves
  // keep retrying the engage and pick it up as soon as the rush lands.
  function ghostRushFinish() {
    if (ghostRushing) return;
    ghostRushing = true;
    ghostLog("rush finish from " + ghostState);
    // Re-issue the same travel, much faster, keeping the pipeline that was
    // attached to it (plain hide for cosmetic finishes; the late crossing
    // nav for committed crossing finishes).
    var done = ghostAnimDone || ghostHide;
    // The dim finishes toward the same endpoint its slow transition had:
    // covering finishes (backward crossing commit, forward crossing cancel)
    // end dimmed, every other rushable finish ends clear.
    var dimTarget = ghostState === "xcoverB" || ghostState === "xcancelF"
      ? String(GHOST_DIM) : "0";
    ghostDim.style.transition = "opacity " + GHOST_RUSH_MS + "ms " + GHOST_EASE_DEPART;
    ghostDim.style.opacity = dimTarget;
    ghostAnimateClipTo(ghostAnimTarget, GHOST_RUSH_MS, GHOST_EASE_DEPART, done);
  }

  // Instantly resolve the in-flight turn so a new gesture can engage right
  // away. The owed navigation (backward commit, forward cancel) is flushed
  // under a snapped-to-cover panel within the SAME task as the new engage —
  // both composite in one frame, so the fast-forward itself is invisible.
  // This is what makes backward flipping as interruptible as forward.
  function ghostFastComplete() {
    if (ghostState === "idle") return;
    var from = ghostState;
    if (ghostNavDebt) {
      ghostSetClip(0); // full cover for the flushed navigation
      // relocate fires synchronously for intra-section navs; the hook
      // ignores it in these in-flight states, ghostHide cleans up after.
      ghostFlushDebt();
    }
    ghostLog("fast-complete from " + from);
    ghostHide();
  }

  // Forward: ghost mounts over the identical current page (invisible mount),
  // the real view jumps to the next page underneath, then the ghost slides
  // out following the finger and reveals it over a fading dim.
  function ghostForwardTurn(action, fingerDir) {
    if (!positionGhost(0)) return false;
    ghostState = "forward";
    ghostExitDir = fingerDir;
    // The nav below is deferred by two rAFs: until it fires it is "owed", so
    // a fast-complete interrupting this state must flush it (else the swipe
    // would be silently lost).
    ghostOweNav(action, "forward-turn");
    ghostSetClip(0);
    ghostClip.style.visibility = "visible";
    ghostDim.style.transition = "none";
    ghostDim.style.opacity = String(GHOST_DIM); // under the ghost, not yet visible
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (ghostState !== "forward") return;
        // Armed before the nav: the intra-section relocate fires synchronously
        // inside runTurnNav and must find the timer to clear.
        ghostTimerId = setTimeout(function () {
          ghostTimerId = null;
          ghostStartExit("timeout");
        }, GHOST_RELOCATE_FALLBACK_MS);
        if (!ghostSettleNavDebt()) {
          ghostLog("forward turn nav dropped by foliate lock — retrying");
          ghostRetryNavWhile("forward-turn", "forward");
        }
      });
    });
    return true;
  }

  function ghostStartExit(reason) {
    if (ghostState !== "forward") return;
    ghostState = "exiting";
    if (ghostTimerId) { clearTimeout(ghostTimerId); ghostTimerId = null; }
    ghostLog("forward slide by " + reason);
    setTimeout(function () {
      if (ghostState !== "exiting") return;
      ghostDim.style.transition = "opacity " + GHOST_TURN_MS + "ms " + GHOST_EASE_DEPART;
      ghostDim.style.opacity = "0";
      ghostAnimateClipTo(
        ghostExitDir * window.innerWidth,
        GHOST_TURN_MS,
        GHOST_EASE_DEPART,
        function () { ghostHide(); }
      );
    }, GHOST_HOLD_MS);
  }

  // Backward: ghost shows the previous page and slides in over the current
  // one (the real view does not move yet); at full cover the real view jumps
  // underneath, then the ghost hides — an invisible swap.
  function ghostBackwardTurn(action, fingerDir) {
    if (!positionGhost(-1)) return false;
    ghostState = "cover";
    // The previous page enters from the edge opposite the finger motion and
    // travels with the finger (RTL: swipe left → enters from the right).
    ghostOweNav(action, "backward-turn");
    ghostSetClip(-fingerDir * window.innerWidth);
    ghostClip.style.visibility = "visible";
    ghostDim.style.transition = "opacity " + GHOST_TURN_MS + "ms " + GHOST_EASE_ARRIVE;
    ghostDim.style.opacity = String(GHOST_DIM);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (ghostState !== "cover") return;
        ghostAnimateClipTo(0, GHOST_TURN_MS, GHOST_EASE_ARRIVE, function () {
          if (ghostState !== "cover") return;
          ghostState = "swap";
          // Fully covered: the dim is invisible now, drop it instantly so it
          // does not pop over the new page when the ghost hides.
          ghostDim.style.transition = "none";
          ghostDim.style.opacity = "0";
          // Armed before the nav: the intra-section relocate fires
          // synchronously inside runTurnNav and must find the timer to clear.
          ghostTimerId = setTimeout(function () {
            ghostTimerId = null;
            ghostFinishSwap("timeout");
          }, GHOST_RELOCATE_FALLBACK_MS);
          if (!ghostSettleNavDebt()) {
            ghostLog("backward swap nav dropped by foliate lock — retrying");
            ghostRetryNavWhile("backward-turn", "swap");
          }
        });
      });
    });
    return true;
  }

  function ghostFinishSwap(reason) {
    if (ghostState !== "swap") return;
    if (ghostTimerId) { clearTimeout(ghostTimerId); ghostTimerId = null; }
    // The real view has landed: the remaining hold only spans stale-tile
    // frames. "settling" is interruptible, so an immediate next swipe can
    // engage right away instead of being dropped (forward/backward parity).
    ghostState = "settling";
    setTimeout(function () {
      if (ghostState !== "settling") return;
      ghostLog("backward swap by " + reason);
      ghostHide();
    }, GHOST_HOLD_MS);
  }

  // ── interactive 1:1 drag ──────────────────────────────────────────────────
  // The touch handlers and the ghost live in the same JS context, so the
  // panel tracks the finger with direct style writes — no postMessage, no
  // bridge latency. Forward drags navigate EARLY (at engage, while the ghost
  // still covers all but a few px): the area progressively revealed beneath
  // is the real next page. Both the ghost mount and the scrollTop jump run
  // in the same task, so they composite in the same frame (atomic swap).
  // Backward drags navigate LATE (at full cover on commit) — cancelling a
  // backward drag therefore costs nothing; cancelling a forward drag
  // navigates back underneath the re-covering ghost.

  // Animability check at engage time; returns a drag descriptor or null.
  // Intra-section turns need the main ghost (current section); crossings
  // need the adjacent surface loaded with the right neighbour — forward
  // crossings need BOTH (main panel exits over the adjacent cover).
  function ghostDragEligible(dx) {
    if (!GHOST_TURN || isDictionaryOpen || isMeasuring || isPaging) return null;
    if (ghostState !== "idle") return null;
    var forward = bookDir === "rtl" ? dx > 0 : dx < 0;
    var p = view.renderer.page;
    var ps = view.renderer.pages;
    if (ps <= 2 || p < 1 || p > ps - 2) return null;
    var ghostOk = ghostReady && ghostSection === currentSectionIndex;
    var mode = null;
    if (forward && p + 1 > ps - 2) {
      if (ghostOk && adjacentValidFor(1)) mode = "xf";
    } else if (!forward && p - 1 < 1) {
      if (adjacentValidFor(-1)) mode = "xb";
    } else if (ghostOk) {
      mode = forward ? "f" : "b";
    }
    if (!mode) return null;
    var action = dx > 0 ? "goLeft" : "goRight";
    return {
      mode: mode,
      fwd: forward,
      cross: mode === "xf" || mode === "xb",
      action: action,
      reverseAction: action === "goLeft" ? "goRight" : "goLeft",
      fingerDir: dx > 0 ? 1 : -1,
      width: window.innerWidth,
      offset: 0,
      lastX: 0,
      lastT: 0,
      vx: 0,
      // mode "f" only: whether the early nav actually landed (Foliate may
      // silently drop it while its post-crossing lock is held).
      navDone: false,
    };
  }

  // Clamp the panel offset to the meaningful range of the gesture.
  function ghostClampOffset(d, dx) {
    if (d.fwd) {
      // From rest (0) toward the exit edge (fingerDir * width).
      return d.fingerDir > 0
        ? Math.max(0, Math.min(d.width, dx))
        : Math.min(0, Math.max(-d.width, dx));
    }
    // Backward: from the entry edge (-fingerDir * width) toward rest (0).
    var entry = -d.fingerDir * d.width;
    var o = entry + dx;
    return entry > 0
      ? Math.max(0, Math.min(entry, o))
      : Math.min(0, Math.max(entry, o));
  }

  // 0 = turn not started, 1 = turn visually complete.
  function ghostDragProgress(d) {
    return d.fwd
      ? Math.abs(d.offset) / d.width
      : 1 - Math.abs(d.offset) / d.width;
  }

  function ghostDragApply(d, dx) {
    d.offset = ghostClampOffset(d, dx);
    ghostSetClip(d.offset);
    var pr = ghostDragProgress(d);
    // forward: dim sits on the revealed page beneath (real next page or the
    // adjacent cover) and fades as the turn completes; backward: dim grows
    // on the current page as the arriving panel covers it.
    ghostDim.style.transition = "none";
    ghostDim.style.opacity =
      String(GHOST_DIM * (d.fwd ? 1 - pr : pr));
  }

  // Called from touchmove until a drag engages. Engage needs a clearly
  // horizontal gesture past GHOST_DRAG_ENGAGE_PX — taps (≤ TAP_MAX_PX) and
  // vertical gestures never reach this, so the tap/dictionary path is safe.
  function ghostDragTryEngage(dx, dy, x, ts) {
    if (Math.abs(dx) < GHOST_DRAG_ENGAGE_PX) return;
    if (Math.abs(dx) < Math.abs(dy) * GHOST_DRAG_AXIS_RATIO) return;
    // ANY in-flight turn is interruptible, three ways:
    // - crossing landings (xnavF / xswapB: nav fired, section loading) must
    //   keep their cover until the relocate — refuse, briefly;
    // - finish animations (exiting / cancelB / xexitF / xcoverB / xcancelF /
    //   xcancelB) are rushed to a visible fast completion; the engage
    //   retries on the next touchmove — pages never teleport;
    // - nav-owing or invisible intra states (forward, cover, swap, cancelF,
    //   settling) are fast-completed instantly (owed nav flushed under
    //   cover, same frame as the new engage).
    if (ghostState !== "idle" && !ghostDrag) {
      // dragXF/dragXB without a drag = the two-rAF mount window of a
      // release-triggered crossing turn: its commit is imminent, refuse.
      if (
        ghostState === "xnavF" || ghostState === "xswapB" ||
        ghostState === "dragXF" || ghostState === "dragXB"
      ) {
        navLog("[GHOST] engage refused (crossing in flight) state=" + ghostState);
        return;
      }
      if (
        ghostState === "exiting" || ghostState === "cancelB" ||
        ghostState === "xexitF" || ghostState === "xcoverB" ||
        ghostState === "xcancelF" || ghostState === "xcancelB"
      ) {
        ghostRushFinish();
        return;
      }
      ghostFastComplete();
    }
    // Inherited debt (a previous swipe whose nav is still locked) settles
    // BEFORE eligibility: paying it can move the page and change this
    // drag's boundary classification.
    if (ghostNavDebt && !ghostSettleNavDebt("engage")) {
      ghostStopDebtRetry();
      ghostLog("inherited debt still locked at engage — retrying on drag moves");
    }
    var d = ghostDragEligible(dx);
    if (!d) {
      navLog(
        "[GHOST] engage refused state=" + ghostState +
        " ready=" + ghostReady +
        " sec=" + ghostSection + "/" + currentSectionIndex +
        " " + adjStateStr(adjNext) +
        " " + adjStateStr(adjPrev) +
        " wantedDelta=" + (dx !== 0 && (bookDir === "rtl" ? dx > 0 : dx < 0) ? "+1" : "-1") +
        " paging=" + isPaging
      );
      // A gesture refused for readiness kicks the missing rebuilds on the
      // spot (no debounce wait): this very gesture falls back, but the next
      // attempt animates. All are self-guarded: no-ops when already
      // building, matching, or off-boundary.
      if (ghostState === "idle") {
        buildGhost();
        buildAdj(adjNext);
        buildAdj(adjPrev);
      }
      return;
    }
    if (!ghostMountDrag(d)) return;
    d.lastX = x;
    d.lastT = ts;
    ghostState =
      d.mode === "f" ? "dragF" :
      d.mode === "b" ? "dragB" :
      d.mode === "xf" ? "dragXF" : "dragXB";
    ghostDrag = d;
    // Engagement of a real page turn → fullscreen reading (drop the chrome).
    notifyPageTurnGesture();
    ghostLog(
      "drag engage " + d.mode +
      " p=" + view.renderer.page + "/" + view.renderer.pages +
      " sec=" + currentSectionIndex +
      " sinceLoad=" + ghostSinceLoad()
    );
    ghostDragApply(d, dx);
    if (d.mode === "f") {
      // Early navigation in the same task: ghost (current page) and the jump
      // to the next page composite in the same frame — invisible swap; the
      // strip revealed from now on is the real next page. Crossings never
      // navigate here: their nav is LATE (at full exit / full cover).
      // Delivery is VERIFIED: right after a crossing Foliate may still hold
      // its internal lock and silently drop this nav — then the drag would
      // reveal the SAME page. A dropped nav is retried on every touchmove
      // (deterministic, no timers) and again at commit.
      d.navDone = ghostNavAttempt(d.action);
      if (!d.navDone) {
        ghostLog("early nav dropped by foliate lock — will retry during drag");
      }
    }
  }

  // Mount the surfaces a drag (or release-triggered turn) needs, leaving the
  // mover at its starting offset. Returns false when positioning failed.
  function ghostMountDrag(d) {
    if (d.mode === "f" || d.mode === "b") {
      if (!positionGhost(d.fwd ? 0 : -1)) return false;
      ghostMover = ghostClip;
      ghostClip.style.visibility = "visible";
      return true;
    }
    if (d.mode === "xf") {
      // Main panel (current page) exits over the adjNext cover (next
      // section, page 1) which fully hides the real view underneath.
      if (!positionGhost(0) || !positionAdjacent(adjNext)) return false;
      ghostMover = ghostClip;
      adjNext.clip.style.transition = "none";
      adjNext.clip.style.transform = "translateX(0px)";
      adjNext.clip.style.visibility = "visible";
      ghostClip.style.visibility = "visible";
      // Fingerprint at the exact moment the surfaces become visible — what
      // the reader is about to SEE (catches a late style divergence that a
      // clean "ready" fingerprint would miss).
      ghostLog(
        "mount xf next{" +
        (adjNext.frame.contentDocument ? ghostStyleFp(adjNext.frame.contentDocument) : "?") +
        "} ghost{" +
        (ghostFrame.contentDocument ? ghostStyleFp(ghostFrame.contentDocument) : "?") + "}"
      );
      return true;
    }
    // xb: adjPrev (previous section, last page) is the moving panel itself;
    // the main panel stays hidden.
    if (!positionAdjacent(adjPrev)) return false;
    ghostMover = adjPrev.clip;
    adjPrev.clip.style.visibility = "visible";
    ghostLog(
      "mount xb prev{" +
      (adjPrev.frame.contentDocument ? ghostStyleFp(adjPrev.frame.contentDocument) : "?") + "}"
    );
    return true;
  }

  function ghostDragMove(dx, x, ts) {
    var d = ghostDrag;
    if (!d) return;
    // Inherited debt first (the older swipe's turn), own nav second —
    // pages land in gesture order.
    if (ghostNavDebt) ghostSettleNavDebt("drag move");
    if (d.mode === "f" && !d.navDone) {
      d.navDone = ghostNavAttempt(d.action);
      if (d.navDone) ghostLog("early nav landed during drag");
    }
    var dt = ts - d.lastT;
    if (dt > 0) {
      var inst = (x - d.lastX) / dt;
      d.vx = 0.6 * inst + 0.4 * d.vx;
      d.lastX = x;
      d.lastT = ts;
    }
    ghostDragApply(d, dx);
  }

  // Duration of the finishing animation: proportional to the remaining
  // distance (full width = GHOST_TURN_MS), floored at GHOST_FINISH_MIN_MS.
  // Deliberately NOT shortened by the release velocity: a fast flick decides
  // the commit instantly, but the page still glides over a perceivable
  // duration — interruption keeps fast flipping fluid regardless.
  function ghostDurTo(d, targetOffset) {
    var dist = Math.abs(targetOffset - d.offset);
    var ms = Math.round((GHOST_TURN_MS * dist) / d.width);
    return Math.max(GHOST_FINISH_MIN_MS, ms);
  }

  function ghostCommitForward(d) {
    ghostState = "exiting";
    if (!d.navDone) {
      d.navDone = ghostNavAttempt(d.action);
      ghostLog(d.navDone
        ? "early nav landed at commit"
        : "early nav still dropped at commit — retrying during exit");
      if (!d.navDone) {
        ghostOweNav(d.action, "forward-commit");
        // Deliver DURING the exit, not only at hide. A forward intra reveals
        // the REAL next page beneath the exiting ghost — so the nav MUST land
        // while the slide is still playing, or the reveal shows the stale
        // current page for the whole animation (page 1 of a just-loaded spine
        // appears to repeat, then jumps once the hide flush finally lands).
        // This happens when the swipe is a fast flick (one touchmove, no
        // drag-move retry) within ~100ms of a crossing landing, while
        // foliate's lock is still held. Retrying while "exiting" lands it the
        // instant the lock clears (~60-80ms in), with the ghost still
        // covering most of the screen; the exit is always >= GHOST_FINISH_MIN
        // (200ms) so it outlives the ~100ms lock and the hide flush stays a
        // no-op safety net.
        ghostRetryNavWhile("forward-commit", "exiting");
      }
    }
    var target = d.fingerDir * d.width;
    var ms = ghostDurTo(d, target);
    ghostDim.style.transition = "opacity " + ms + "ms " + GHOST_EASE_DEPART;
    ghostDim.style.opacity = "0";
    // Navigation already happened at engage (or is owed via pendingNav) —
    // just finish the reveal.
    ghostAnimateClipTo(target, ms, GHOST_EASE_DEPART, function () {
      ghostHide();
    });
  }

  function ghostCancelForward(d) {
    if (!d.navDone) {
      // The early nav never landed (dropped by the lock): nothing to undo.
      // Recover the panel over the unchanged page and hide — no reverse nav.
      ghostState = "cancelF";
      var msBack = ghostDurTo(d, 0);
      ghostDim.style.transition = "opacity " + msBack + "ms " + GHOST_EASE_ARRIVE;
      ghostDim.style.opacity = String(GHOST_DIM);
      ghostAnimateClipTo(0, msBack, GHOST_EASE_ARRIVE, function () {
        ghostLog("forward cancel: nav never landed, nothing to undo");
        ghostHide();
      });
      return;
    }
    ghostState = "cancelF";
    ghostOweNav(d.reverseAction, "cancel-undo");
    var ms = ghostDurTo(d, 0);
    // The current page comes back over the next one: an arrival.
    ghostDim.style.transition = "opacity " + ms + "ms " + GHOST_EASE_ARRIVE;
    ghostDim.style.opacity = String(GHOST_DIM);
    ghostAnimateClipTo(0, ms, GHOST_EASE_ARRIVE, function () {
      if (ghostState !== "cancelF") return;
      // Fully covered again: undo the early navigation underneath, then hide
      // once the content relocate confirms (invisible: live == ghost again).
      ghostDim.style.transition = "none";
      ghostDim.style.opacity = "0";
      ghostTimerId = setTimeout(function () {
        ghostTimerId = null;
        ghostFinishCancelF("timeout");
      }, GHOST_RELOCATE_FALLBACK_MS);
      if (!ghostSettleNavDebt()) {
        ghostLog("cancel undo nav dropped by foliate lock — retrying");
        ghostRetryNavWhile("cancel-undo", "cancelF");
      }
    });
  }

  function ghostFinishCancelF(reason) {
    if (ghostState !== "cancelF") return;
    if (ghostTimerId) { clearTimeout(ghostTimerId); ghostTimerId = null; }
    setTimeout(function () {
      if (ghostState !== "cancelF") return;
      ghostLog("forward cancel undone by " + reason);
      ghostHide();
    }, GHOST_HOLD_MS);
  }

  function ghostCommitBackward(d) {
    ghostState = "cover";
    ghostOweNav(d.action, "backward-commit");
    var ms = ghostDurTo(d, 0);
    ghostDim.style.transition = "opacity " + ms + "ms " + GHOST_EASE_ARRIVE;
    ghostDim.style.opacity = String(GHOST_DIM);
    ghostAnimateClipTo(0, ms, GHOST_EASE_ARRIVE, function () {
      if (ghostState !== "cover") return;
      ghostState = "swap";
      ghostDim.style.transition = "none";
      ghostDim.style.opacity = "0";
      ghostTimerId = setTimeout(function () {
        ghostTimerId = null;
        ghostFinishSwap("timeout");
      }, GHOST_RELOCATE_FALLBACK_MS);
      if (!ghostSettleNavDebt()) {
        ghostLog("backward swap nav dropped by foliate lock — retrying");
        ghostRetryNavWhile("backward-commit", "swap");
      }
    });
  }

  function ghostCancelBackward(d) {
    // No navigation ever happened — just slide the ghost back out.
    ghostState = "cancelB";
    var entry = -d.fingerDir * d.width;
    var ms = ghostDurTo(d, entry);
    // The previous page retreats off screen: a departure.
    ghostDim.style.transition = "opacity " + ms + "ms " + GHOST_EASE_DEPART;
    ghostDim.style.opacity = "0";
    ghostAnimateClipTo(entry, ms, GHOST_EASE_DEPART, function () {
      ghostHide();
    });
  }

  // ── crossing pipelines (late nav, both directions) ────────────────────────
  // The real Foliate view only navigates once it is fully hidden: under the
  // adjacent cover after the panel's full exit (forward), or under the
  // arriving adjacent panel at full cover (backward). The landing relocate
  // (async: section load + columnize) then releases everything — nothing is
  // ever destroyed while a finger can still touch it, and cancels never
  // navigate at all.
  function ghostCommitCrossForward(d) {
    ghostState = "xexitF";
    lastCrossingDelta = 1;
    ghostOweOrHandoff(d.action, "crossing-forward");
    var target = d.fingerDir * d.width;
    var ms = ghostDurTo(d, target);
    ghostDim.style.transition = "opacity " + ms + "ms " + GHOST_EASE_DEPART;
    ghostDim.style.opacity = "0";
    ghostLog("crossing forward animated");
    ghostAnimateClipTo(target, ms, GHOST_EASE_DEPART, function () {
      if (ghostState !== "xexitF") return;
      ghostState = "xnavF";
      ghostTimerId = setTimeout(function () {
        ghostTimerId = null;
        ghostFinishCrossing("timeout");
      }, GHOST_CROSSING_FALLBACK_MS);
      // Crossing nav is async by nature: clear the debt and deliver raw
      // (a sync settle would read "dropped" and double-navigate).
      ghostNavDebt = null;
      runTurnNav(d.action);
    });
  }

  function ghostCancelCrossForward(d) {
    // Nothing navigated: the panel just comes back over the adjacent cover.
    ghostState = "xcancelF";
    var ms = ghostDurTo(d, 0);
    ghostDim.style.transition = "opacity " + ms + "ms " + GHOST_EASE_ARRIVE;
    ghostDim.style.opacity = String(GHOST_DIM);
    ghostAnimateClipTo(0, ms, GHOST_EASE_ARRIVE, function () {
      ghostHide();
    });
  }

  function ghostCommitCrossBackward(d) {
    ghostState = "xcoverB";
    lastCrossingDelta = -1;
    ghostOweOrHandoff(d.action, "crossing-backward");
    var ms = ghostDurTo(d, 0);
    ghostDim.style.transition = "opacity " + ms + "ms " + GHOST_EASE_ARRIVE;
    ghostDim.style.opacity = String(GHOST_DIM);
    ghostLog("crossing backward animated");
    ghostAnimateClipTo(0, ms, GHOST_EASE_ARRIVE, function () {
      if (ghostState !== "xcoverB") return;
      ghostState = "xswapB";
      // Fully covered: drop the dim instantly so it never pops over the
      // landed page when the panel hides.
      ghostDim.style.transition = "none";
      ghostDim.style.opacity = "0";
      ghostTimerId = setTimeout(function () {
        ghostTimerId = null;
        ghostFinishCrossing("timeout");
      }, GHOST_CROSSING_FALLBACK_MS);
      // Crossing nav is async by nature: clear the debt and deliver raw
      // (a sync settle would read "dropped" and double-navigate).
      ghostNavDebt = null;
      runTurnNav(d.action);
    });
  }

  function ghostCancelCrossBackward(d) {
    // Nothing navigated: the arriving page just retreats off screen.
    ghostState = "xcancelB";
    var entry = -d.fingerDir * d.width;
    var ms = ghostDurTo(d, entry);
    ghostDim.style.transition = "opacity " + ms + "ms " + GHOST_EASE_DEPART;
    ghostDim.style.opacity = "0";
    ghostAnimateClipTo(entry, ms, GHOST_EASE_DEPART, function () {
      ghostHide();
    });
  }

  // Landing of a crossing nav: the content relocate of the new section (or
  // the fallback timeout) arrives while the cover is up. Hold the few
  // stale-tile frames, then reveal — interruptible like settling.
  function ghostFinishCrossing(reason) {
    if (ghostState !== "xnavF" && ghostState !== "xswapB") return;
    if (ghostTimerId) { clearTimeout(ghostTimerId); ghostTimerId = null; }
    ghostState = "settling";
    // A timeout with the section unchanged would mean the crossing nav
    // itself was dropped — log enough state to tell.
    ghostLog(
      "crossing landed by " + reason +
      " sec=" + currentSectionIndex +
      " p=" + view.renderer.page + "/" + view.renderer.pages
    );
    setTimeout(function () {
      if (ghostState !== "settling") return;
      ghostHide();
    }, GHOST_HOLD_MS);
  }

  // touchend of an engaged drag. Returns true when the gesture was handled.
  function ghostDragEnd() {
    var d = ghostDrag;
    if (!d) return false;
    ghostDrag = null;
    var pr = ghostDragProgress(d);
    var flick = Math.abs(d.vx) >= GHOST_FLICK_VX;
    // A flick decides by its direction; otherwise the progress ratio does.
    // Completion always moves in the finger direction (both modes).
    var commit = flick ? d.vx * d.fingerDir > 0 : pr >= GHOST_COMMIT_RATIO;
    ghostLog(
      "drag end " + d.mode +
      " progress=" + pr.toFixed(2) +
      " vx=" + d.vx.toFixed(2) +
      (flick ? " flick" : "") +
      " -> " + (commit ? "commit" : "cancel")
    );
    if (d.mode === "f") {
      if (commit) ghostCommitForward(d);
      else ghostCancelForward(d);
    } else if (d.mode === "b") {
      if (commit) ghostCommitBackward(d);
      else ghostCancelBackward(d);
    } else if (d.mode === "xf") {
      if (commit) ghostCommitCrossForward(d);
      else ghostCancelCrossForward(d);
    } else {
      if (commit) ghostCommitCrossBackward(d);
      else ghostCancelCrossBackward(d);
    }
    return true;
  }

  // Interrupted touch (system gesture, notification…): treat as a cancel.
  function ghostDragInterrupt() {
    var d = ghostDrag;
    if (!d) return;
    ghostDrag = null;
    ghostLog("drag interrupted -> cancel");
    if (d.mode === "f") ghostCancelForward(d);
    else if (d.mode === "b") ghostCancelBackward(d);
    else if (d.mode === "xf") ghostCancelCrossForward(d);
    else ghostCancelCrossBackward(d);
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Release-triggered crossing turn (flick that never engaged a drag):
  // mount the surfaces at the gesture's start position and run the commit
  // pipeline from there — full-width travel, late nav at the end.
  function ghostAutoCross(mode, action, fingerDir) {
    var d = {
      mode: mode,
      fwd: mode === "xf",
      cross: true,
      action: action,
      reverseAction: action === "goLeft" ? "goRight" : "goLeft",
      fingerDir: fingerDir,
      width: window.innerWidth,
      offset: mode === "xf" ? 0 : -fingerDir * window.innerWidth,
      lastX: 0,
      lastT: 0,
      vx: 0,
    };
    if (!ghostMountDrag(d)) return false;
    ghostSetClip(d.offset);
    ghostDim.style.transition = "none";
    ghostDim.style.opacity = mode === "xf" ? String(GHOST_DIM) : "0";
    var dragState = mode === "xf" ? "dragXF" : "dragXB";
    ghostState = dragState;
    // Owed from this point: if anything tears the turn down before the
    // commit pipeline takes over (safety hide), the nav is still flushed.
    ghostOweNav(action, "autocross");
    // Two rAFs so the mounted start position paints before the transition.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (ghostState !== dragState) return;
        if (mode === "xf") ghostCommitCrossForward(d);
        else ghostCommitCrossBackward(d);
      });
    });
    return true;
  }

  // Decide whether this swipe can be ghost-animated; otherwise fall back to
  // the instant navigation. Caller has already locked isPaging.
  function ghostTryTurn(dx, action) {
    var fingerDir = dx > 0 ? 1 : -1;
    var forward = bookDir === "rtl" ? dx > 0 : dx < 0;
    // Inherited debt settles FIRST: paying it moves the page, which
    // changes everything read below (boundary detection included).
    if (ghostNavDebt) ghostSettleNavDebt("turn entry");
    var p = view.renderer.page;
    var ps = view.renderer.pages;
    var ghostOk = ghostReady && ghostSection === currentSectionIndex;
    var reason = null;
    if (ghostState !== "idle") reason = "ghost-busy";
    else if (ps <= 2 || p < 1 || p > ps - 2) reason = "sentinel-state";
    else if (forward && p + 1 > ps - 2) {
      lastCrossingDelta = 1; // crossing attempted (animated or fallback)
      if (!adjacentValidFor(1)) {
        reason = "adjacent-not-ready";
      } else if (!ghostOk) {
        reason = "ghost-not-ready";
      } else if (ghostAutoCross("xf", action, fingerDir)) {
        navLog("[GHOST] turn crossing-forward page=" + p + "/" + ps);
        return;
      } else {
        reason = "position-failed";
      }
    } else if (!forward && p - 1 < 1) {
      lastCrossingDelta = -1; // crossing attempted (animated or fallback)
      if (!adjacentValidFor(-1)) {
        reason = "adjacent-not-ready";
      } else if (ghostAutoCross("xb", action, fingerDir)) {
        navLog("[GHOST] turn crossing-backward page=" + p + "/" + ps);
        return;
      } else {
        reason = "position-failed";
      }
    } else if (!ghostOk) {
      reason = "ghost-not-ready";
    } else {
      var ok = forward
        ? ghostForwardTurn(action, fingerDir)
        : ghostBackwardTurn(action, fingerDir);
      if (ok) {
        navLog("[GHOST] turn " + (forward ? "forward" : "backward") + " page=" + p + "/" + ps);
        return;
      }
      reason = "position-failed";
    }
    ghostLog(
      "fallback direct (" + reason + ")" +
      " cur=" + currentSectionIndex + " p=" + p + "/" + ps +
      " ghost=" + ghostSection + (ghostReady ? "" : "(nr)") +
      " " + adjStateStr(adjNext) +
      " " + adjStateStr(adjPrev) +
      " wantedDelta=" + (forward ? "+1" : "-1") +
      " desiredN=" + desiredSectionFor(adjNext) +
      " desiredP=" + desiredSectionFor(adjPrev) +
      " sinceLoad=" + ghostSinceLoad()
    );
    // A readiness fallback kicks the missing rebuild on the spot (no
    // debounce wait), targeting the surface of the REQUESTED direction.
    // Self-guarded no-ops when already fine, self-healing if the fallback
    // nav moves us meanwhile (stale completions are re-checked).
    if (reason === "ghost-not-ready") buildGhost();
    else if (reason === "adjacent-not-ready") buildAdj(forward ? adjNext : adjPrev);
    // The fallback nav itself can be dropped by the foliate lock. Intra
    // fallbacks verify delivery synchronously; crossing fallbacks stay raw
    // (they are legitimately async — a sync check would double-navigate).
    var isCrossing = forward ? p + 1 > ps - 2 : p - 1 < 1;
    if (isCrossing || ps <= 2 || p < 1 || p > ps - 2) {
      runTurnNav(action);
    } else {
      ghostOweNav(action, "fallback-" + reason);
      ghostFlushDebt();
    }
  }

  // Debug aid — call from Safari Web Inspector (or injectJavaScript):
  // window.__ghostDebug(0) overlays the ghost statically on the current page
  // to eyeball pixel fidelity; (1)/(-1) show next/previous; (null) hides.
  window.__ghostDebug = function (delta) {
    if (!ghostReady || !ghostClip) { ghostLog("debug: ghost not ready"); return; }
    if (delta == null) { ghostHide(); return; }
    positionGhost(delta);
    ghostSetClip(0);
    ghostClip.style.visibility = "visible";
  };
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
      // At idle every surface must be hidden — if the page under the finger
      // looks wrong (huge font) and a leak is logged HERE, the wrong page is
      // a leftover surface; if nothing is logged, it is the real view.
      if (GHOST_TURN && !isMeasuring && ghostState === "idle") {
        ghostAuditSurfaces("touchstart");
      }
    }, { capture: true, passive: true });
    doc.addEventListener("touchmove", function (e) {
      e.stopImmediatePropagation();
      if (!GHOST_TURN || isMeasuring || isDictionaryOpen) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - t0X;
      var dy = t.clientY - t0Y;
      if (ghostDrag) ghostDragMove(dx, t.clientX, e.timeStamp);
      else ghostDragTryEngage(dx, dy, t.clientX, e.timeStamp);
    }, { capture: true, passive: true });
    doc.addEventListener("touchcancel", function (e) {
      e.stopImmediatePropagation();
      if (GHOST_TURN) ghostDragInterrupt();
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
      // An engaged interactive drag fully handles its own touchend
      // (commit or cancel); the tap/swipe branches below never run for it.
      if (GHOST_TURN && ghostDragEnd()) return;
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
        // An in-flight ghost turn is resolved on the spot: any owed nav is
        // flushed invisibly under cover, and the new turn mounts its panel
        // in the SAME task — the cut composites in one frame with the new
        // full-cover mount, so it is masked. This swipe then animates
        // normally. (Previously exiting/settling fell through to ghostTryTurn
        // which bailed out with fallback direct ghost-busy — the very fast
        // forward chains where the animation looked completely skipped.)
        // Exception: a committed/landing crossing cannot be flushed — its
        // nav lands asynchronously (section load) and a second nav now would
        // race it. Dropped, briefly; logged always-on.
        if (GHOST_TURN && ghostState !== "idle") {
          if (
            ghostState === "xexitF" || ghostState === "xcoverB" ||
            ghostState === "xnavF" || ghostState === "xswapB" ||
            ghostState === "dragXF" || ghostState === "dragXB"
          ) {
            ghostLog("swipe ignored state=" + ghostState);
            return;
          }
          ghostFastComplete();
        }
        if (SNAPSHOT_TURN) {
          // Boundary no-op: at the very start/end of the book the turn would
          // change nothing — skip snapshot + nav entirely.
          var isForward = bookDir === "rtl" ? dx > 0 : dx < 0;
          if (isForward ? view.renderer.atEnd : view.renderer.atStart) {
            navLog("[FOLIATE-NAV] swipe ignored (" + (isForward ? "atEnd" : "atStart") + ")");
            return;
          }
        }
        // A committed flick (no interactive drag engaged) is also a real
        // page turn → drop the chrome here, past the ignore guards above.
        notifyPageTurnGesture();
        isPaging = true;
        pendingNavAction = dx > 0 ? "goLeft" : "goRight";
        navLog(
          "[FOLIATE-NAV] paging locked action=" + pendingNavAction +
          " sec=" + currentSectionIndex +
          " page=" + view.renderer.page + "/" + view.renderer.pages
        );
        // Primary release: the content-page relocate after navigation completes.
        // Fallback timeout in case Foliate emits no content relocate (longer
        // in prototype modes: animation phases precede/follow the navigation).
        pagingTimeoutId = setTimeout(function () {
          pagingTimeoutId = null;
          releasePaging("timeout");
        }, (GHOST_TURN || SNAPSHOT_TURN) ? 1500 : 1000);
        if (GHOST_TURN) {
          // Ghost path: animates when possible, falls back to instant nav.
          ghostTryTurn(dx, pendingNavAction);
          return;
        }
        if (SNAPSHOT_TURN) {
          // RN orchestrates the rest: capture → mount snapshot overlay →
          // window.__turnNav(action) → wait relocated → slide → unmount.
          // t = bridge touchend timestamp (same epoch clock as RN Date.now()).
          rnPost("turn-intent", {
            action: pendingNavAction,
            dir: dx > 0 ? 1 : -1,
            t: Date.now(),
          });
          return;
        }
        // Promise resolves immediately for intra-section navigation; for spine
        // crossings it may not resolve — the relocate handler covers that.
        runTurnNav(pendingNavAction);
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
		"#fv { display: block; width: 100%; height: 100%; background: #F1E2C9; }",
		"</style>",
		"</head>",
		"<body>",
		'<foliate-view id="fv"></foliate-view>',
		`<script>window.__READER_LAYOUT = ${JSON.stringify(READER_LAYOUT)};</script>`,
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
