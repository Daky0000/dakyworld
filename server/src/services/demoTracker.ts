/**
 * Client-side analytics tracker injected into prospect demo pages.
 *
 * Captures visitor dwell time (active time tab was visible), scroll depth,
 * viewport dimensions, and user clicks (x/y coordinates, normalized percentages,
 * target element and text) to power rich analytics and heatmaps.
 *
 * Lightweight, zero dependencies, completely silent and non-intrusive.
 */

export interface InjectTrackerOptions {
  slug: string;
  sessionId: string;
}

export function generateTrackerScript(options: { slug: string; sessionId: string }): string {
  const { slug, sessionId } = options;

  // We write the script with minimal size and high resilience
  return `<script id="dw-demo-tracker">
(function() {
  if (window.__DW_TRACKER_LOADED__) return;
  window.__DW_TRACKER_LOADED__ = true;

  try {
    var SLUG = ${JSON.stringify(slug)};
    var SESSION_KEY = "dw_demo_sess_" + SLUG;
    var sessionId = "";
    try {
      sessionId = window.sessionStorage.getItem(SESSION_KEY) || "";
    } catch(e) {}
    if (!sessionId) {
      sessionId = ${JSON.stringify(sessionId)};
      try {
        window.sessionStorage.setItem(SESSION_KEY, sessionId);
      } catch(e) {}
    }

    var startTime = Date.now();
    var lastActiveTick = Date.now();
    var activeDurationSeconds = 0;
    var maxScrollDepth = 0;
    var clickQueue = [];
    var isTabActive = !document.hidden;

    function getDocDims() {
      var body = document.body || {};
      var docEl = document.documentElement || {};
      var width = Math.max(docEl.scrollWidth || 0, docEl.offsetWidth || 0, body.scrollWidth || 0, window.innerWidth || 1);
      var height = Math.max(docEl.scrollHeight || 0, docEl.offsetHeight || 0, body.scrollHeight || 0, window.innerHeight || 1);
      return { width: width, height: height };
    }

    function updateScrollDepth() {
      try {
        var docHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, 1);
        var viewBottom = (window.pageYOffset || document.documentElement.scrollTop || 0) + (window.innerHeight || 0);
        var pct = Math.min(100, Math.max(0, Math.round((viewBottom / docHeight) * 100)));
        if (pct > maxScrollDepth) {
          maxScrollDepth = pct;
        }
      } catch(e) {}
    }
    updateScrollDepth();

    // Track active viewing time
    function tickActiveTime() {
      var now = Date.now();
      if (isTabActive && !document.hidden) {
        var delta = (now - lastActiveTick) / 1000;
        if (delta > 0 && delta < 10) {
          activeDurationSeconds += delta;
        }
      }
      lastActiveTick = now;
    }

    document.addEventListener("visibilitychange", function() {
      isTabActive = !document.hidden;
      lastActiveTick = Date.now();
      if (!isTabActive) {
        flush(false);
      }
    });

    window.addEventListener("focus", function() {
      isTabActive = true;
      lastActiveTick = Date.now();
    });

    window.addEventListener("blur", function() {
      isTabActive = false;
      flush(false);
    });

    var scrollTimer = null;
    window.addEventListener("scroll", function() {
      if (!scrollTimer) {
        scrollTimer = setTimeout(function() {
          scrollTimer = null;
          updateScrollDepth();
        }, 150);
      }
    }, { passive: true });

    function cleanText(str) {
      if (!str) return "";
      return String(str).replace(/\\s+/g, " ").trim().slice(0, 60);
    }

    function buildSelector(el) {
      if (!el || el.nodeType !== 1) return "";
      var tag = el.tagName.toLowerCase();
      if (el.id) return "#" + el.id;
      var cls = el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/)[0] : "";
      return tag + cls;
    }

    // Capture clicks for heatmap
    document.addEventListener("click", function(e) {
      try {
        tickActiveTime();
        updateScrollDepth();
        var dims = getDocDims();
        var pageX = e.pageX != null ? e.pageX : (e.clientX + (window.pageXOffset || 0));
        var pageY = e.pageY != null ? e.pageY : (e.clientY + (window.pageYOffset || 0));
        var xPct = dims.width > 0 ? Math.round((pageX / dims.width) * 10000) / 100 : 0;
        var yPct = dims.height > 0 ? Math.round((pageY / dims.height) * 10000) / 100 : 0;

        var target = e.target;
        var tag = target && target.tagName ? target.tagName.toUpperCase() : "UNKNOWN";
        var text = "";
        if (target) {
          text = cleanText(target.innerText || target.textContent || target.getAttribute("aria-label") || target.getAttribute("title") || target.getAttribute("alt"));
          if (!text && target.parentElement) {
            text = cleanText(target.parentElement.innerText || target.parentElement.textContent);
          }
        }

        var clickData = {
          x: Math.round(pageX),
          y: Math.round(pageY),
          xPercent: Math.min(100, Math.max(0, xPct)),
          yPercent: Math.min(100, Math.max(0, yPct)),
          targetTag: tag,
          targetText: text,
          targetSelector: buildSelector(target),
          timeOffset: Math.round(activeDurationSeconds)
        };

        clickQueue.push(clickData);
        if (clickQueue.length >= 10) {
          flush(false);
        }
      } catch(err) {}
    }, true);

    function flush(isFinal) {
      try {
        tickActiveTime();
        updateScrollDepth();
        var clicksToSend = clickQueue.slice();
        clickQueue = [];

        var payload = {
          sessionId: sessionId,
          durationSeconds: Math.round(activeDurationSeconds),
          scrollDepth: maxScrollDepth,
          viewportWidth: window.innerWidth || null,
          viewportHeight: window.innerHeight || null,
          screenWidth: window.screen ? window.screen.width : null,
          screenHeight: window.screen ? window.screen.height : null,
          clicks: clicksToSend
        };

        var endpoint = "/demos/" + encodeURIComponent(SLUG) + "/analytics";
        var jsonStr = JSON.stringify(payload);

        if (isFinal && navigator.sendBeacon) {
          var blob = new Blob([jsonStr], { type: "application/json" });
          navigator.sendBeacon(endpoint, blob);
        } else {
          fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: jsonStr,
            keepalive: true
          }).catch(function() {});
        }
      } catch(e) {}
    }

    // Flush initial open after 1 second
    setTimeout(function() { flush(false); }, 1000);

    // Periodic heartbeat every 6 seconds
    setInterval(function() {
      if (isTabActive && !document.hidden) {
        flush(false);
      }
    }, 6000);

    // On page unload / hide
    window.addEventListener("pagehide", function() { flush(true); });
    window.addEventListener("beforeunload", function() { flush(true); });
  } catch(globalErr) {}
})();
</script>`;
}

/**
 * Injects tracker script into the demo HTML page right before </body> or </html>.
 */
export function injectDemoTracker(html: string, options: InjectTrackerOptions): string {
  const script = generateTrackerScript(options);

  if (html.includes("</body>")) {
    return html.replace("</body>", `${script}\n</body>`);
  }
  if (html.includes("</html>")) {
    return html.replace("</html>", `${script}\n</html>`);
  }
  return `${html}\n${script}`;
}
