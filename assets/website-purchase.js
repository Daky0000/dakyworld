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

  var activeBillingCycle = 'monthly';
  var activePlanKey = 'website-builder';
  var lastScannedWebsiteUrl = '';

  var PLAN_META = {
    'website-builder': {
      title: 'Website Builder',
      monthly: 300,
    },
    'website-care': {
      title: 'Website Care + Builder',
      monthly: 750,
    }
  };

  function getPlanBaseMonthly(planKey) {
    var slot = document.querySelector('[data-dw-price="' + planKey + '"][data-dw-part="monthly"]') ||
               document.querySelector('[data-dw-price="' + planKey + '"]');
    if (slot) {
      var baseAttr = slot.getAttribute('data-base-monthly');
      if (baseAttr && !isNaN(parseFloat(baseAttr))) {
        return { currency: 'GHS', monthly: parseFloat(baseAttr) };
      }
      var raw = slot.textContent.trim();
      var m = raw.match(/([A-Z]{3})\s*([\d,]+(?:\.\d{2})?)/i);
      if (m) {
        return { currency: m[1] || 'GHS', monthly: parseFloat((m[2] || '300').replace(/,/g, '')) || 300 };
      }
    }
    var fallback = PLAN_META[planKey] || PLAN_META['website-builder'];
    return { currency: 'GHS', monthly: fallback.monthly };
  }

  function updatePricingCardsDisplay() {
    var isAnnual = activeBillingCycle === 'annual';
    ['website-builder', 'website-care'].forEach(function (key) {
      var info = getPlanBaseMonthly(key);
      var displayAmount = isAnnual ? info.monthly * 10 : info.monthly;
      var formatted = info.currency + ' ' + displayAmount.toLocaleString();
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
    var amountStr = numeric.toLocaleString();
    var formattedTotal = currency + ' ' + numeric.toFixed(2);

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
    if (btnAmount) btnAmount.textContent = currency + ' ' + amountStr;

    var lineMonthly = document.getElementById('builderLineMonthly');
    if (lineMonthly) lineMonthly.textContent = formattedTotal;

    var lineTotal = document.getElementById('builderLineTotal');
    if (lineTotal) lineTotal.textContent = formattedTotal;

    var sumVal = checkoutDialog.querySelector('.builder-sum-val');
    if (sumVal) sumVal.textContent = amountStr;

    var sumCurr = checkoutDialog.querySelector('.builder-sum-curr');
    if (sumCurr) sumCurr.textContent = currency;
  }

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
    if (successDialog && typeof successDialog.showModal === 'function') {
      successDialog.showModal();
    } else {
      var priceSection = document.getElementById('price');
      if (priceSection) {
        var note = document.createElement('p');
        note.className = 'builder-payment-return';
        note.setAttribute('role', 'status');
        note.textContent = '🎉 Payment received! Paystack returned you to Dakyworld. We are confirming your setup and will email your next steps.';
        var wrap = priceSection.querySelector('.wrap') || priceSection;
        wrap.insertBefore(note, wrap.firstChild);
      }
    }
    // Clean URL query parameter without refreshing
    if (window.history && window.history.replaceState) {
      var cleanUrl = window.location.pathname + (window.location.hash || '');
      window.history.replaceState(null, '', cleanUrl);
    }
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
    form.addEventListener('submit', function (event) {
      event.preventDefault();

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
        body: JSON.stringify(payload)
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
          if (body.paymentUrl) {
            setStatus('Redirecting to Paystack secure checkout…', 'info');
            window.location.assign(body.paymentUrl);
          } else {
            throw new Error('Payment gateway did not return a checkout session.');
          }
        })
        .catch(function (error) {
          clearTimeout(progressTimer);
          clearTimeout(redirectTimer);
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
