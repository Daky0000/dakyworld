/* ==========================================================================
   Dakyworld — product prices, read from the system that owns them.

   The number in the markup is real and correct at publish time, so this page
   is right with JavaScript switched off, right for a crawler, and right for
   anybody whose network drops this request. What this file adds is that a price
   changed in Dakyworld OS reaches the public page without a deploy: the office
   edits one row, and the next visitor sees it.

   Everything here fails silently and leaves the published number alone. A
   pricing block that blanks itself because a fetch failed is worse than one
   that is a week out of date.
   ========================================================================== */
(function () {
  'use strict';

  var SOURCE = 'https://os.dakyworld.com/api/public/products';

  var slots = document.querySelectorAll('[data-dw-price]');
  if (!slots.length || typeof fetch !== 'function') return;

  fetch(SOURCE, { credentials: 'omit', cache: 'no-store' })
    .then(function (response) {
      if (!response.ok) throw new Error('refused');
      return response.json();
    })
    .then(function (catalogue) {
      if (!catalogue || !Array.isArray(catalogue.products)) return;

      var byKey = {};
      catalogue.products.forEach(function (product) {
        byKey[product.key] = product;
      });

      Array.prototype.forEach.call(slots, function (slot) {
        var product = byKey[slot.getAttribute('data-dw-price')];
        if (!product) return;

        var part = slot.getAttribute('data-dw-part') || 'monthly';
        // A setup fee of nothing is a sentence, not a number: "plus GHS 0 once
        // to set it up" reads like an oversight where "no setup fee" reads like
        // the offer it is. The markup says the same, so both agree with no
        // JavaScript.
        var free = Number(product.setup) === 0;
        var next =
          part === 'setup'
            ? product.setupDisplay === null
              ? null
              : free
                ? 'no setup fee'
                : product.currency + ' ' + product.setupDisplay
            : part === 'currency'
              ? product.currency
              : part === 'amount'
                ? product.monthlyDisplay
                : product.currency + ' ' + product.monthlyDisplay;

        if (next === null || next === slot.textContent.trim()) return;
        slot.textContent = next;
        // Only when it actually moved, so a page that is already correct does
        // not announce a change that did not happen.
        slot.setAttribute('data-dw-price-updated', '');
      });
    })
    .then(function () {
      /* ── The same number, in the structured data ────────────────────────
         The page now publishes a SoftwareApplication with an Offer on it, and
         an Offer carrying a price the catalogue has since moved is worse than
         one carrying none: a search engine will quote it. So the offer is
         rewritten from the same response that rewrote the visible price, and
         the two cannot disagree.

         Silent on every failure, exactly like the block above — a page whose
         JSON-LD did not update still has correct JSON-LD, just older. */
      updateOfferSchema();
    })
    .catch(function () {
      /* The published price stands. */
    });

  function updateOfferSchema() {
    var blocks = document.querySelectorAll('script[type="application/ld+json"]');
    Array.prototype.forEach.call(blocks, function (block) {
      var data;
      try {
        data = JSON.parse(block.textContent);
      } catch (err) {
        return;
      }
      var graph = data && data['@graph'];
      if (!Array.isArray(graph)) return;

      var touched = false;
      graph.forEach(function (node) {
        if (!node || node['@type'] !== 'SoftwareApplication' || !node.offers) return;
        // The visible price is already correct by the time this runs, so it is
        // the one thing that does not need fetching twice.
        var slot = document.querySelector('[data-dw-price][data-dw-part="monthly"]');
        if (!slot) return;
        var amount = slot.textContent.replace(/[^0-9.]/g, '');
        if (!amount || node.offers.price === amount) return;
        node.offers.price = amount;
        touched = true;
      });

      if (touched) block.textContent = JSON.stringify(data);
    });
  }
})();
