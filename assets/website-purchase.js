(function () {
  var API = 'https://os.dakyworld.com/api/public';
  var dialog = document.getElementById('builderCheckout');
  if (!dialog) return;
  var form = dialog.querySelector('form');
  var title = document.getElementById('builderCheckoutTitle');
  var status = dialog.querySelector('.builder-form-status');
  var managed = false;

  if (new URLSearchParams(window.location.search).get('payment') === 'returned') {
    var price = document.getElementById('price');
    if (price) { var note = document.createElement('p'); note.className = 'builder-payment-return'; note.setAttribute('role', 'status'); note.textContent = 'Paystack returned you to Dakyworld. We are confirming the payment securely and will email your next setup step.'; price.querySelector('.wrap').insertBefore(note, price.querySelector('.wrap').firstChild); }
  }

  function open(plan) {
    managed = plan === 'managed-website';
    form.reset();
    var submit = form.querySelector('[type=submit]'); submit.hidden = false; submit.disabled = false;
    form.elements.productKey.value = plan;
    title.textContent = managed ? 'Book Managed Website setup' : 'Start your website setup';
    Array.prototype.forEach.call(form.querySelectorAll('.managed-only'), function (field) { field.style.display = managed ? 'grid' : 'none'; Array.prototype.forEach.call(field.querySelectorAll('input,textarea'), function (input) { input.required = managed; }); });
    status.textContent = managed ? 'Choose a consultation time. We will confirm it after reviewing your request.' : 'We check compatibility before setup. Paystack securely handles the setup payment.';
    dialog.showModal();
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-purchase-plan]'), function (button) { button.addEventListener('click', function () { open(button.getAttribute('data-purchase-plan')); }); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-book-managed]'), function (button) { button.addEventListener('click', function () { open('managed-website'); }); });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!form.reportValidity()) return;
    var button = form.querySelector('[type=submit]');
    var payload = {}; new FormData(form).forEach(function (value, key) { payload[key] = value; });
    button.disabled = true; status.textContent = managed ? 'Booking your consultation…' : 'Opening secure payment…';
    var endpoint = managed ? '/managed-bookings' : '/website-purchases';
    fetch(API + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (response) { return response.json().then(function (body) { if (!response.ok) throw new Error(body.error || 'That could not be completed.'); return body; }); })
      .then(function (body) { if (managed) { status.textContent = 'Booking requested. We will email you after review.'; button.hidden = true; } else if (body.paymentUrl) { window.location.assign(body.paymentUrl); } else throw new Error('Paystack did not return a payment page.'); })
      .catch(function (error) {
        var unavailable = /unauthor|not found|answered 404|answered 401/i.test(error.message);
        status.textContent = unavailable
          ? 'Online checkout is temporarily unavailable. Email info@dakyworld.com or call +233 545 950 611 and we will open the same Paystack checkout for you.'
          : error.message;
        button.disabled = false;
      });
  });
})();
