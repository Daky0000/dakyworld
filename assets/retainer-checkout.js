/* The monthly-plan checkout on /retainer-checkout.
   Sends the form to the OS, which writes the plan and the first month's
   invoice and answers with a Paystack page to pay it on. Paying is what
   starts the plan, so nothing here claims a purchase happened. */
(function () {
  'use strict';

  var API = 'https://os.dakyx.com/api/public';
  var form = document.getElementById('retainerForm');
  if (!form) return;

  var status = document.getElementById('retainerStatus');
  var submit = document.getElementById('retainerSubmit');
  var params = new URLSearchParams(window.location.search);

  function money(amount) {
    return 'GHS ' + Number(amount).toLocaleString('en-GB');
  }

  function selected() {
    return form.querySelector('input[name="plan"]:checked');
  }

  function render() {
    var choice = selected();
    if (!choice) return;
    var promo = choice.getAttribute('data-promo');
    var standard = choice.getAttribute('data-standard');
    var label = choice.getAttribute('data-label');
    document.getElementById('retainerSummaryTitle').textContent = label;
    document.getElementById('retainerSummaryPrice').textContent = Number(promo).toLocaleString('en-GB');
    document.getElementById('retainerLinePromo').textContent = money(promo) + '/month';
    document.getElementById('retainerLineStandard').textContent = money(standard) + '/month';
    document.getElementById('retainerLineTotal').textContent = money(promo);
    document.getElementById('retainerBtnAmount').textContent = money(promo);
    document.getElementById('retainerTerms').textContent =
      'Today you pay ' + money(promo) + ' for your first month of ' + label + '. Months two and three are ' +
      money(promo) + ', and from month four the plan is ' + money(standard) + ' a month. Each later month is invoiced to your email.';
  }

  function say(message, kind) {
    status.textContent = message;
    status.className = 'builder-form-status' + (message ? ' ' + (kind || 'error') : '');
  }

  var wanted = params.get('plan');
  if (wanted) {
    var match = form.querySelector('input[name="plan"][value="' + wanted.replace(/[^a-z]/g, '') + '"]');
    if (match) match.checked = true;
  }
  if (params.get('payment') === 'returned') document.getElementById('retainerReturned').hidden = false;

  form.addEventListener('change', function (event) {
    if (event.target && event.target.name === 'plan') render();
  });
  render();

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    say('');
    var data = new FormData(form);
    var payload = {
      plan: data.get('plan'),
      recurringConsent: data.get('recurringConsent') === 'on',
      email: String(data.get('email') || '').trim(),
      contactName: String(data.get('contactName') || '').trim(),
      businessName: String(data.get('businessName') || '').trim(),
      callbackUrl: window.location.origin + window.location.pathname + '?payment=returned&plan=' + data.get('plan')
    };
    var phone = String(data.get('phone') || '').trim();
    var notes = String(data.get('notes') || '').trim();
    if (phone) payload.phone = phone;
    if (notes) payload.notes = notes;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return say('Enter a valid email address.');
    if (payload.contactName.length < 2) return say('Enter your name.');
    if (payload.businessName.length < 2) return say('Enter your business name.');
    if (!payload.recurringConsent) return say('Tick the box to agree to the monthly price and the terms.');

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
