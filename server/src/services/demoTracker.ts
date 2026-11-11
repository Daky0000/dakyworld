/**
 * Client-side analytics tracker injected into prospect demo pages.
 *
 * Captures visitor dwell time (active time tab was visible), scroll depth,
 * viewport dimensions, user timezone/locale, and user clicks (x/y coordinates,
 * normalized percentages, target element and text) to power rich analytics and heatmaps.
 *
 * Hardened for:
 * - Unique server-issued visit ID per page view (resolves reload split)
 * - HMAC visit token authentication (prevents forged public beacons)
 * - Delivery retry retention with bounded queue and event ID deduplication
 * - Sensitive form element, password, and private container masking
 * - Heartbeat write batching to eliminate redundant server load
 * - Fallback to fetch keepalive when sendBeacon returns false
 *
 * Lightweight, zero dependencies, completely silent, resilient to SVG/DOM edge cases.
 */

/**
 * Notices every file the page fails to load, in the visitor's own browser.
 *
 * The server cannot see a file the browser discards after a 200 (11 Nov 2026:
 * every Ghacem picture, blocked by Cross-Origin-Resource-Policy, while the HTTP
 * logs read 200), so the page reports it instead — see
 * `services/demoBrokenFiles.ts`. It goes at the top of `<head>`: a picture that
 * fails while the body is still being parsed fires its error before a script at
 * the end of the body exists to hear it.
 *
 * What it catches: `error` on any picture, video, audio, source, script,
 * stylesheet or iframe (captured on window, since those events do not bubble),
 * a font that fails, and CSS background pictures (probed once the page has
 * loaded, because a failed background fires no event at all). The list goes to
 * `window.__dwBrokenReport` when the tracker has set one, and to the parent
 * frame when there is one — the Demos screen's own preview listens for it.
 *
 * No backslashes and no `${` in here: this is a template literal, and either
 * would be eaten before the browser saw it.
 */
export const FILE_WATCH_SCRIPT = `<script id="dw-file-watch">(function(){
  if (window.__dwFileWatch) return;
  var list = window.__dwBrokenFiles = [], seen = {}, timer = null;
  window.__dwFileWatch = true;
  function send() {
    timer = null;
    try { if (window.__dwBrokenReport) window.__dwBrokenReport(list.slice()); } catch (e) {}
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ source: "dakyx-demo", type: "broken-files", files: list.slice() }, "*"); } catch (e) {}
  }
  function note(url, kind) {
    try {
      if (url && typeof url !== "string") url = url.baseVal || String(url);
      if (!url || /^(data|blob|about|javascript):/i.test(url)) return;
      if (seen[url] || list.length >= 40) return;
      seen[url] = 1;
      list.push({ url: String(url).slice(0, 500), kind: kind });
      if (!timer) timer = setTimeout(send, 800);
    } catch (e) {}
  }
  window.addEventListener("error", function (e) {
    var t = e && e.target;
    if (!t || t === window || !t.tagName) return;
    var tag = String(t.tagName).toLowerCase();
    if (tag === "link" && !/stylesheet|preload/i.test(t.rel || "")) return;
    note(t.currentSrc || t.src || t.href || (t.getAttribute && (t.getAttribute("src") || t.getAttribute("href"))), tag);
  }, true);
  try {
    if (document.fonts && document.fonts.addEventListener) {
      document.fonts.addEventListener("loadingerror", function (e) {
        var faces = (e && e.fontfaces) || [];
        for (var i = 0; i < faces.length; i++) note("font " + faces[i].family, "font");
      });
    }
  } catch (e) {}
  function backgrounds() {
    try {
      var els = document.getElementsByTagName("*"), urls = [], have = {};
      for (var i = 0; i < els.length && urls.length < 60; i++) {
        var bg = getComputedStyle(els[i]).backgroundImage;
        if (!bg || bg.indexOf("url(") < 0) continue;
        var parts = bg.split("url(");
        for (var j = 1; j < parts.length; j++) {
          var u = parts[j].split(")")[0].trim();
          if (u.charAt(0) === '"' || u.charAt(0) === "'") u = u.slice(1, -1);
          if (u && !have[u] && !/^(data|blob):/i.test(u)) { have[u] = 1; urls.push(u); }
        }
      }
      for (var k = 0; k < urls.length; k++) (function (u) {
        var probe = new Image();
        probe.onerror = function () { note(u, "background"); };
        probe.src = u;
      })(urls[k]);
    } catch (e) {}
  }
  function later() { setTimeout(backgrounds, 1500); }
  if (document.readyState === "complete") later(); else window.addEventListener("load", later);
})();</script>`;

