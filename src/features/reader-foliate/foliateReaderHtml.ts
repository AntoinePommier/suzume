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
  rnPost("log", "[FOLIATE-SPIKE] bridge init sessionId=" + sessionId);

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
          rnPost("log", "[FOLIATE-SPIKE] calling goToFraction(0)");
          return view.goToFraction(0);
        })
        .then(function () {
          rnPost("log", "[FOLIATE-SPIKE] goToFraction(0) resolved");
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

  // Location events.
  rnPost("log", "[FOLIATE-SPIKE] attaching relocate listener sid=" + sessionId);
  view.addEventListener("relocate", function (e) {
    relocateCount++;
    var d = e.detail || {};
    var cfi = d.cfi || null;
    var fraction = d.fraction != null ? d.fraction : null;
    var section = d.section || {};
    var location = d.location || {};
    var ts = Date.now();
    rnPost("relocated", {
      cfi: cfi,
      fraction: fraction,
      sectionCurrent: section.current != null ? section.current : null,
      sectionTotal: section.total != null ? section.total : null,
      locationCurrent: location.current != null ? location.current : null,
    });
    rnPost(
      "log",
      "[FOLIATE-SPIKE] RELOCATED #" + relocateCount +
        " sid=" + sessionId +
        " t=" + ts +
        " cfi=" + (cfi ? cfi.slice(0, 60) : "n/a") +
        " frac=" + (fraction != null ? fraction.toFixed(4) : "n/a") +
        " sec=" + section.current + "/" + section.total
    );
  });

  view.addEventListener("load", function (e) {
    var d = e.detail || {};
    if (view.book && view.book.dir) {
      bookDir = view.book.dir;
    }
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
