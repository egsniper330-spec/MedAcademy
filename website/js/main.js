/* MedAcademy website — progressive enhancement only. All content works without JS. */
(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────
  // CONTACT LINKS — the ONE place to edit the Contact Us destinations.
  //
  // These are PLACEHOLDER values. Replace each with the real MedAcademy
  // account/number/handle; the contact page rows pick the values up
  // automatically (matched by data-contact). Notes:
  //   • WhatsApp: use the full international number with no “+”, spaces
  //     or dashes, e.g. 'https://wa.me/201234567890'.
  //   • Telegram: use the channel/username, e.g. 'https://t.me/medacademy'.
  //   • Email: plain address — the mailto: link is built for you.
  // The static hrefs in contact.html are kept identical so the page also
  // works with JavaScript disabled.
  // ─────────────────────────────────────────────────────────────────
  var CONTACT_LINKS = {
    facebook:  'https://facebook.com',
    instagram: 'https://instagram.com',
    whatsapp:  'https://wa.me/',
    telegram:  'https://t.me/',
    email:     'hello@medacademy.site', // built into mailto: below
  };

  document.querySelectorAll('.contact-row[data-contact]').forEach(function (row) {
    var key = row.getAttribute('data-contact');
    var value = CONTACT_LINKS[key];
    if (!value) return;
    if (key === 'email') {
      row.setAttribute('href', 'mailto:' + value);
      row.setAttribute('aria-label', 'Email MedAcademy at ' + value);
    } else {
      row.setAttribute('href', value);
    }
  });

  // Mobile navigation toggle
  var toggle = document.getElementById('navToggle');
  var nav = document.getElementById('mainNav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.addEventListener('click', function (e) {
      if (e.target && e.target.tagName === 'A') {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Scroll-reveal: mark visible immediately, then observe for graceful entry
  var revealables = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    revealables.forEach(function (el) { observer.observe(el); });
  } else {
    revealables.forEach(function (el) { el.classList.add('visible'); });
  }

  // Resolve the Android direct-APK link if a release manifest is present.
  // Drop releases.json next to this page to enable the direct download button;
  // without it, the button stays hidden and only store links are shown.
  var apkLink = document.getElementById('androidApk');
  if (apkLink) {
    fetch('releases.json', { cache: 'no-store' })
      .then(function (res) { if (!res.ok) throw new Error('no manifest'); return res.json(); })
      .then(function (manifest) {
        if (manifest && manifest.androidApkUrl) {
          apkLink.setAttribute('href', manifest.androidApkUrl);
          if (manifest.versionName) {
            apkLink.textContent = '⬇ Download APK (v' + manifest.versionName + ')';
          }
          apkLink.hidden = false;
        }
      })
      .catch(function () { /* no manifest — keep the button hidden */ });
  }
})();