/** Puts the file watch first in `<head>`, before anything the page loads. */
export function injectFileWatch(html: string): string {
  if (html.includes('id="dw-file-watch"')) return html;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + FILE_WATCH_SCRIPT + html.slice(head.index + head[0].length);
  const root = /<html\b[^>]*>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + FILE_WATCH_SCRIPT + html.slice(root.index + root[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + FILE_WATCH_SCRIPT + html.slice(doctype[0].length);
  return FILE_WATCH_SCRIPT + html;
}

export interface InjectTrackerOptions {
  slug: string;
  visitId?: string;
  token?: string;
  sessionId?: string;
  disabled?: boolean;
}

export function generateTrackerScript(options: {
  slug: string;
  visitId?: string;
  token?: string;
  sessionId?: string;
  disabled?: boolean;
}): string {
  const { slug, visitId, token, sessionId, disabled } = options;

  if (disabled) {
    // Nothing is counted in preview or heatmap mode. The page is sandboxed, so
    // the heatmap around it cannot measure it either — it says its own height
    // instead, which is all the overlay needs to line the clicks up.
    return `<script id="dw-demo-tracker">/* Tracking disabled in preview/heatmap mode */(function(){function h(){try{var d=document.documentElement,b=document.body;parent.postMessage({source:"dakyx-demo",type:"height",value:Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0)},"*")}catch(e){}}window.addEventListener("load",h);setTimeout(h,400);setTimeout(h,1500);})();</script>`;
  }

  return `<script id="dw-demo-tracker">
(function() {
  if (window.__DW_TRACKER_LOADED__) return;
  // Suppress tracking in admin heatmap preview or testing iframe
  try {
    var search = window.location.search || "";
    if (search.indexOf("dw_preview=heatmap") !== -1 || search.indexOf("dw_heatmap=1") !== -1 || search.indexOf("preview=heatmap") !== -1) {
      return;
    }
  } catch(e) {}

  window.__DW_TRACKER_LOADED__ = true;

  try {
    var SLUG = ${JSON.stringify(slug)};
    var VISIT_ID = ${JSON.stringify(visitId || sessionId || "")};
    var VISIT_TOKEN = ${JSON.stringify(token || "")};
    var SESSION_KEY = "dw_demo_sess_" + SLUG;
    var VISITOR_KEY = "dw_demo_visitor";

    var sessionId = "";
    try {
      sessionId = window.sessionStorage.getItem(SESSION_KEY) || "";
    } catch(e) {}
    if (!sessionId) {
      sessionId = ${JSON.stringify(sessionId || "")} || ("sess_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9));
      try {
        window.sessionStorage.setItem(SESSION_KEY, sessionId);
      } catch(e) {}
    }

    var visitorId = "";
    try {
      visitorId = window.localStorage.getItem(VISITOR_KEY) || "";
    } catch(e) {}
    if (!visitorId) {
      visitorId = "vis_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
      try {
        window.localStorage.setItem(VISITOR_KEY, visitorId);
      } catch(e) {}
    }

    var startTime = Date.now();
    var lastActiveTick = Date.now();
    var activeDurationSeconds = 0;
    var maxScrollDepth = 0;
    var clickQueue = [];
    var isTabActive = !document.hidden;

    // Files this browser could not load, from the file watch at the top of
    // <head>. It may have found some before this script existed.
    var brokenFiles = (window.__dwBrokenFiles || []).slice();
    var ackedBroken = 0;
    window.__dwBrokenReport = function(files) {
      brokenFiles = files || [];
      if (brokenFiles.length > ackedBroken) setTimeout(function() { flush(false); }, 300);
    };

    var lastAckedDuration = 0;
    var lastAckedScroll = 0;
    var isFlushing = false;

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

    function getSafeClassName(el) {
      if (!el || !el.className) return "";
      if (typeof el.className === "string") return el.className;
      if (typeof el.className.baseVal === "string") return el.className.baseVal;
      return "";
    }

    function buildSelector(el) {
      if (!el || el.nodeType !== 1) return "";
      var tag = el.tagName.toLowerCase();
      if (el.id) return "#" + el.id;
      var clsStr = getSafeClassName(el).trim();
      var firstCls = clsStr ? "." + clsStr.split(/\\s+/)[0] : "";
      return tag + firstCls;
    }

    // Capture clicks for heatmap with sensitive input protection
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
        var interactive = null;
        try {
          if (target && target.closest) {
            interactive = target.closest("a, button, input, select, textarea, summary, [role='button'], [tabindex]");
          }
        } catch(err) {}

        var primary = interactive || target;
        var tag = primary && primary.tagName ? primary.tagName.toUpperCase() : "UNKNOWN";
        var lowerTag = tag.toLowerCase();

        // Sensitive content masking
        var isSensitive = false;
        if (
          lowerTag === "input" ||
          lowerTag === "textarea" ||
          lowerTag === "select" ||
          (primary && (primary.isContentEditable || primary.getAttribute("contenteditable") === "true" || primary.getAttribute("role") === "textbox"))
        ) {
          isSensitive = true;
        }
        try {
          if (primary && primary.closest && primary.closest("[data-dw-mask], [data-private], [data-sensitive], .dw-mask, .private")) {
            isSensitive = true;
          }
        } catch(err) {}

        var text = "";
        var customEvent = primary ? (primary.getAttribute("data-dw-event") || primary.getAttribute("data-analytics") || primary.getAttribute("data-action")) : null;

        if (customEvent) {
          text = cleanText(customEvent);
        } else if (isSensitive) {
          if (lowerTag === "input") {
            var inputType = (primary.getAttribute("type") || "text").toLowerCase();
            text = (inputType === "password" || inputType === "hidden") ? "[masked]" : ("input:" + inputType);
          } else if (lowerTag === "textarea") {
            text = "textarea";
          } else {
            text = "[masked]";
          }
        } else if (primary) {
          text = cleanText(
            primary.innerText ||
            primary.textContent ||
            primary.getAttribute("aria-label") ||
            primary.getAttribute("title") ||
            primary.getAttribute("alt")
          );
          if (!text && primary.parentElement) {
            try {
              if (!primary.parentElement.closest || !primary.parentElement.closest("[data-dw-mask], [data-private], .dw-mask, .private")) {
                text = cleanText(primary.parentElement.innerText || primary.parentElement.textContent);
              }
            } catch(err) {}
          }
        }

        var eventId = "c_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);

        var clickData = {
          id: eventId,
          x: Math.round(pageX),
          y: Math.round(pageY),
          xPercent: Math.min(100, Math.max(0, xPct)),
          yPercent: Math.min(100, Math.max(0, yPct)),
          targetTag: tag,
          targetText: text,
          targetSelector: buildSelector(primary),
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

        var currentDuration = Math.round(activeDurationSeconds);
        var clicksToSend = clickQueue.slice();

        // Batch writes: do not send heartbeat if nothing has changed
        var hasNewClicks = clicksToSend.length > 0;
        var hasNewDuration = (currentDuration - lastAckedDuration) >= 3;
        var hasNewScroll = maxScrollDepth > lastAckedScroll;
        var brokenToSend = brokenFiles.slice();
        var hasNewBroken = brokenToSend.length > ackedBroken;

        if (!isFinal && !hasNewClicks && !hasNewDuration && !hasNewScroll && !hasNewBroken) {
          return;
        }

        var timezone = "";
        try {
          timezone = (Intl && Intl.DateTimeFormat) ? Intl.DateTimeFormat().resolvedOptions().timeZone || "" : "";
        } catch(e) {}

        var locale = "";
        try {
          locale = navigator.language || navigator.userLanguage || "";
        } catch(e) {}

        var payload = {
          visitId: VISIT_ID,
          token: VISIT_TOKEN,
          sessionId: sessionId,
          visitorId: visitorId,
          durationSeconds: currentDuration,
          scrollDepth: maxScrollDepth,
          viewportWidth: window.innerWidth || null,
          viewportHeight: window.innerHeight || null,
          screenWidth: window.screen ? window.screen.width : null,
          screenHeight: window.screen ? window.screen.height : null,
          timezone: timezone || undefined,
          locale: locale || undefined,
          clicks: clicksToSend,
          brokenFiles: hasNewBroken ? brokenToSend : undefined
        };

        var endpoint = "/demos/" + encodeURIComponent(SLUG) + "/analytics";
        var jsonStr = JSON.stringify(payload);

        if (isFinal) {
          var sent = false;
          if (navigator.sendBeacon) {
            try {
              var blob = new Blob([jsonStr], { type: "text/plain;charset=UTF-8" });
              sent = navigator.sendBeacon(endpoint, blob);
            } catch(e) { sent = false; }
          }
          if (!sent) {
            try {
              fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "text/plain;charset=UTF-8" },
                body: jsonStr,
                keepalive: true
              }).catch(function() {});
            } catch(e) {}
          }
          return;
        }

        if (isFlushing) return;
        isFlushing = true;

        fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: jsonStr,
          keepalive: true
        }).then(function(res) {
          isFlushing = false;
          if (res.ok) {
            lastAckedDuration = currentDuration;
            lastAckedScroll = maxScrollDepth;
            if (brokenToSend.length > ackedBroken) ackedBroken = brokenToSend.length;
            // Acknowledge and remove sent clicks
            if (clicksToSend.length > 0) {
              var ackedMap = {};
              for (var i = 0; i < clicksToSend.length; i++) {
                ackedMap[clicksToSend[i].id] = true;
              }
              clickQueue = clickQueue.filter(function(c) { return !ackedMap[c.id]; });
            }
          } else {
            // Keep in queue with cap
            if (clickQueue.length > 50) clickQueue = clickQueue.slice(-50);
          }
        }).catch(function() {
          isFlushing = false;
          if (clickQueue.length > 50) clickQueue = clickQueue.slice(-50);
        });
      } catch(e) {
        isFlushing = false;
      }
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
  // In both modes: a live visit reports through the beacon, a preview inside
  // the Demos screen through postMessage.
  html = injectFileWatch(html);

  if (html.includes("</body>")) {
    return html.replace("</body>", `${script}\n</body>`);
  }
  if (html.includes("</html>")) {
    return html.replace("</html>", `${script}\n</html>`);
  }
  return `${html}\n${script}`;
}
