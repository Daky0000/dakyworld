/* ==========================================================================
   Dakyworld — Website Builder Modern Checkout (ChatGPT / Gemini Standard)
   ========================================================================== */
(function () {
  'use strict';

  var API = 'https://os.dakyworld.com/api/public';
  var checkoutDialog = document.getElementById('builderCheckout');
  var successDialog = document.getElementById('builderSuccess');

  if (!checkoutDialog) return;

  var form = document.getElementById('builderPurchaseForm') || checkoutDialog.querySelector('form');
  var submitBtn = document.getElementById('builderSubmitBtn') || (form ? form.querySelector('[type=submit]') : null);
  var statusEl = document.getElementById('builderFormStatus');
  var closeBtn = document.getElementById('builderCloseBtn');
  var successCloseBtn = document.getElementById('builderSuccessClose');

  var acceptedQuote = null;
  var quoteSelection = '';
  var submitting = false;
  var activeBillingCycle = 'monthly';
  var activePlanKey = 'website-builder';
  var lastScannedWebsiteUrl = '';

  var PLAN_META = {
    'website-builder': {
      title: 'Website Builder',
      monthly: 3,
    },
    'website-care': {
      title: 'Website Care + Builder',
      monthly: 10,
    },
    'managed-website': { title: 'Business Website', monthly: 25 }
  };

  /** How this page writes an amount in the currency it is quoting. */
  function formatMoney(currency, amount, decimals) {
    var body = decimals ? amount.toFixed(2) : amount.toLocaleString();
    return currency === 'USD' ? '$' + body : 'GHS ' + body;
  }

  /** The currency the page is quoting in. assets/pricing.js owns it. */
  function activeCurrency() {
    var pricing = window.DW_PRICING;
    return (pricing && pricing.ready && pricing.currency) || 'GHS';
  }

  function getPlanBaseMonthly(planKey) {
    // The catalogue first: it is the only source that knows both currencies,
    // and it is the same one the server will charge from.
    var pricing = window.DW_PRICING;
    if (pricing && pricing.ready) {
      var price = pricing.priceFor(planKey);
      if (price && !isNaN(parseFloat(price.promoMonthly))) {
        return { currency: pricing.currency, monthly: parseFloat(price.promoMonthly) };
      }
    }
    var slot = document.querySelector('[data-dw-price="' + planKey + '"][data-dw-part="monthly"]') ||
               document.querySelector('[data-dw-price="' + planKey + '"]');
    if (slot) {
      var baseAttr = slot.getAttribute('data-base-monthly');
      if (baseAttr && !isNaN(parseFloat(baseAttr))) {
        // The currency that number is in, written by pricing.js when it set
        // it. Defaulting to dollars here is what made a cedi price — which is
        // what the markup carries and what Ghana pays — render as "$36".
        return { currency: slot.getAttribute('data-dw-currency') || activeCurrency(), monthly: parseFloat(baseAttr) };
      }
      var raw = slot.textContent.trim();
      var m = raw.match(/([A-Z]{3})\s*([\d,]+(?:\.\d{2})?)/i);
      if (m) {
        return { currency: m[1] || 'GHS', monthly: parseFloat((m[2] || '36').replace(/,/g, '')) || 36 };
      }
      var dollars = raw.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
      if (dollars) {
        return { currency: 'USD', monthly: parseFloat(dollars[1].replace(/,/g, '')) || 0 };
      }
    }
    var fallback = PLAN_META[planKey] || PLAN_META['website-builder'];
    return { currency: activeCurrency(), monthly: fallback.monthly };
  }

  /* The plan and cycle radios inside the checkout. Choosing one repoints the
     hidden fields the server reads and repaints the summary beside them. A
     checkout that cannot change the plan makes somebody close it and start
     again from the cards behind it, which is where people abandon. */
  function wireCheckoutChoices() {
    Array.prototype.forEach.call(document.querySelectorAll('input[name="planChoice"]'), function (radio) {
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        activePlanKey = radio.value;
        if (form && form.elements.productKey) form.elements.productKey.value = radio.value;
        syncModalPrices(activePlanKey);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="cycleChoice"]'), function (radio) {
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        activeBillingCycle = radio.value;
        if (form && form.elements.billingCycle) form.elements.billingCycle.value = radio.value;
        updatePricingCardsDisplay();
      });
    });
  }

  /** The price on each plan card inside the checkout, in the active currency. */
  function paintPlanOptions() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-plan-price]'), function (el) {
      var key = el.getAttribute('data-plan-price');
      var planInfo = getPlanBaseMonthly(key);
      var amount = activeBillingCycle === 'annual' ? planInfo.monthly * 10 : planInfo.monthly;
      el.textContent = formatMoney(planInfo.currency, amount, false);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.builder-plan-option-cycle'), function (el) {
      el.textContent = activeBillingCycle === 'annual' ? 'Billed annually' : 'Billed monthly';
    });
  }

  function updatePricingCardsDisplay() {
    var isAnnual = activeBillingCycle === 'annual';
    ['website-builder', 'website-care'].forEach(function (key) {
      var info = getPlanBaseMonthly(key);
      var displayAmount = isAnnual ? info.monthly * 10 : info.monthly;
      var formatted = formatMoney(info.currency, displayAmount, false);
      var slot = document.querySelector('[data-dw-price="' + key + '"][data-dw-part="monthly"]');
      if (slot) slot.textContent = formatted;
    });
    Array.prototype.forEach.call(document.querySelectorAll('.dw-cycle-label'), function (el) {
      el.textContent = isAnnual ? '/year (2 months free)' : '/month';
    });

    var btnMonthly = document.getElementById('dwCycleMonthly');
    var btnAnnual = document.getElementById('dwCycleAnnual');
    if (btnMonthly && btnAnnual) {
      if (isAnnual) {
        btnAnnual.style.background = '#08101f';
        btnAnnual.style.color = '#ffffff';
        btnMonthly.style.background = 'transparent';
        btnMonthly.style.color = '#08101f';
      } else {
        btnMonthly.style.background = '#08101f';
        btnMonthly.style.color = '#ffffff';
        btnAnnual.style.background = 'transparent';
        btnAnnual.style.color = '#08101f';
      }
    }
    syncModalPrices(activePlanKey);
  }

  // Sync pricing numbers across checkout modal from live catalogue slots if present
  function syncModalPrices(planKey) {
    var key = planKey || activePlanKey || 'website-builder';
    var meta = PLAN_META[key] || PLAN_META['website-builder'];
    var info = getPlanBaseMonthly(key);
    var isAnnual = activeBillingCycle === 'annual';
    var numeric = isAnnual ? info.monthly * 10 : info.monthly;
    var currency = info.currency || 'GHS';
    var amountStr = formatMoney(currency, numeric, false);
    var formattedTotal = formatMoney(currency, numeric, true);

    // The charge must be raised in the currency this summary quotes. Without
    // the field the server falls back to the country the request appears to
    // come from, which is a guess about somebody who has already told us.
    var currencyField = document.getElementById('builderCurrencyField');
    if (currencyField) currencyField.value = currency;
    paintPlanOptions();

    var summaryTitle = document.getElementById('builderSummaryPlanTitle');
    if (summaryTitle) summaryTitle.textContent = meta.title;

    var checkoutTitle = document.getElementById('builderCheckoutTitle');
    if (checkoutTitle) checkoutTitle.textContent = 'Purchase ' + meta.title;

    var lineLabel = document.getElementById('builderLineLabel');
    if (lineLabel) {
      lineLabel.textContent = meta.title + (isAnnual ? ' (Annual — 2 Months Free)' : ' (Month 1)');
    }

    var summaryCycle = document.getElementById('builderSummaryCycle');
    if (summaryCycle) summaryCycle.textContent = isAnnual ? '/year' : '/month';

    var summaryRenews = document.getElementById('builderSummaryRenews');
    if (summaryRenews) {
      summaryRenews.textContent = isAnnual
        ? 'Billed annually (2 months free) · Cancel anytime'
        : 'Billed monthly · Cancel anytime';
    }

    var btnAmount = document.getElementById('builderBtnAmount');
    if (btnAmount) btnAmount.textContent = amountStr;

    var lineMonthly = document.getElementById('builderLineMonthly');
    if (lineMonthly) lineMonthly.textContent = formattedTotal;

    var lineTotal = document.getElementById('builderLineTotal');
    if (lineTotal) lineTotal.textContent = formattedTotal;

    var sumVal = checkoutDialog.querySelector('.builder-sum-val');
    if (sumVal) sumVal.textContent = numeric.toLocaleString();

    var sumCurr = checkoutDialog.querySelector('.builder-sum-curr');
    if (sumCurr) sumCurr.textContent = currency === 'USD' ? '$' : 'GHS';
  }

  wireCheckoutChoices();

  /* pricing.js has repainted the cards in a new currency. Everything this file
     draws is derived from those numbers, so it is all drawn again - including
     the annual multiple, which pricing.js does not know about and has just
     overwritten with the monthly price. */
  window.addEventListener('dw-currency-change', function () {
    updatePricingCardsDisplay();
  });

  // Wire up Monthly / Annual Billing Toggle buttons
  Array.prototype.forEach.call(document.querySelectorAll('[data-billing-cycle]'), function (btn) {
    btn.addEventListener('click', function () {
      var cycle = btn.getAttribute('data-billing-cycle');
      if (cycle === 'annual' || cycle === 'monthly') {
        activeBillingCycle = cycle;
        if (form && form.elements.billingCycle) {
          form.elements.billingCycle.value = cycle;
        }
        updatePricingCardsDisplay();
      }
    });
  });

  // Wire up Interactive Live Website Scanner & AI Agent Sandbox
  var scanForm = document.getElementById('dwLiveScanForm');
  var scanInput = document.getElementById('dwLiveScanUrl');
  var scanBtn = document.getElementById('dwLiveScanBtn');
  var previewHeading = document.getElementById('dwInteractiveHeading');
  var previewCta = document.getElementById('dwInteractiveCta');
  var previewStatus = document.getElementById('dwPreviewStatusBadge');
  var previewStats = document.getElementById('dwPreviewStatsPill');
  var previewNotes = document.getElementById('dwPreviewNotes');
  var agentFeedback = document.getElementById('dwAgentDemoFeedback');

  if (scanForm && scanInput) {
    scanForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var rawUrl = (scanInput.value || '').trim();
      if (!rawUrl) return;
      if (!/^https?:\/\//i.test(rawUrl)) {
        rawUrl = 'https://' + rawUrl;
        scanInput.value = rawUrl;
      }
      lastScannedWebsiteUrl = rawUrl;
      if (scanBtn) {
        scanBtn.disabled = true;
        scanBtn.textContent = 'Scanning live site…';
      }
      if (previewStatus) {
        previewStatus.textContent = '⏳ Reading ' + rawUrl + '…';
      }

      fetch(API + '/website-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ websiteUrl: rawUrl })
      })
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (result) {
          if (scanBtn) {
            scanBtn.disabled = false;
            scanBtn.innerHTML = 'Scan My Website &rarr;';
          }
          if (!result.ok || !result.data) {
            throw new Error((result.data && result.data.error) || 'Could not inspect website.');
          }
          var info = result.data;
          if (previewStatus) {
            previewStatus.innerHTML = info.status === 'NOT_SUPPORTED'
              ? '&#9888; Migration Recommended &middot; ' + info.pageTitle
              : '&#10003; Compatible &middot; ' + info.pageTitle;
          }
          if (previewStats && info.stats) {
            previewStats.textContent = info.stats.editableFields + ' editable fields · ' + info.stats.sectionsCount + ' sections';
          }
          if (previewHeading && info.sampleFields && info.sampleFields[0]) {
            previewHeading.textContent = info.sampleFields[0].value || info.pageTitle;
          }
          if (previewNotes && info.notes) {
            previewNotes.textContent = info.notes;
          }
          if (agentFeedback) {
            agentFeedback.textContent = '✓ Scanned ' + info.pageTitle + '! Click the heading on the left to type, or test an AI command.';
          }
        })
        .catch(function () {
          if (scanBtn) {
            scanBtn.disabled = false;
            scanBtn.innerHTML = 'Scan My Website &rarr;';
          }
          var host = rawUrl.replace(/^https?:\/\//i, '').split('/')[0] || 'your site';
          if (previewStatus) {
            previewStatus.innerHTML = '&#10003; Ready to Connect &middot; ' + host;
          }
          if (previewHeading) {
            previewHeading.textContent = 'Welcome to ' + host + ' — click here to edit this headline live.';
          }
          if (agentFeedback) {
            agentFeedback.textContent = '✓ Interactive preview ready for ' + host + ' — click any AI command above!';
          }
        });
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-demo-action]'), function (chip) {
    chip.addEventListener('click', function () {
      var action = chip.getAttribute('data-demo-action');
      if (action === 'color-emerald' && previewCta) {
        previewCta.style.background = '#059669';
        if (agentFeedback) agentFeedback.textContent = '✓ AI Agent updated CTA button background-color to #059669 across all pages!';
      } else if (action === 'color-blue' && previewCta) {
        previewCta.style.background = '#3157ff';
        if (agentFeedback) agentFeedback.textContent = '✓ AI Agent restored CTA button background-color to #3157FF!';
      } else if (action === 'rewrite-headline' && previewHeading) {
        previewHeading.textContent = 'Edit every word, photo and button on your live website in seconds — zero code required.';
        if (agentFeedback) agentFeedback.textContent = '✓ AI Agent rewrote the hero headline for clarity and conversion!';
      } else if (action === 'font-serif' && previewHeading) {
        previewHeading.style.fontFamily = 'Georgia, "Times New Roman", serif';
        if (agentFeedback) agentFeedback.textContent = '✓ AI Agent switched heading typography to Editorial Serif!';
      }
    });
  });

  // Handle post-purchase return from Paystack
  var searchParams = new URLSearchParams(window.location.search);
  if (searchParams.get('payment') === 'returned') {
    var priceSection = document.getElementById('price');
    var note = document.createElement('p');
    note.className = 'builder-payment-return';
    note.setAttribute('role', 'status');
    note.textContent = 'Payment confirmation pending. Do not pay again while confirmation is pending.';
    if (priceSection) priceSection.prepend(note);
    var savedKey;
    try { savedKey = sessionStorage.getItem('dakyworld.checkoutKey'); } catch (_) {}
    var polls = 0;
    function checkReturnedPayment() {
      if (!savedKey) { note.textContent = 'Payment must be verified by Dakyworld. Contact support with your Paystack reference before paying again.'; return; }
      fetch(API + '/website-payment-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkoutKey: savedKey }), signal: AbortSignal.timeout(15000) })
        .then(function (response) { if (!response.ok) throw new Error('pending'); return response.json(); })
        .then(function (body) {
          if (body.paid) {
            note.textContent = 'Payment verified. Website setup is pending; subscription status will be confirmed separately.';
            return;
          }
          if (++polls < 12) setTimeout(checkReturnedPayment, 5000);
          else note.textContent = 'Payment is still pending. Contact support before paying again if your card was debited.';
        }).catch(function () { note.textContent = 'Confirmation is temporarily unavailable. Contact support before paying again if your card was debited.'; });
    }
    checkReturnedPayment();
    if (window.history && window.history.replaceState) window.history.replaceState(null, '', window.location.pathname + (window.location.hash || ''));
  }

  if (successCloseBtn && successDialog) {
    successCloseBtn.addEventListener('click', function () {
      successDialog.close();
    });
  }

  function setStatus(message, type) {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.className = 'builder-form-status' + (type ? ' ' + type : '');
  }

  function openCheckout(plan) {
    activePlanKey = (plan === 'website-care') ? 'website-care' : 'website-builder';
    syncModalPrices(activePlanKey);
    if (form) {
      form.reset();
      form.elements.productKey.value = activePlanKey;
      if (form.elements.billingCycle) {
        form.elements.billingCycle.value = activeBillingCycle;
      }
      if (form.elements.websiteUrl && (lastScannedWebsiteUrl || (scanInput && scanInput.value && scanInput.value !== 'https://dakyworld.com'))) {
        form.elements.websiteUrl.value = lastScannedWebsiteUrl || scanInput.value.trim();
      }
      // Remove any invalid field highlights
      var inputs = form.querySelectorAll('input, textarea');
      Array.prototype.forEach.call(inputs, function (input) {
        input.classList.remove('invalid');
      });
    }
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.classList.remove('loading');
    }
    setStatus('', '');

    if (typeof checkoutDialog.showModal === 'function') {
      checkoutDialog.showModal();
    } else {
      checkoutDialog.setAttribute('open', '');
    }

    // Auto focus first relevant input
    var firstInput = form ? form.querySelector('#dw-email') || form.querySelector('input') : null;
    if (firstInput) {
      setTimeout(function () { firstInput.focus(); }, 80);
    }
  }

  function closeCheckout() {
    if (typeof checkoutDialog.close === 'function') {
      checkoutDialog.close();
    } else {
      checkoutDialog.removeAttribute('open');
    }
  }

  // Backdrop click close support
  checkoutDialog.addEventListener('click', function (event) {
    var rect = checkoutDialog.getBoundingClientRect();
    var isInDialog = (
      rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width
    );
    if (!isInDialog) {
      closeCheckout();
    }
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', function (e) {
      e.preventDefault();
      closeCheckout();
    });
  }

  // Wire up all CTA purchase buttons across the page
  Array.prototype.forEach.call(document.querySelectorAll('[data-purchase-plan]'), function (button) {
    button.addEventListener('click', function (e) {
      e.preventDefault();
      openCheckout(button.getAttribute('data-purchase-plan') || 'website-builder');
    });
  });

  // Check URL params for direct checkout opening (?purchase=website-builder or ?buy=website-builder or ?checkout=true)
  if (searchParams.get('purchase') || searchParams.get('buy') || searchParams.get('plan') === 'website-builder' || searchParams.get('plan') === 'website-care' || searchParams.get('checkout') === 'true') {
    openCheckout(searchParams.get('purchase') || searchParams.get('buy') || searchParams.get('plan') || 'website-builder');
  }

  // Form submission handler
  if (form) {
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (submitting) return;

      // Normalize website URL if user typed 'example.com' without protocol
      var urlInput = form.elements.websiteUrl;
      if (urlInput && urlInput.value) {
        var trimmedUrl = urlInput.value.trim();
        if (trimmedUrl && !/^https?:\/\//i.test(trimmedUrl)) {
          urlInput.value = 'https://' + trimmedUrl;
        }
      }

      // Validate required inputs
      var hasError = false;
      var firstBad = null;
      var requiredFields = ['email', 'contactName', 'businessName', 'websiteUrl'];
      requiredFields.forEach(function (name) {
        var field = form.elements[name];
        if (field) {
          if (!field.value || !field.value.trim() || !field.checkValidity()) {
            field.classList.add('invalid');
            hasError = true;
            if (!firstBad) firstBad = field;
          } else {
            field.classList.remove('invalid');
          }
        }
      });

      if (hasError) {
        setStatus('Please complete all required fields with valid details.', 'error');
        if (firstBad) firstBad.focus();
        return;
      }

      var payload = {};
      new FormData(form).forEach(function (value, key) {
        payload[key] = typeof value === 'string' ? value.trim() : value;
      });

      // The currency is part of what was quoted. Leaving it out of the key
      // meant switching currency kept an accepted quote for the other one, and
      // the server recomputes the quote to verify `quoteId` — so the purchase
      // would be refused with nothing on screen explaining why.
      var selection = payload.productKey + ':' + payload.billingCycle + ':' + (payload.currency || 'GHS');
      var consent = form.elements.recurringConsent;
      if (!acceptedQuote || quoteSelection !== selection) {
        submitting = true;
        if (submitBtn) submitBtn.disabled = true;
        try {
          var quoteResponse = await fetch(
            API + '/website-payment-quote?productKey=' + encodeURIComponent(payload.productKey) +
            '&billingCycle=' + encodeURIComponent(payload.billingCycle) +
            '&currency=' + encodeURIComponent(payload.currency || 'GHS'),
            { signal: AbortSignal.timeout(15000) }
          );
          var quoteBody = await quoteResponse.json();
          if (!quoteResponse.ok) throw new Error(quoteBody.error || 'Could not load the payment quote.');
          acceptedQuote = quoteBody;
          // Every figure below is written in the currency the quote came back
          // in. Hardcoding GHS printed cedi labels over dollar amounts for
          // every customer outside Ghana.
          var qc = quoteBody.currency === 'USD' ? 'USD' : 'GHS';
          var qmoney = function (amount) { return formatMoney(qc, amount, true); };
          var quoteAmount = document.getElementById("builderBtnAmount");
          if (quoteAmount) quoteAmount.textContent = qmoney(quoteBody.upfront);
          quoteSelection = selection;
          if (consent) consent.checked = false;
          var terms = document.getElementById('builderBillingTerms');
          var renewal = quoteBody.billingCycle === 'annual'
            ? 'Then ' + qmoney(quoteBody.standard) + ' every year.'
            : qmoney(quoteBody.recurring) + ' per month for the first ' + (quoteBody.promoMonths || 3) + ' months, then ' + qmoney(quoteBody.standard) + ' per month.';
          // The rate is stated only where it was actually applied. Printing
          // "USD 1 = GHS 12" on a dollar purchase describes a conversion that
          // did not happen to that customer.
          var rateNote = qc === 'GHS' ? ' USD 1 = GHS ' + quoteBody.usdToGhs + '.' : '';
          if (terms) terms.textContent = 'Pay ' + qmoney(quoteBody.upfront) + ' now. ' + renewal + rateNote + ' Your card issuer may apply conversion fees. Recurring billing uses a reusable card. Cancel through your Paystack subscription email or contact support.';
          setStatus('Review the price below, accept recurring billing, then continue to Paystack.', 'info');
        } catch (error) { setStatus(error.message || 'Could not load the payment quote.', 'error'); }
        submitting = false;
        if (submitBtn) submitBtn.disabled = false;
        return;
      }
      if (!consent || !consent.checked) { setStatus('Accept the displayed recurring billing terms to continue.', 'error'); return; }
      payload.recurringConsent = true;
      payload.quoteId = acceptedQuote.quoteId;
      var details = JSON.stringify(payload);
      try {
        if (sessionStorage.getItem('dakyworld.checkoutDetails') !== details) {
          sessionStorage.setItem('dakyworld.checkoutKey', crypto.randomUUID());
          sessionStorage.setItem('dakyworld.checkoutDetails', details);
        }
        payload.checkoutKey = sessionStorage.getItem('dakyworld.checkoutKey');
      } catch (_) { setStatus('Allow session storage to keep payment retries safe, then try again.', 'error'); return; }
      submitting = true;

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add('loading');
      }

      setStatus('Verifying details & website compatibility…', 'info');

      var progressTimer = setTimeout(function () {
        setStatus('Generating secure checkout session…', 'info');
      }, 1200);

      var redirectTimer = setTimeout(function () {
        setStatus('Connecting to Paystack secure payment…', 'info');
      }, 2500);

      fetch(API + '/website-purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45000)
      })
        .then(function (response) {
          clearTimeout(progressTimer);
          clearTimeout(redirectTimer);
          return response.json().then(function (body) {
            if (!response.ok) {
              throw new Error(body.error || 'Checkout could not be completed.');
            }
            return body;
          });
        })
        .then(function (body) {
          var paymentUrl = new URL(body.paymentUrl);
          if (paymentUrl.protocol === 'https:' && paymentUrl.hostname === 'checkout.paystack.com' && !paymentUrl.username && !paymentUrl.password) {
            setStatus('Redirecting to Paystack secure checkout…', 'info');
            window.location.assign(body.paymentUrl);
          } else {
            throw new Error('Payment gateway did not return a checkout session.');
          }
        })
        .catch(function (error) {
          clearTimeout(progressTimer);
          clearTimeout(redirectTimer);
          submitting = false;
          acceptedQuote = null;
          if (consent) consent.checked = false;
          var msg = error.message || 'An unexpected error occurred.';
          var unavailable = /unauthor|not found|answered 404|answered 401|offline|fetch/i.test(msg);
          if (unavailable) {
            setStatus('Online checkout is temporarily unavailable. Contact info@dakyworld.com or call +233 545 950 611 for direct setup.', 'error');
          } else {
            setStatus(msg, 'error');
          }
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.classList.remove('loading');
          }
        });
    });

    // Remove invalid red border on typing
    form.addEventListener('input', function (event) {
      if (event.target && event.target.classList) {
        event.target.classList.remove('invalid');
      }
    });
  }

  // Observe price updates by pricing.js if it runs later
  var observer = new MutationObserver(function () {
    syncModalPrices();
  });
  var priceEl = document.querySelector('[data-dw-price="website-builder"]');
  if (priceEl) {
    observer.observe(priceEl, { childList: true, characterData: true, subtree: true });
  }
})();
