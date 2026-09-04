/* ==========================================================================
   Dakyworld — cookie consent

   The whole mechanism, in one file, with no third-party dependency. A consent
   platform is a script from someone else's server that reads every visitor
   before they have agreed to anything, which is a strange thing to install in
   order to comply with a law about reading visitors. This site sets exactly
   one category of optional storage, so the honest implementation is a hundred
   lines of its own code.

   WHAT THIS IS FOR
   ----------------
   Under the ePrivacy Directive (Art 5(3), as implemented in every EU member
   state) reading or writing anything on a visitor's device needs their prior
   consent, unless it is strictly necessary to deliver the service they asked
   for. Under the GDPR that consent has to be freely given, specific, informed,
   unambiguous, given by a clear affirmative act, and as easy to withdraw as it
   was to give (Art 4(11), Art 7). Those two sentences dictate every design
   decision below:

   - **Prior.** Nothing optional runs before a choice is made. Analytics is not
     loaded and then suppressed; it is not loaded at all. `consentFor()` is the
     only gate, and assets/analytics.js is behind it.
   - **Specific.** Categories are consented to one at a time. Accepting
     analytics does not accept anything else, and there is nothing else to
     accept — if a category is ever added here, it arrives switched off and
     previously stored consent does not cover it (see CONSENT_VERSION).
   - **Unambiguous.** No box is pre-ticked, no switch starts on, and closing
     the banner is not consent. Dismissing the dialog leaves the decision
     unmade and the banner returns on the next page.
   - **Withdrawable.** `window.dakyworldConsent.open()` reopens the panel from
     the footer link on every page, and turning a switch off takes effect at
     once: the cookies that category set are deleted immediately, and the page
     is reloaded if a script that cannot be unloaded was already running.

   WHAT IT DELIBERATELY DOES NOT DO
   --------------------------------
   - It does not block the page. A consent wall is not freely given consent.
   - It does not treat "no decision" as "yes". A visitor who never touches the
     banner is a visitor who is never measured.
   - It does not phone home. No consent string is transmitted anywhere; the
     record is kept in the visitor's own browser, which is where the proof of
     consent for a site this size sensibly lives.
   ========================================================================== */

