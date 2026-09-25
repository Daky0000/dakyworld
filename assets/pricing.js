/* ==========================================================================
   Dakyworld — product prices, read from the system that owns them.

   The number in the markup is real and correct at publish time, so this page
   is right with JavaScript switched off, right for a crawler, and right for
   anybody whose network drops this request. What this file adds is that a price
   changed in Dakyworld OS reaches the public page without a deploy.

   It also decides which currency the page quotes in. There is one price list,
   authored in dollars: Ghana is quoted the cedi conversion, everywhere else the
   dollars, and a visitor can switch. Cedis are what the markup carries, so a
   failure here leaves a correct Ghanaian price rather than a blank — and
   dollars appear only when the catalogue says the processor can settle them,
   because a page that offers a currency the checkout would refuse quotes a
   price and then declines the card.

   Everything here fails silently and leaves the published number alone. A
   pricing block that blanks itself because a fetch failed is worse than one
   that is a week out of date.
   ========================================================================== */
(function () {
  'use strict';

  var SOURCE = 'https://os.dakyworld.com/api/public/products';
  var STORAGE_KEY = 'dw-currency';

  var slots = document.querySelectorAll('[data-dw-price]');
  var choice = document.getElementById('dwCurrencyChoice');
  if ((!slots.length && !choice) || typeof fetch !== 'function') return;

  /* The catalogue as this page resolved it, for the checkout to read rather
     than keep a second copy of. `currency` is what the page is quoting now. */
  var state = (window.DW_PRICING = {
    ready: false,
    currency: 'GHS',
    currencies: ['GHS'],
    products: {},
    /** What one plan costs in the active currency, or null if unknown. */
    priceFor: function (key) {
      var product = state.products[key];
      if (!product || !product.prices) return null;
      return product.prices[state.currency] || null;
    }
  });

  function remembered() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (err) { return null; }
  }
  function remember(code) {
    try { localStorage.setItem(STORAGE_KEY, code); } catch (err) { /* private window */ }
  }

  fetch(SOURCE, { credentials: 'omit', cache: 'no-store' })
    .then(function (response) {
      if (!response.ok) throw new Error('refused');
      return response.json();
    })
    .then(function (catalogue) {
      if (!catalogue || !Array.isArray(catalogue.products)) return;

      catalogue.products.forEach(function (product) {
        state.products[product.key] = product;
      });

      // Only what the catalogue says can be charged. An older deployment of
      // the API does not publish this list, and then cedis are the only
      // answer — which is exactly what the page already says.
      state.currencies =
        Array.isArray(catalogue.currencies) && catalogue.currencies.length
          ? catalogue.currencies
          : ['GHS'];

      var saved = remembered();
      var preferred =
        saved && state.currencies.indexOf(saved) !== -1
          ? saved
          : catalogue.defaultCurrency && state.currencies.indexOf(catalogue.defaultCurrency) !== -1
            ? catalogue.defaultCurrency
            : state.currencies[0];

      state.ready = true;
      setCurrency(preferred, false);
      mountCurrencyChoice();
    })
    .catch(function () {
      /* The published price stands. */
    });

  /* ── Rendering ─────────────────────────────────────────────────────────── */

  function setCurrency(code, persist) {
    if (state.currencies.indexOf(code) === -1) return;
    state.currency = code;
    if (persist) remember(code);
    paint();
    paintChoice();
    updateOfferSchema();
    // The checkout listens for this rather than polling the DOM, so the
    // summary beside the form and the amount charged cannot drift apart.
    try {
      window.dispatchEvent(new CustomEvent('dw-currency-change', { detail: { currency: code } }));
    } catch (err) {
      /* An old browser without CustomEvent still gets correct prices. */
    }
  }

  function paint() {
    Array.prototype.forEach.call(slots, function (slot) {
      var product = state.products[slot.getAttribute('data-dw-price')];
      if (!product) return;
      var price = product.prices && product.prices[state.currency];
      var part = slot.getAttribute('data-dw-part') || 'monthly';
      // A setup fee of nothing is a sentence, not a number: "plus GHS 0 once
      // to set it up" reads like an oversight where "no setup fee" reads like
      // the offer it is. The markup says the same, so both agree with no
      // JavaScript.
      var free = Number(product.setup) === 0 || product.setup === null;
      var next;

      if (part === 'setup') {
        next = product.setupDisplay === null || product.setupDisplay === undefined
          ? (free ? 'no setup fee' : null)
          : (free ? 'no setup fee' : symbolFor(state.currency) + product.setupDisplay);
      } else if (part === 'currency') {
        next = state.currency;
      } else if (part === 'amount') {
        next = price ? price.promoDisplay : product.monthlyDisplay;
      } else if (part === 'standard') {
        next = price ? price.standardLabel : null;
      } else {
        next = price ? price.promoLabel : null;
      }

      if (next === null || next === undefined) return;
      // The bare amount, for anything that has to do arithmetic with it — the
      // checkout's annual multiplier, mainly — and the currency it is in.
      // Assuming cedis here is what made a dollar price render as "GHS 3".
      if (price) {
        slot.setAttribute('data-base-monthly', price.promoMonthly);
        slot.setAttribute('data-dw-currency', state.currency);
      }
      if (next === slot.textContent.trim()) return;
      slot.textContent = next;
      slot.setAttribute('data-dw-price-updated', '');
    });
  }

  function symbolFor(code) {
    return code === 'USD' ? '$' : 'GHS ';
  }

  /* ── The currency switch ───────────────────────────────────────────────── */

  function mountCurrencyChoice() {
    if (!choice) return;
    // One currency is not a choice. Left hidden, the page reads exactly as it
    // did before dollars were offered at all.
    if (state.currencies.length < 2) return;

    Array.prototype.forEach.call(choice.querySelectorAll('[data-dw-currency-choice]'), function (button) {
      var code = button.getAttribute('data-dw-currency-choice');
      // A button for a currency the processor cannot settle is removed rather
      // than disabled: there is nothing the visitor could do about it.
      if (state.currencies.indexOf(code) === -1) {
        if (button.parentNode) button.parentNode.removeChild(button);
        return;
      }
      button.addEventListener('click', function () { setCurrency(code, true); });
    });

    choice.hidden = false;
    paintChoice();
  }

  function paintChoice() {
    if (!choice || choice.hidden) return;
    Array.prototype.forEach.call(choice.querySelectorAll('[data-dw-currency-choice]'), function (button) {
      var on = button.getAttribute('data-dw-currency-choice') === state.currency;
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
      button.style.background = on ? '#08101f' : 'transparent';
      button.style.color = on ? '#ffffff' : '#08101f';
    });
  }

  /* ── The same number, in the structured data ────────────────────────────
     An Offer carrying a price the catalogue has since moved is worse than one
     carrying none: a search engine will quote it. So the offer is rewritten
     from the same response that rewrote the visible price, and the currency
     moves with the number — an Offer saying GHS over a dollar amount is a
     wrong price published in machine-readable form. */
  function updateOfferSchema() {
    var blocks = document.querySelectorAll('script[type="application/ld+json"]');
    Array.prototype.forEach.call(blocks, function (block) {
      var data;
      try { data = JSON.parse(block.textContent); } catch (err) { return; }
      var graph = data && data['@graph'];
      if (!Array.isArray(graph)) return;

      var touched = false;
      graph.forEach(function (node) {
        if (!node || node['@type'] !== 'SoftwareApplication' || !node.offers) return;
        var slot = document.querySelector('[data-dw-price][data-dw-part="monthly"]');
        if (!slot) return;
        var amount = slot.textContent.replace(/[^0-9.]/g, '');
        if (!amount) return;
        if (node.offers.price === amount && node.offers.priceCurrency === state.currency) return;
        node.offers.price = amount;
        node.offers.priceCurrency = state.currency;
        touched = true;
      });

      if (touched) block.textContent = JSON.stringify(data);
    });
  }
})();
