/* The monthly-plan checkout on /retainer-checkout?plan=…
   Shows the one plan picked on /pricing and asks monthly or yearly. Sends the
   form to the OS, which writes the plan and its first invoice and answers with
   a Paystack page to pay it on. Paying is what starts the plan, so nothing
   here claims a purchase happened.

   Prices must match the cards on pricing.html. The server charges what the
   site publishes (priceForTier), so a mismatch here shows one number and
   charges another. */
(function () {
  'use strict';

  var API = 'https://os.dakyx.com/api/public';
  var PLANS = {
    foundation: { label: 'Foundation', promo: 3150, standard: 4500, desc: 'One primary website and essential digital support' },
    growth: { label: 'Growth', promo: 8400, standard: 12000, desc: 'Development, automation, integrations and priority support' },
    transformation: { label: 'Transformation', promo: 19600, standard: 28000, desc: 'Advanced systems, higher capacity and emergency cover' }
  };

  var form = document.getElementById('retainerForm');
  if (!form) return;

  var params = new URLSearchParams(window.location.search);
  var key = params.get('plan');
  if (!PLANS[key]) {
    // Nothing chosen, so there is nothing to subscribe to: back to the plans.
    window.location.replace('/pricing#plans');
    return;
  }
  var plan = PLANS[key];

  var status = document.getElementById('retainerStatus');
  var submit = document.getElementById('retainerSubmit');

  function money(amount) {
    return 'GHS ' + Number(amount).toLocaleString('en-GB');
  }
  function set(id, text) {
    document.getElementById(id).textContent = text;
  }
  function cycle() {
    var checked = form.querySelector('input[name="billingCycle"]:checked');
    return checked ? checked.value : 'monthly';
  }

  document.getElementById('retainerPlan').value = key;
  document.title = 'Subscribe to ' + plan.label + ' | DakyXTech®';
  set('retainerTitle', 'Subscribe to ' + plan.label);
  set('retainerPlanName', plan.label);
  set('retainerPlanDesc', plan.desc);
  set('retainerSummaryTitle', plan.label);
  set('retainerMonthlyPrice', money(plan.promo) + '/month');
  set('retainerMonthlyAfter', 'Then ' + money(plan.standard) + '/month from month 4');
  set('retainerAnnualPrice', money(plan.promo * 12) + '/year');
  set('retainerAnnualPer', money(plan.promo) + '/month, paid once');
  // Against paying monthly for the same first year: 3 discounted + 9 standard.
  set('retainerAnnualSave', 'Save ' + money(9 * (plan.standard - plan.promo)));

  function render() {
    var annual = cycle() === 'annual';
    var today = annual ? plan.promo * 12 : plan.promo;
    set('retainerSummaryPrice', today.toLocaleString('en-GB'));
    set('retainerSummaryCycle', annual ? '/year' : '/month');
    set('retainerSummaryRenews', annual ? money(plan.promo) + '/month for twelve months, paid once' : '30% off for your first three months');
    set('retainerLinePromoLabel', annual ? '12 months × ' + money(plan.promo) : 'Months 1–3');
    set('retainerLinePromo', annual ? money(plan.promo * 12) : money(plan.promo) + '/month');
    set('retainerLineStandardLabel', annual ? 'From month 13' : 'From month 4');
    set('retainerLineStandard', money(plan.standard) + '/month');
    set('retainerLineTotal', money(today));
    set('retainerBtnAmount', money(today));
    set('retainerTerms', annual
      ? 'Today you pay ' + money(today) + ' for twelve months of ' + plan.label + ' at ' + money(plan.promo) +
        ' a month. From month 13 the plan continues at ' + money(plan.standard) + ' a month, invoiced to your email, unless you cancel.'
      : 'Today you pay ' + money(plan.promo) + ' for your first month of ' + plan.label + '. Months two and three are ' +
        money(plan.promo) + ', and from month four the plan is ' + money(plan.standard) + ' a month. Each later month is invoiced to your email.');
  }

  function say(message, kind) {
    status.textContent = message;
    status.className = 'builder-form-status' + (message ? ' ' + (kind || 'error') : '');
  }

  if (params.get('payment') === 'returned') document.getElementById('retainerReturned').hidden = false;
  if (params.get('cycle') === 'annual') form.querySelector('input[name="billingCycle"][value="annual"]').checked = true;

  form.addEventListener('change', function (event) {
    if (event.target && event.target.name === 'billingCycle') render();
  });
  render();

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    say('');
    var data = new FormData(form);
    var payload = {
      plan: key,
      billingCycle: cycle(),
      recurringConsent: data.get('recurringConsent') === 'on',
      email: String(data.get('email') || '').trim(),
      contactName: String(data.get('contactName') || '').trim(),
      businessName: String(data.get('businessName') || '').trim(),
      callbackUrl: window.location.origin + window.location.pathname + '?payment=returned&plan=' + key
    };
    var phone = String(data.get('phone') || '').trim();
    var notes = String(data.get('notes') || '').trim();
    if (phone) payload.phone = phone;
    if (notes) payload.notes = notes;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return say('Enter a valid email address.');
    if (payload.contactName.length < 2) return say('Enter your name.');
    if (payload.businessName.length < 2) return say('Enter your business name.');
    if (!payload.recurringConsent) return say('Tick the box to agree to the price and the terms.');

    submit.disabled = true;
    submit.classList.add('loading');
    say('Opening Paystack…', 'info');

    fetch(API + '/retainer-purchases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok || !body.paymentUrl) {
            throw new Error(body.error || body.message || 'We could not open the payment page. Try again, or email info@dakyx.com.');
          }
          window.location.href = body.paymentUrl;
        });
      })
      .catch(function (error) {
        submit.disabled = false;
        submit.classList.remove('loading');
        say(error.message || 'We could not open the payment page. Try again, or email info@dakyx.com.');
      });
  });
})();
