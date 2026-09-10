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
        var next =
          part === 'setup'
            ? product.setupDisplay === null
              ? null
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
    .catch(function () {
      /* The published price stands. */
    });
})();
