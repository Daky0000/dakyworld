/* ==========================================================================
   Dakyworld — site behaviour
   Loaded by every page. Everything here degrades safely if an element
   is absent, so the same file can serve the home page and the legal pages.
   ========================================================================== */
(function () {
  'use strict';

  document.documentElement.classList.add('js');

  var HEADER_HTML = [
    '<header class="site-header" id="siteHeader">',
    '  <div class="header-shell" id="headerShell">',
    '',
    '    <a href="/" class="brand" aria-label="Dakyworld home">',
    '      <img',
    '        class="brand-logo"',
    '        src="assets/brand/header-lockup-on-dark.png"',
    '        alt="Dakyworld"',
    '        width="379"',
    '        height="68"',
    '      >',
    '    </a>',
    '',
    '    <nav class="main-nav" id="mainNav" aria-label="Main">',
    '      <a href="/services">Services</a>',
    '      <a href="/work">Work</a>',
    '      <a href="/how-we-work">How We Work</a>',
    '      <a href="/pricing">Pricing</a>',
    '      <a href="/about">About</a>',
    '      <a href="/insights">Insights</a>',
    '',
    '      <a href="/contact" class="nav-cta">',
    '        Let&#39;s Talk',
    '        <!-- Numeric entity rather than a literal glyph: an entity survives a',
    '             re-save whatever the editor\'s encoding. -->',
    '        <span aria-hidden="true">&#8599;</span>',
    '      </a>',
    '    </nav>',
    '',
    '    <button',
    '      class="menu-toggle"',
    '      id="menuToggle"',
    '      type="button"',
    '      aria-label="Open navigation"',
    '      aria-controls="mainNav"',
    '      aria-expanded="false"',
    '    >',
    '      <span aria-hidden="true"></span>',
    '    </button>',
    '',
    '  </div>',
    '</header>'
  ].join('\n');

  var FOOTER_HTML = [
    '<footer>',
    '  <div class="wrap">',
    '    <div class="footer-grid">',
    '      <div>',
    '        <a href="/" class="brand-footer" aria-label="Dakyworld home"><img src="assets/brand/footer-lockup-on-dark.png" alt="Dakyworld" width="535" height="96"></a>',
    '        <p class="footer-blurb">Dakyworld is your outsourced digital systems and automation team for growing businesses in Ghana and West Africa. We build, connect and improve the systems that help businesses win customers and operate more efficiently.</p>',
    '      </div>',
    '      <div>',
    '        <h3>Explore</h3>',
    '        <ul>',
    '          <li><a href="/services">Services</a></li>',
    '          <li><a href="/work">Work</a></li>',
    '          <li><a href="/how-we-work">How We Work</a></li>',
    '          <li><a href="/pricing">Pricing</a></li>',
    '        </ul>',
    '      </div>',
    '      <div>',
    '        <h3>Company</h3>',
    '        <ul>',
    '          <li><a href="/about">About</a></li>',
    '          <li><a href="/insights">Insights</a></li>',
    '          <li><a href="/contact">Let&#39;s Talk</a></li>',
    '          <li><a href="/privacy">Privacy</a></li>',
    '          <li><a href="/terms">Terms</a></li>',
    '          <li><button type="button" class="dw-consent-reopen" data-consent-open>Cookie settings</button></li>',
    '        </ul>',
    '      </div>',
    '      <div>',
    '        <h3>Get in touch</h3>',
    '        <ul>',
    '          <li><a href="mailto:info@dakyworld.com">info@dakyworld.com</a></li>',
    '          <li><a href="tel:+233545950611">+233 545 950 611</a></li>',
    '          <li>Kumasi, Ghana</li>',
    '        </ul>',
    '        <a href="/contact" class="footer-cta">Start a conversation <span aria-hidden="true">&#8599;</span></a>',
    '      </div>',
    '    </div>',
    '    <div class="footer-bottom"><span>&copy; <span id="year">2026</span> Dakyworld &middot; All rights reserved</span><span>Kumasi &middot; Serving Ghana and West Africa</span><span>One partner. Better digital systems.</span></div>',
    '  </div>',
    '</footer>'
  ].join('\n');

  function replaceGlobalMarkup() {
    var existingHeader = document.querySelector('header.site-header');
    if (existingHeader) existingHeader.outerHTML = HEADER_HTML;

    var existingFooter = document.querySelector('footer');
    if (existingFooter) existingFooter.outerHTML = FOOTER_HTML;
  }

  replaceGlobalMarkup();

  if (window.lucide) lucide.createIcons();

  var progress = document.getElementById('pageProgress');

  /* ── Header ─────────────────────────────────────────────────────────────
     One rAF-throttled scroll handler drives the shell state and the
     reading-progress bar. The header itself stays pinned at all times. */
  var header = document.getElementById('siteHeader');
  var toggle = document.getElementById('menuToggle');
  var nav = document.getElementById('mainNav');
  var navLinks = nav ? [].slice.call(nav.querySelectorAll('a')) : [];

  var SHRINK = 30;    // px before the shell tightens

  /* Stagger index for the mobile reveal. */
  navLinks.forEach(function (link, i) { link.style.setProperty('--i', i); });

  /* Mark the current page from the URL, and use aria-current so it is
     announced rather than merely coloured.

     Both sides are reduced to a bare page name first, so this holds whether the
     URL is /pricing, /pricing.html or the bare domain — GitHub Pages serves all
     three, and a visitor can arrive on any of them from an old link. */
  (function markCurrentPage() {
    function pageKey(path) {
      var last = path.split('?')[0].split('#')[0].replace(/\/+$/, '').split('/').pop();
      if (!last || last === 'index' || last === 'index.html') return 'home';
      return last.replace(/\.html$/, '');
    }

    var here = pageKey(location.pathname);
    navLinks.forEach(function (link) {
      if (pageKey(link.getAttribute('href')) === here) {
        link.setAttribute('aria-current', 'page');
      }
    });
  })();

  function setMenu(open) {
    if (!nav || !toggle) return;
    nav.classList.toggle('open', open);
    /* aria-expanded drives the CSS too, so the icon cannot disagree with the
       announced state. */
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    document.body.classList.toggle('nav-open', open);
  }

  var ticking = false;

  function onScroll() {
    var y = window.scrollY || 0;

    if (header) header.classList.toggle('scrolled', y > SHRINK);
    if (progress) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.width = max > 0 ? (y / max) * 100 + '%' : '0%';
    }

    ticking = false;
  }

  window.addEventListener('scroll', function () {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(onScroll);
    }
  }, { passive: true });
  onScroll();

  /* Collapse the row into a panel exactly when the row stops fitting.

     The width of the nav has to be its width AS A ROW, and once the panel is
     showing it is not a row any more — it is absolutely positioned across the
     whole shell. Measuring it in that state returned the shell's own width, so
     the comparison was `shellWidth + brand + 42 + padding > shellWidth`: true
     forever. The header collapsed at a narrow width and then stayed collapsed
     on the way back out to a wide one, however far you dragged, until a
     reload. So the row width is measured once while it is still a row and
     kept — the links never change, so the number never needs to.

     It is re-taken after the webfonts land, because the first measurement is
     of fallback type and is usually a little narrower than the real thing. */
  var headerShell = document.querySelector('.header-shell');
  var brand = document.querySelector('.brand');
  var navRowWidth = 0;

  var TOGGLE_W = 42;   // .menu-toggle, which only exists once collapsed
  var BREATH   = 44;   // the least space that may sit between brand and nav

  function measureNavRow() {
    if (!headerShell || !nav) return;
    var collapsed = headerShell.getAttribute('data-nav-overflow') === 'true';
    /* Force the row back, read it, put it straight back — all in one task, so
       no paint happens in between. The catch is transitions: the panel fades
       its opacity and visibility, and a transition does not care that the
       change was undone in the same task. It saw the row, so it animated the
       panel back out over a quarter-second, in full view of the visitor. The
       .measuring class switches those transitions off for the two lines they
       would otherwise ruin.

       scrollWidth, not offsetWidth: a nav that does not fit has been squeezed
       by the flex row, and since its links are nowrap they overflow it. Only
       scrollWidth counts what is really there. */
    if (collapsed) {
      headerShell.classList.add('measuring');
      headerShell.setAttribute('data-nav-overflow', 'false');
    }
    navRowWidth = Math.max(navRowWidth, nav.scrollWidth);
    if (collapsed) {
      headerShell.setAttribute('data-nav-overflow', 'true');
      void headerShell.offsetWidth;   // settle the panel before transitions return
      headerShell.classList.remove('measuring');
    }
  }

  function checkNavOverflow() {
    if (!headerShell || !nav) return;

    measureNavRow();
    if (!navRowWidth) return;

    var cs = getComputedStyle(headerShell);
    var inner = headerShell.clientWidth
      - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var brandWidth = brand ? brand.offsetWidth : 100;

    var hasOverflow = brandWidth + BREATH + navRowWidth > inner;

    /* The toggle costs 42px that the row does not pay, so a width where the
       row fits but the collapsed header would not is still a row. */
    if (!hasOverflow && brandWidth + TOGGLE_W > inner) hasOverflow = true;

    headerShell.setAttribute('data-nav-overflow', hasOverflow ? 'true' : 'false');
    if (!hasOverflow) setMenu(false);
  }

  if (toggle && nav) {
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();            // don't trip the outside-click handler
      setMenu(!nav.classList.contains('open'));
    });

    navLinks.forEach(function (link) {
      link.addEventListener('click', function () { setMenu(false); });
    });

    document.addEventListener('click', function (e) {
      if (!nav.classList.contains('open')) return;
      if (!nav.contains(e.target) && !toggle.contains(e.target)) setMenu(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('open')) {
        setMenu(false);
        toggle.focus();   // return focus rather than stranding it in a hidden panel
      }
    });

    /* Resizing back out to a row with the menu still open would otherwise
       leave a stale state — body locked, panel rendering as a desktop row.
       checkNavOverflow closes it as part of expanding. */
    var resizePending = false;
    window.addEventListener('resize', function () {
      if (resizePending) return;
      resizePending = true;
      window.requestAnimationFrame(function () {
        resizePending = false;
        checkNavOverflow();
      });
    });

    checkNavOverflow();
    /* Again once the webfonts land: the first reading is of fallback type and
       is usually a little narrower than the row will actually be. */
    if (document.fonts) {
      document.fonts.ready.then(checkNavOverflow);
    }
  }

  /* Scroll reveals ----------------------------------------------------------
     One quiet rise per section as it enters. No per-card stagger — the section
     carries the whole group. And a hard guarantee that the content is shown:
     if IntersectionObserver is missing, or has not fired for a section within
     three seconds (a stalled load, a browser quirk), reveal everything anyway.
     A .reveal that never gains .in is invisible, and that must not be possible. */
  var reveals = [].slice.call(document.querySelectorAll('.reveal'));

  function showAll() {
    reveals.forEach(function (el) { el.classList.add('in'); });
  }

  /* Only now does the CSS start hiding .reveal — see the note in site.css. */
  document.documentElement.classList.add('reveal-ready');

  if (!('IntersectionObserver' in window)) {
    showAll();
  } else {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -45px 0px' });
    reveals.forEach(function (el) { revealObserver.observe(el); });
    setTimeout(showAll, 3000);
  }

  /* Hero entrance safety net ---------------------------------------------
     The hero content starts at opacity:0 and is brought in by a CSS
     animation. That animation is deferred while a tab is loaded in the
     background and, in rare cases, can be dropped entirely — leaving the
     hero blank. Force it visible after four seconds regardless. */
  setTimeout(function () {
    document
      .querySelectorAll('.portal-content > *, .portal-proof, .hero-inner > *')
      .forEach(function (el) {
        if (parseFloat(getComputedStyle(el).opacity) < 1) {
          el.style.opacity = '1';
          el.style.transform = 'none';
        }
      });
  }, 4000);

  /* Count-up statistics ------------------------------------------------- */
  var counters = document.querySelectorAll('.count-up');
  if (counters.length) {
    var countObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        var target = Number(el.dataset.target || 0);
        var suffix = el.dataset.suffix || '';
        var duration = target === 0 ? 450 : 1100;
        var start = performance.now();
        (function tick(now) {
          var p = Math.min((now - start) / duration, 1);
          var eased = 1 - Math.pow(1 - p, 3);
          el.textContent = Math.round(target * eased) + suffix;
          if (p < 1) requestAnimationFrame(tick);
        })(start);
        countObserver.unobserve(el);
      });
    }, { threshold: 0.8 });
    counters.forEach(function (el) { countObserver.observe(el); });
  }

  /* Insights category filter ---------------------------------------------- */
  var filterButtons = document.querySelectorAll('.category-btn');
  if (filterButtons.length) {
    var articles = document.querySelectorAll('.article');
    filterButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        filterButtons.forEach(function (b) {
          b.classList.remove('active');
          b.setAttribute('aria-pressed', 'false');
        });
        button.classList.add('active');
        button.setAttribute('aria-pressed', 'true');
        var filter = button.dataset.filter;
        articles.forEach(function (article) {
          var match = filter === 'all' || article.dataset.category === filter;
          article.dataset.hidden = match ? 'false' : 'true';
          if (match) article.classList.add('in');
        });
      });
    });
  }

  /* Forms.
     Neither of these is wired to a backend yet, so they say so rather than
     claiming a message was sent. Replace both handlers with a real POST (or
     a form service) before launch. */
  function settle(button, label, ms) {
    var original = button.innerHTML;
    button.innerHTML = label;
    button.disabled = true;
    setTimeout(function () {
      button.innerHTML = original;
      button.disabled = false;
    }, ms || 4000);
  }

  // Stamped on load so the server can tell how long the form was open. A
  // submission three seconds after the page rendered was not typed by a person.
  // See server/src/services/botCheck.ts.
  var started = document.getElementById('_dw_started');
  if (started) started.value = String(Date.now());

  var form = document.getElementById('contactForm');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!form.reportValidity()) return;

      var note = document.getElementById('formNote');
      var status = form.querySelector('.form-status');
      var message =
        'This form is not connected to an inbox yet — please email ' +
        'info@dakyworld.com or call +233 545 950 611 and we will reply the same day.';

      if (status) {
        status.textContent = message;
        status.hidden = false;
      } else if (note) {
        note.textContent = message;
        note.hidden = false;
      }
      var button = form.querySelector('.submit,[type="submit"]');
      if (button) settle(button, 'Not connected yet');
    });
  }

  var newsletter = document.getElementById('newsletterForm');
  if (newsletter) {
    newsletter.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!newsletter.reportValidity()) return;
      var status = document.getElementById('newsletterStatus');
      if (status) {
        status.textContent =
          'Sign-up is not live yet. Email info@dakyworld.com with “subscribe” and we will add you.';
        status.hidden = false;
      }
      var button = newsletter.querySelector('button');
      if (button) settle(button, 'Not live yet');
    });
  }
  /* The pricing menu opens on hover and on focus, in CSS — see site.css.
     It used to toggle on click, which cannot survive the trigger becoming a
     link to the pricing page: a click has to navigate there. */

  /* Footer year ---------------------------------------------------------- */
  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();
})();
