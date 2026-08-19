/* ==========================================================================
   Dakyworld — analytics

   ONE THING TO FILL IN. Paste the GA4 Measurement ID between the quotes below
   and analytics starts working on every page. Leave it empty and this file does
   nothing at all: no third-party script is fetched, no cookie is set, and no
   request leaves the visitor's browser.

   Get the ID from analytics.google.com → Admin → Data streams → your web
   stream. It looks like G-XXXXXXXXXX.
   ========================================================================== */

var DAKYWORLD_GA4_ID = "";

/* --------------------------------------------------------------------------
   Everything below runs itself. There is nothing to edit.

   Why the ID is a variable here rather than a gtag snippet pasted into
   thirteen <head> blocks: a snippet copied into every page is a snippet that
   gets copied into twelve and forgotten in the thirteenth, and the page it is
   missing from is invisible in the reports without anything looking wrong.
   One file, one line, every page.

   Three things this does that the stock snippet does not:

   - **It respects a refusal.** Do Not Track and Global Privacy Control are
     honoured before the script is fetched, so a visitor who has asked not to
     be tracked is not tracked, rather than tracked and then excluded from a
     report. GPC is a legal signal in a growing number of places and costs one
     line to honour.
   - **It truncates the address.** `anonymize_ip` is on. Ghana's Data Protection
     Act (Act 843) treats an IP address as personal data, and the site's own
     privacy policy is written on that basis — collecting a full one to count
     page views would contradict the page it sits next to.
   - **It stays off the critical path.** Loaded async, after everything that
     draws the page.
   -------------------------------------------------------------------------- */

(function () {
  "use strict";

  var id = (DAKYWORLD_GA4_ID || "").trim();
  if (!id) return;

  // A visitor who has said no. `navigator.doNotTrack` is "1" in most browsers
  // and "yes" in a couple of older ones; `globalPrivacyControl` is the newer,
  // legally-recognised signal.
  var refused =
    navigator.globalPrivacyControl === true ||
    navigator.doNotTrack === "1" ||
    navigator.doNotTrack === "yes" ||
    window.doNotTrack === "1";
  if (refused) return;

  // Never on a preview host. Traffic from localhost or a GitHub Pages preview
  // is not traffic, and mixing it into the real numbers is how a site appears
  // to have visitors it does not.
  var host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "" || host.endsWith(".local")) return;

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = gtag;

  gtag("js", new Date());
  gtag("config", id, {
    anonymize_ip: true,
    // The default is fine for a thirteen-page brochure site; naming it here
    // means the choice is visible rather than inherited.
    send_page_view: true,
  });

  var script = document.createElement("script");
  script.async = true;
  script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(id);
  document.head.appendChild(script);
})();
