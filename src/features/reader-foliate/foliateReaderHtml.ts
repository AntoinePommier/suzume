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
      rnPost("log",
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

    // Deduplicate on (cfi, section.current): identical location fired multiple
    // times during paginator layout stabilization — same CFI, same spine.
    // Two different navigations always produce a different CFI or spine index.
    var key = (cfi || "") + "|" + (section.current != null ? section.current : "");
    if (key && key === lastRelocateKey) {
      rnPost("log",
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
    rnPost(
      "log",
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
    if (isMeasuring) return;
    rnPost("loaded", { index: d.index });
    rnPost(
      "log",
      "[FOLIATE-SPIKE] LOADED spine=" + d.index + " bookDir=" + bookDir
    );
  });

  // Touch swipe.
  // RTL (Japanese): swipe right (dx>0) = forward = view.next()
  //                 swipe left  (dx<0) = backward = view.prev()
  // LTR:            swipe left  (dx<0) = forward = view.next()
  //                 swipe right (dx>0) = backward = view.prev()
  var _tx0 = 0;
  document.addEventListener(
    "touchstart",
    function (e) {
      _tx0 = e.changedTouches[0].clientX;
    },
    { passive: true }
  );
  document.addEventListener(
    "touchend",
    function (e) {
      var dx = e.changedTouches[0].clientX - _tx0;
      if (Math.abs(dx) < 50) return;
      var forward = bookDir === "rtl" ? dx > 0 : dx < 0;
      if (forward) view.next();
      else view.prev();
    },
    { passive: true }
  );

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
