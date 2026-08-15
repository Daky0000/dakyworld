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
    '  <div class="header-wrap">',
    '    <div class="header-shell">',
    '',
    '      <a href="index.html" class="brand" aria-label="Dakyworld home">',
    '        <img',
    '          class="brand-logo"',
    '          src="assets/brand/header-lockup-on-dark.png"',
    '          alt="Dakyworld"',
    '          width="379"',
    '          height="68"',
    '        >',
    '      </a>',
    '',
    '      <nav class="main-nav" id="mainNav" aria-label="Main">',
    '        <a href="services.html">Capabilities</a>',
    '        <a href="work.html">Selected Work</a>',
    '        <a href="how-we-work.html">How We Work</a>',
    '        <a href="pricing.html">Pricing</a>',
    '        <a href="about.html">About</a>',
    '',
    '        <a href="contact.html" class="nav-cta">',
    '          Schedule a Consultation',
    '          <span aria-hidden="true">&#8599;</span>',
    '        </a>',
    '      </nav>',
    '',
    '      <button',
    '        class="menu-toggle"',
    '        id="menuToggle"',
    '        type="button"',
    '        aria-label="Open navigation"',
    '        aria-controls="mainNav"',
    '        aria-expanded="false"',
    '      >',
    '        <span aria-hidden="true"></span>',
    '      </button>',
    '',
    '    </div>',
    '  </div>',
    '</header>'
  ].join('\n');

  var FOOTER_HTML = [
    '<footer>',
    '  <div class="footer-grid">',
    '    <div><a href="index.html" class="brand-footer" aria-label="Dakyworld home"><img src="assets/brand/footer-lockup-on-dark.png" alt="Dakyworld" width="535" height="96"></a><p class="mt-5 max-w-sm text-sm leading-7" style="color:rgba(255,255,255,.45)">Your outsourced IT department for growing businesses. One monthly retainer. One accountable team. The technology your business depends on, properly managed.</p></div>',
    '    <div><h3>Explore</h3><ul><li><a href="services.html">Capabilities</a></li><li><a href="work.html">Selected Work</a></li><li><a href="how-we-work.html">How We Work</a></li><li><a href="pricing.html">Pricing</a></li></ul></div>',
    '    <div><h3>Company</h3><ul><li><a href="about.html">About</a></li><li><a href="insights.html">Insights</a></li><li><a href="contact.html">Schedule a Consultation</a></li></ul></div>',
    '  </div>',
    '  <div class="footer-bottom"><span>&copy; <span id="year">2026</span> Dakyworld &middot; All rights reserved</span><span>Kumasi &middot; Serving Ghana and West Africa</span><span><a href="privacy.html">Privacy</a> &middot; <a href="terms.html">Terms</a></span></div>',
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

  var fine = window.matchMedia('(pointer:fine)').matches;
  var progress = document.getElementById('pageProgress');

  /* ── Header ─────────────────────────────────────────────────────────────
     One rAF-throttled scroll handler drives the shell state and the
     reading-progress bar. The header itself stays pinned at all times. */
  var header = document.getElementById('siteHeader');
  var toggle = document.getElementById('menuToggle');
  var nav = document.getElementById('mainNav');
  var navLinks = nav ? [].slice.call(nav.querySelectorAll('a')) : [];

  var MOBILE = 760;   // keep in sync with the media query in site.css
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

  /* Check if nav is overflowing and needs dropdown */
  var headerShell = document.querySelector('.header-shell');
  
  function checkNavOverflow() {
    if (!headerShell || !nav) return;
    
    // Get the shell's scrollable width
    var shellWidth = headerShell.offsetWidth;
    var navWidth = nav.offsetWidth;
    var brandWidth = document.querySelector('.brand') ? document.querySelector('.brand').offsetWidth : 100;
    var toggleWidth = toggle ? 42 : 0;
    var padding = 20; // approximate padding buffer
    
    // Check if content would overflow
    var totalWidth = brandWidth + navWidth + toggleWidth + padding;
    var hasOverflow = totalWidth > shellWidth;
    
    // Set the data attribute
    headerShell.setAttribute('data-nav-overflow', hasOverflow ? 'true' : 'false');
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

    /* Resizing past the breakpoint with the menu open would otherwise leave a
       stale state: body still locked, panel rendering as a desktop row. */
    var wasMobile = window.innerWidth <= MOBILE;
    window.addEventListener('resize', function () {
      var isMobile = window.innerWidth <= MOBILE;
      if (isMobile !== wasMobile) {
        wasMobile = isMobile;
        if (!isMobile) setMenu(false);
      }
      checkNavOverflow();
    });
    
    /* Initial check and check after fonts load */
    checkNavOverflow();
    if (document.fonts) {
      document.fonts.ready.then(checkNavOverflow);
    }
  }

  /* Scroll reveals ------------------------------------------------------ */
  var reveals = document.querySelectorAll('.reveal');
  reveals.forEach(function (section) {
    section
      .querySelectorAll('.service-card,.gov-card,.case,.price-card,.case-file,.level-card,.spec-row,.post-row,.rate-row')
      .forEach(function (card, i) {
        card.style.transitionDelay = Math.min(i, 7) * 60 + 'ms';
      });
  });

  /* Where several .reveal elements share a parent — a card grid, a plan
     table — cascade them. A lone .reveal keeps a zero delay, so sections
     far down the page still appear the moment they are reached. */
  var groups = new Map();
  reveals.forEach(function (el) {
    var parent = el.parentElement;
    if (!parent) return;
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(el);
  });
  groups.forEach(function (siblings) {
    if (siblings.length < 2) return;
    siblings.forEach(function (el, i) {
      if (el.style.transitionDelay) return;
      el.style.transitionDelay = Math.min(i, 8) * 65 + 'ms';
    });
  });
  var revealObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -45px 0px' });
  reveals.forEach(function (el) { revealObserver.observe(el); });

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

  /* Pointer-responsive local light on cards ----------------------------- */
  if (fine) {
    document
      .querySelectorAll('.service-card,.gov-card,.price-card,.arrange-card,.case,.case-file,.level-card')
      .forEach(function (card) {
        card.addEventListener('pointermove', function (e) {
          var r = card.getBoundingClientRect();
          card.style.setProperty('--mx', ((e.clientX - r.left) / r.width) * 100 + '%');
          card.style.setProperty('--my', ((e.clientY - r.top) / r.height) * 100 + '%');
        }, { passive: true });
      });
  }

  /* Desktop cursor atmosphere ------------------------------------------- */
  var glow = document.getElementById('cursorGlow');
  if (glow && fine) {
    var x = window.innerWidth / 2, y = window.innerHeight / 2, tx = x, ty = y;
    window.addEventListener('pointermove', function (e) { tx = e.clientX; ty = e.clientY; }, { passive: true });
    (function moveGlow() {
      x += (tx - x) * 0.1;
      y += (ty - y) * 0.1;
      glow.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
      requestAnimationFrame(moveGlow);
    })();
  }

  /* Magnetic CTAs -------------------------------------------------------- */
  if (fine) {
    document.querySelectorAll('.portal-primary,.btn-primary').forEach(function (button) {
      button.addEventListener('pointermove', function (e) {
        var r = button.getBoundingClientRect();
        var mx = (e.clientX - r.left - r.width / 2) / r.width;
        var my = (e.clientY - r.top - r.height / 2) / r.height;
        button.style.transform = 'translate(' + mx * 5 + 'px,' + my * 4 + 'px)';
      });
      button.addEventListener('pointerleave', function () { button.style.transform = ''; });
    });
  }

  /* Pointer tilt on plan and article cards -------------------------------- */
  if (fine) {
    document.querySelectorAll('.plan,.article').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        if (card.closest('.reveal') && !card.closest('.reveal').classList.contains('in')) return;
        var r = card.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width - 0.5;
        var y = (e.clientY - r.top) / r.height - 0.5;
        var lift = card.classList.contains('featured') ? -11 : -6;
        card.style.transform =
          'perspective(950px) rotateX(' + (y * -1.1) + 'deg) rotateY(' + (x * 1.1) + 'deg) translateY(' + lift + 'px)';
      });
      card.addEventListener('pointerleave', function () { card.style.transform = ''; });
    });

    /* Contact orb drifts toward the pointer */
    var orbStage = document.querySelector('.hero-side');
    var orb = document.querySelector('.contact-orb');
    if (orbStage && orb) {
      orbStage.addEventListener('pointermove', function (e) {
        var r = orbStage.getBoundingClientRect();
        var x = (e.clientX - r.left - r.width / 2) / r.width;
        var y = (e.clientY - r.top - r.height / 2) / r.height;
        orb.style.transform = 'translate(' + x * 12 + 'px,' + y * 10 + 'px)';
      });
      orbStage.addEventListener('pointerleave', function () { orb.style.transform = ''; });
    }
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

  var form = document.getElementById('contactForm');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!form.reportValidity()) return;

      var note = document.getElementById('formNote');
      var status = form.querySelector('.form-status');
      var message =
        'This form is not connected to an inbox yet — please email ' +
        'hello@dakyworld.com or call +233 545 950 611 and we will reply the same day.';

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
          'Sign-up is not live yet. Email hello@dakyworld.com with “subscribe” and we will add you.';
        status.hidden = false;
      }
      var button = newsletter.querySelector('button');
      if (button) settle(button, 'Not live yet');
    });
  }
  /* Pricing dropdown menu ------------------------------------------------- */
  var pricingWrapper = document.querySelector('.nav-dropdown');
  var pricingBtn = document.querySelector('.nav-dropdown-trigger');
  var pricingMenu = document.getElementById('pricing-menu');
  if (pricingWrapper && pricingBtn && pricingMenu) {
    function setPricingMenu(open) {
      pricingMenu.hidden = !open;
      pricingBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    pricingBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      setPricingMenu(pricingMenu.hidden);
    });

    document.addEventListener('click', function (e) {
      if (!pricingWrapper.contains(e.target)) setPricingMenu(false);
    });

    pricingMenu.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        setPricingMenu(false);
      });
    });

    pricingBtn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' && pricingMenu.hidden) {
        e.preventDefault();
        setPricingMenu(true);
        setTimeout(function () { pricingMenu.querySelector('a') && pricingMenu.querySelector('a').focus(); }, 0);
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !pricingMenu.hidden) {
        setPricingMenu(false);
        pricingBtn.focus();
      }
    });

    pricingMenu.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        var links = pricingMenu.querySelectorAll('a');
        var last = links[links.length - 1];
        if (e.shiftKey && document.activeElement === links[0]) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          setPricingMenu(false);
        }
      }
    });
  }
  /* Footer year ---------------------------------------------------------- */
  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();
})();