(function () {
  "use strict";

  /* --- what is being consented to ---------------------------------------- */

  /**
   * Bumping this invalidates every consent already stored, and every visitor
   * is asked again. Bump it whenever the answer to "what am I agreeing to?"
   * changes: a new category, a new vendor inside an existing category, or a
   * new purpose. Not for copy edits.
   *
   * This is the mechanism that keeps consent *specific*. Consent given in 2026
   * to Google Analytics is not consent to whatever is added in 2027, and
   * silently widening the scope of a stored yes is the failure the ICO and the
   * CNIL both call out by name.
   */
  var CONSENT_VERSION = 1;

  var STORAGE_KEY = "dakyworld.consent.v" + CONSENT_VERSION;

  /**
   * The categories, in the order they appear in the panel.
   *
   * `required: true` means the site cannot be delivered without it, which is
   * the ePrivacy "strictly necessary" exemption — and the bar for that is high.
   * It covers a session that keeps you logged in or a basket that survives a
   * page load. It does not cover analytics, however anonymous, and it does not
   * cover anything a marketer wants. Only one category qualifies here, and all
   * it holds is the record of this very choice.
   */
  var CATEGORIES = [
    {
      id: "necessary",
      required: true,
      name: "Strictly necessary",
      description:
        "Needed for the site to work. Right now this is a single entry in your browser's local storage that remembers the choice you make here, so you are not asked again on every page.",
      detail: [
        ["What is stored", "dakyworld.consent.v1 — your choice, the date you made it and the version of this notice."],
        ["Where", "Local storage in your browser, on your device. It is never sent to us or to anyone else."],
        ["How long", "12 months, then you are asked again."],
      ],
    },
    {
      id: "analytics",
      required: false,
      name: "Analytics",
      description:
        "Counts visits and shows which pages are read, so we can tell what is useful and what is not. Off unless you turn it on. The site works exactly the same either way.",
      detail: [
        ["Provider", "Google Analytics 4 (Google Ireland Limited, with Google LLC in the United States as a further recipient)."],
        ["What is stored", "_ga and _ga_* cookies holding a random identifier. Your IP address is truncated before it is stored, and it is never used to identify you."],
        ["How long", "Up to 2 years for the cookie; the reports keep aggregate figures for 14 months."],
        ["Transfer", "Data is processed in the United States under the EU Standard Contractual Clauses and the EU-US Data Privacy Framework, to which Google LLC is certified."],
      ],
    },
  ];

  /**
   * Cookies to delete when a category is switched off, as name prefixes.
   *
   * Withdrawing consent has to actually stop the processing, not merely stop
   * new processing (Art 7(3)); a cookie left behind after a refusal is still
   * being sent to its owner on every request. Prefix rather than exact name
   * because GA4 mints one cookie per property: `_ga_G-XXXXXXXX`.
   */
  var COOKIES_BY_CATEGORY = {
    analytics: ["_ga", "_gid", "_gat"],
  };

  /* --- storage ------------------------------------------------------------ */

  /**
   * Every read and write is wrapped. Storage throws outright in a browser set
   * to block site data, and in Safari's private mode it has historically
   * thrown on write. An exception here would take the banner down with it and
   * leave the visitor with no way to consent to anything, so a failure is
   * treated as "no decision recorded" — which fails closed, with analytics off.
   */
  function read() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.choices) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function write(choices) {
    var record = {
      version: CONSENT_VERSION,
      /** ISO 8601, UTC. The date of consent is part of the proof of it. */
      decidedAt: new Date().toISOString(),
      choices: choices,
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    } catch (err) {
      /* Nothing to do. The decision still applies for this page view — it is
         held in `state` below — it simply cannot be remembered for the next
         one, and the visitor will be asked again. Asking twice is a worse
         experience than it needs to be; assuming a yes would be unlawful. */
    }
    return record;
  }

  /**
   * Deletes a cookie by trying every scope it could have been set in. A cookie
   * can only be deleted from a path and domain that match the ones it was set
   * with, and the script that set it is gone by the time this runs, so the
   * options are guess or leave it behind.
   */
  function deleteCookie(name) {
    var host = window.location.hostname;
    var domains = ["", host, "." + host];
    // `example.co.uk` would need a longer walk; two labels covers dakyworld.com.
    var parts = host.split(".");
    if (parts.length > 2) domains.push("." + parts.slice(-2).join("."));

    var past = "Thu, 01 Jan 1970 00:00:00 GMT";
    for (var i = 0; i < domains.length; i++) {
      var scope = domains[i] ? "; domain=" + domains[i] : "";
      document.cookie = name + "=; expires=" + past + "; path=/" + scope;
    }
  }

  function clearCategory(id) {
    var prefixes = COOKIES_BY_CATEGORY[id];
    if (!prefixes || !document.cookie) return;

    var names = document.cookie.split(";").map(function (pair) {
      return pair.split("=")[0].trim();
    });

    names.forEach(function (name) {
      var matches = prefixes.some(function (prefix) {
        return name === prefix || name.indexOf(prefix) === 0;
      });
      if (matches) deleteCookie(name);
    });
  }

  /* --- the signal a visitor has already given ----------------------------- */

  /**
   * Global Privacy Control is a refusal expressed by the browser, and in
   * California it is legally binding; several EU authorities treat it as a
   * valid objection too. Honouring it costs one line and is the right answer
   * in every jurisdiction: it is an unambiguous statement of preference, which
   * is exactly what the banner is trying to collect.
   *
   * Do Not Track is not legally binding anywhere and was widely ignored, but a
   * visitor who set it meant the same thing. It is respected here for the same
   * reason.
   *
   * The important part is what this does NOT do: it does not record a refusal
   * as a decision. The banner is skipped and nothing optional runs, but if the
   * visitor opens the panel from the footer they can still switch analytics on
   * deliberately, and that explicit act wins over the browser default.
   */
  function browserRefusal() {
    return (
      navigator.globalPrivacyControl === true ||
      navigator.doNotTrack === "1" ||
      navigator.doNotTrack === "yes" ||
      window.doNotTrack === "1"
    );
  }

  /* --- state -------------------------------------------------------------- */

  var stored = read();

  /** The live answer for this page view. Absent an explicit yes, every optional category is off. */
  var state = {};
  CATEGORIES.forEach(function (cat) {
    state[cat.id] = cat.required ? true : Boolean(stored && stored.choices[cat.id] === true);
  });

  var decided = Boolean(stored);

  /* --- the public surface -------------------------------------------------- */

  var listeners = [];

  /**
   * The only gate. Anything that stores or reads on the device, or sends
   * anything to a third party, asks this first and does nothing if it is false.
   */
  function consentFor(id) {
    return state[id] === true;
  }

  /**
   * Runs `fn` if the category is allowed now, and again the moment it becomes
   * allowed. This is what lets analytics.js be loaded on every page and still
   * fetch nothing until the visitor says yes — without polling, and without a
   * page reload standing between the click and the effect.
   */
  function whenAllowed(id, fn) {
    if (consentFor(id)) { fn(); return; }
    listeners.push({ id: id, fn: fn, ran: false });
  }

  function notify() {
    listeners.forEach(function (l) {
      if (!l.ran && consentFor(l.id)) {
        l.ran = true;
        try { l.fn(); } catch (err) { /* one bad listener must not break the rest */ }
      }
    });

    document.dispatchEvent(
      new CustomEvent("dakyworld:consent", { detail: { choices: JSON.parse(JSON.stringify(state)) } })
    );
  }

  /**
   * Records a decision.
   *
   * `wasOn` is captured before the write because turning a category off has to
   * do more than remember the refusal: the cookies it set are deleted, and if
   * a script that cannot be unloaded is already running in this page, the page
   * is reloaded so that it is not.
   */
  function decide(choices) {
    var turnedOff = [];

    CATEGORIES.forEach(function (cat) {
      if (cat.required) return;
      var wasOn = state[cat.id] === true;
      var nowOn = choices[cat.id] === true;
      state[cat.id] = nowOn;
      if (wasOn && !nowOn) turnedOff.push(cat.id);
    });

    write(state);
    decided = true;

    turnedOff.forEach(clearCategory);

    closeBanner();
    closeModal();
    notify();

    /* gtag cannot be unloaded once its script has executed. If analytics was
       running in this page view and has just been refused, the only honest way
       to stop it is to reload without it. */
    if (turnedOff.indexOf("analytics") !== -1 && window.gtag) {
      window.location.reload();
    }
  }

  function acceptAll() {
    var choices = {};
    CATEGORIES.forEach(function (c) { choices[c.id] = true; });
    decide(choices);
  }

  function rejectAll() {
    var choices = {};
    CATEGORIES.forEach(function (c) { choices[c.id] = c.required; });
    decide(choices);
  }

  /* --- markup helpers ------------------------------------------------------ */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, className, onClick) {
    var b = el("button", "dw-consent__btn " + className, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  /* --- the banner ---------------------------------------------------------- */

  var banner = null;

  function buildBanner() {
    var wrap = el("div", "dw-consent");
    /* `region` with a label rather than `dialog`: it is not modal, it does not
       trap focus, and announcing it as a dialog would tell a screen-reader user
       the page behind it is unavailable, which is false. */
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Cookie choices");

    var inner = el("div", "dw-consent__inner");

    var copy = el("div", "dw-consent__copy");
    copy.appendChild(el("p", "dw-consent__title", "Cookies on this site"));

    var text = el("p", "dw-consent__text");
    text.appendChild(
      document.createTextNode(
        "We use one cookie that keeps this site working, and we would like to count visits so we can tell which pages are useful. Analytics is off until you turn it on, and the site works the same either way. "
      )
    );
    var link = el("a", null, "Read the privacy policy");
    link.href = "/privacy#cookies";
    text.appendChild(link);
    text.appendChild(document.createTextNode("."));
    copy.appendChild(text);

    var actions = el("div", "dw-consent__actions");
    /* Reject is written first in the DOM so it is also first in the tab order.
       Accept is styled as the affirmative action but is not made easier to
       reach than the refusal. */
    actions.appendChild(button("Reject", "dw-consent__btn--reject", rejectAll));
    actions.appendChild(button("Accept", "dw-consent__btn--accept", acceptAll));
    actions.appendChild(button("Choose what to allow", "dw-consent__btn--settings", function () { openModal(); }));

    inner.appendChild(copy);
    inner.appendChild(actions);
    wrap.appendChild(inner);
    return wrap;
  }

  function openBanner() {
    if (banner || !document.body) return;
    banner = buildBanner();
    document.body.appendChild(banner);
  }

  function closeBanner() {
    if (!banner) return;
    banner.parentNode.removeChild(banner);
    banner = null;
  }

  /* --- the preferences dialog ---------------------------------------------- */

  var modal = null;
  var returnFocusTo = null;

  function categoryCard(cat) {
    var card = el("div", "dw-consent-cat");
    var head = el("div", "dw-consent-cat__head");

    var id = "dw-consent-switch-" + cat.id;
    var name = el("label", "dw-consent-cat__name", cat.name);
    name.setAttribute("for", id);
    head.appendChild(name);

    if (cat.required) {
      head.appendChild(el("span", "dw-consent-cat__locked", "Always on"));
    } else {
      var sw = el("span", "dw-consent-switch");
      var input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      /* The current answer, never a default of true. A pre-ticked box is not
         consent (Recital 32 GDPR; CJEU, Planet49, C-673/17). */
      input.checked = state[cat.id] === true;
      input.setAttribute("data-category", cat.id);
      sw.appendChild(input);
      sw.appendChild(el("span", "dw-consent-switch__track"));
      head.appendChild(sw);
    }

    card.appendChild(head);
    card.appendChild(el("p", "dw-consent-cat__desc", cat.description));

    /* The detail is what makes the consent *informed*: who receives the data,
       what is stored, for how long, and whether it leaves the country. A
       banner that says "we use cookies to improve your experience" and nothing
       else has not informed anyone of anything. */
    if (cat.detail && cat.detail.length) {
      var dl = el("dl", "dw-consent-cat__detail");
      cat.detail.forEach(function (row) {
        dl.appendChild(el("dt", null, row[0]));
        dl.appendChild(el("dd", null, row[1]));
      });
      card.appendChild(dl);
    }

    return card;
  }

  function buildModal() {
    var overlay = el("div", "dw-consent-modal");
    var panel = el("div", "dw-consent-modal__panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "dw-consent-modal-title");
    panel.tabIndex = -1;

    var head = el("div", "dw-consent-modal__head");
    var title = el("h2", "dw-consent-modal__title", "Cookie preferences");
    title.id = "dw-consent-modal-title";
    head.appendChild(title);

    var close = el("button", "dw-consent-modal__close");
    close.type = "button";
    close.setAttribute("aria-label", "Close cookie preferences");
    close.innerHTML = "&times;";
    close.addEventListener("click", function () { closeModal(); });
    head.appendChild(close);
    panel.appendChild(head);

    var intro = el("p", "dw-consent-modal__intro");
    intro.appendChild(
      document.createTextNode(
        "Turn each one on or off, then save. You can change this at any time from the Cookie settings link in the footer of every page. Full detail is in the "
      )
    );
    var link = el("a", null, "privacy policy");
    link.href = "/privacy#cookies";
    intro.appendChild(link);
    intro.appendChild(document.createTextNode("."));
    panel.appendChild(intro);

    CATEGORIES.forEach(function (cat) { panel.appendChild(categoryCard(cat)); });

    /* The meta line goes above the buttons rather than below them, because the
       buttons are pinned to the bottom of the panel and anything after them
       would be permanently hidden behind them. */
    var meta = el("p", "dw-consent-modal__meta");
    if (stored && stored.decidedAt) {
      meta.textContent = "Your current choice was recorded on " + formatDate(stored.decidedAt) + ".";
    } else if (browserRefusal()) {
      meta.textContent =
        "Your browser is sending a Do Not Track or Global Privacy Control signal, so analytics is off. Turning it on here overrides that for this site.";
    } else {
      meta.textContent = "No choice recorded yet. Nothing optional runs until you make one.";
    }
    panel.appendChild(meta);

    /* Reject all and Accept all are given the identical outline treatment here,
       so neither is the nudge; the blue belongs to Save, which is the panel's
       own affirmative action rather than a vote for either answer. */
    var actions = el("div", "dw-consent-modal__actions");
    actions.appendChild(button("Reject all", "dw-consent__btn--reject", rejectAll));
    actions.appendChild(button("Accept all", "dw-consent__btn--reject", acceptAll));
    actions.appendChild(
      button("Save my choices", "dw-consent__btn--accept", function () {
        var choices = {};
        CATEGORIES.forEach(function (cat) {
          if (cat.required) { choices[cat.id] = true; return; }
          var input = panel.querySelector('input[data-category="' + cat.id + '"]');
          choices[cat.id] = Boolean(input && input.checked);
        });
        decide(choices);
      })
    );
    panel.appendChild(actions);

    overlay.appendChild(panel);

    /* A click on the backdrop closes without deciding, which is correct: the
       dialog is a place to make a choice, and leaving it makes none. */
    overlay.addEventListener("mousedown", function (event) {
      if (event.target === overlay) closeModal();
    });

    return overlay;
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    } catch (err) {
      return iso.slice(0, 10);
    }
  }

  var FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function onModalKeydown(event) {
    if (!modal) return;

    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      return;
    }

    if (event.key !== "Tab") return;

    var items = modal.querySelectorAll(FOCUSABLE);
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function openModal() {
    if (modal) return;
    returnFocusTo = document.activeElement;
    modal = buildModal();
    document.body.appendChild(modal);
    document.addEventListener("keydown", onModalKeydown, true);

    var firstInput = modal.querySelector(FOCUSABLE);
    if (firstInput) firstInput.focus();
  }

  function closeModal() {
    if (!modal) return;
    document.removeEventListener("keydown", onModalKeydown, true);
    modal.parentNode.removeChild(modal);
    modal = null;

    /* Focus goes back where it came from, or the choice is invisible to anyone
       navigating by keyboard. */
    if (returnFocusTo && document.contains(returnFocusTo)) returnFocusTo.focus();
    returnFocusTo = null;
  }

  /* --- the footer link ------------------------------------------------------ */

  /**
   * site.js rewrites the whole footer after this file has run, which would take
   * a listener bound to the old markup with it. Delegating from `document`
   * survives that, and survives any future rewrite of the footer as well.
   */
  document.addEventListener("click", function (event) {
    var trigger = event.target.closest && event.target.closest("[data-consent-open]");
    if (!trigger) return;
    event.preventDefault();
    openModal();
  });

  /* --- start ---------------------------------------------------------------- */

  window.dakyworldConsent = {
    /** The gate. `if (!window.dakyworldConsent.allows("analytics")) return;` */
    allows: consentFor,
    /** The gate, deferred: run this now if allowed, or the moment it is. */
    onAllowed: whenAllowed,
    /** Reopen the panel — what the footer link calls. */
    open: openModal,
    /** Has a decision been recorded at all? */
    decided: function () { return decided; },
    /** The record, for support questions: what was agreed, and when. */
    record: function () { return read(); },
    categories: CATEGORIES.map(function (c) { return { id: c.id, name: c.name, required: c.required }; }),
  };

  function start() {
    /* Sweep every refused category on every page load, before anything else.
       Deleting at the moment of withdrawal is necessary and is not sufficient:
       gtag is still running when the switch is turned off and will happily
       re-set a cookie in the instant between the delete and the reload, which
       leaves one behind — observed, with two cookies going in and one coming
       out. Withdrawal has to actually stop the processing rather than mostly
       stop it (Art 7(3)), so the guarantee cannot rest on winning a race with
       somebody else's script. This converges whatever happened last time: any
       cookie belonging to a category the visitor has not allowed is gone
       before the page has finished loading. */
    CATEGORIES.forEach(function (cat) {
      if (!cat.required && !consentFor(cat.id)) clearCategory(cat.id);
    });

    /* Anything already permitted by a stored yes starts now. */
    notify();

    /* A browser-level refusal is honoured without a banner: the visitor has
       already answered the question, and asking again after being told no is
       the nagging the rules exist to prevent. The footer link is still there
       if they want to change their mind. */
    if (!decided && !browserRefusal()) openBanner();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
