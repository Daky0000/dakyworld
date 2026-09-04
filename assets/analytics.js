/* ==========================================================================
   Dakyworld — analytics

   ONE THING TO FILL IN. Paste the GA4 Measurement ID between the quotes below
   and analytics starts working on every page. Leave it empty and this file does
   nothing at all: no third-party script is fetched, no cookie is set, and no
   request leaves the visitor's browser.

   Get the ID from analytics.google.com → Admin → Data streams → your web
   stream. It looks like G-XXXXXXXXXX.

   Filling it in does NOT start measuring anyone by itself. Nothing here runs
   until a visitor has switched analytics on in the cookie banner — see below.
   ========================================================================== */

var DAKYWORLD_GA4_ID = "";

/* --------------------------------------------------------------------------
   Everything below runs itself. There is nothing to edit.

   THE GATE
   --------
   This file used to load Google Analytics on sight and rely on Do Not Track to
   hold it back. That is not lawful for a European visitor and was never quite
   what it looked like: DNT is off by default in every mainstream browser, so
   "we honour DNT" in practice means "we measure almost everybody, without
   asking". Under Art 5(3) of the ePrivacy Directive the cookie GA4 writes needs
   consent BEFORE it is written, and under Art 4(11) GDPR silence is not
   consent.

   So the whole of this file now sits behind assets/consent.js. It asks
   `dakyworldConsent.onAllowed("analytics", ...)`, which runs the callback
   immediately if the visitor has already said yes on a previous visit, and
   otherwise the instant they say yes — so the switch in the preferences panel
   takes effect without a reload. Until then, googletagmanager.com is never
   contacted, no `_ga` cookie exists, and Google learns nothing about the visit,
   not even that it happened.

   If consent.js somehow fails to load, `window.dakyworldConsent` is undefined
   and this file does nothing. That is the right way round: a broken consent
   layer must fail to measuring nobody, never to measuring everybody.

   Three things this does that the stock snippet does not:

   - **It asks first.** See above.
   - **It truncates the address.** `anonymize_ip` is on. Both Ghana's Data
     Protection Act (Act 843) and the GDPR treat an IP address as personal
     data, and collecting a full one to count page views would contradict the
     privacy policy this site publishes.
   - **It stays off the critical path.** Loaded async, after everything that
     draws the page.
   -------------------------------------------------------------------------- */

(function () {
  "use strict";

  var id = (DAKYWORLD_GA4_ID || "").trim();
  if (!id) return;

  // Never on a preview host. Traffic from localhost or a preview deployment is
  // not traffic, and mixing it into the real numbers is how a site appears to
  // have visitors it does not.
  var host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "" || host.endsWith(".local")) return;

  // No consent layer, no analytics. Deliberately not a fallback to "load it
  // anyway" — see the note above.
  if (!window.dakyworldConsent || typeof window.dakyworldConsent.onAllowed !== "function") return;

  var loaded = false;

  window.dakyworldConsent.onAllowed("analytics", function () {
    if (loaded) return;
    loaded = true;

    window.dataLayer = window.dataLayer || [];
    function gtag() {
      window.dataLayer.push(arguments);
    }
    window.gtag = gtag;

    // Google Consent Mode, pushed onto the queue before `config` because that
    // is the order gtag.js reads it in: a consent state set after config is
    // applied too late for the first hit. Analytics is granted — this callback
    // only runs on a yes — and every advertising purpose stays denied, because
    // the visitor consented to being counted and to nothing else.
    gtag("consent", "default", {
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      analytics_storage: "granted",
    });

    gtag("js", new Date());
    gtag("config", id, {
      anonymize_ip: true,
      // The default is fine for a brochure site; naming it here means the
      // choice is visible rather than inherited.
      send_page_view: true,
    });

    var script = document.createElement("script");
    script.async = true;
    script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(id);
    document.head.appendChild(script);
  });
})();
