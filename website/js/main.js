/* MedAcademy website — progressive enhancement only. All content works without JS. */
(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────
  // CONTACT LINKS — the `href` on each <a class="contact-row"> inside
  // contact.html is the ONE place to edit the Contact Us destinations.
  //
  // This file deliberately does NOT rewrite those hrefs. It used to keep a
  // duplicate JS copy (CONTACT_LINKS) and run setAttribute('href', …) on
  // every row, which silently overwrote whatever contact.html said — so the
  // Contact Us page kept opening the old placeholder destinations no matter
  // how the HTML was edited. The rows are plain <a> elements and work with
  // JavaScript disabled; all this block adds is the email row's label.
  // ─────────────────────────────────────────────────────────────────
  document.querySelectorAll('.contact-row[data-contact]').forEach(function (row) {
    if (row.getAttribute('data-contact') !== 'email') return;
    const href = row.getAttribute('href') || '';
    const address = href.replace(/^mailto:/i, '').trim();
    if (address) row.setAttribute('aria-label', 'Email MedAcademy at ' + address);
  });

  // ─────────────────────────────────────────────────────────────────
  // THEME — Light / Dark. The inline <head> script has ALREADY applied
  // data-theme before first paint (that is what avoids the flash); this
  // block only wires the control, persistence and the OS-follow fallback.
  // ─────────────────────────────────────────────────────────────────
  let THEME_KEY = 'med-theme';
  let root = document.documentElement;
  let themeBtn = document.getElementById('themeToggle');

  function currentTheme() {
    return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function storedTheme() {
    try {
      let v = localStorage.getItem(THEME_KEY);
      return (v === 'light' || v === 'dark') ? v : null;
    } catch (_e) { return null; } // storage blocked (private mode) — no persistence
  }

  function applyTheme(theme, persist) {
    root.setAttribute('data-theme', theme);
    if (persist) {
      try { localStorage.setItem(THEME_KEY, theme); } catch (_e) { /* private mode */ }
    }
    let meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#EEF3F9' : '#091425');
    if (themeBtn) {
      // The control shows the icon of the theme it would switch TO, so the
      // accessible name always describes the action, not the current state.
      let next = theme === 'dark' ? 'light' : 'dark';
      themeBtn.setAttribute('aria-label', 'Switch to ' + next + ' mode');
      themeBtn.setAttribute('title', 'Switch to ' + next + ' mode');
    }
  }

  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
    });
    // Sync the label with whatever the head script decided (no re-persist).
    applyTheme(currentTheme(), false);
  }

  // Follow the OS theme ONLY while the visitor has not chosen explicitly —
  // an explicit selection must survive OS changes for the rest of the session.
  let schemeQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let onSchemeChange = function (e) {
    if (storedTheme()) return;
    applyTheme(e.matches ? 'dark' : 'light', false);
  };
  if (schemeQuery) {
    if (typeof schemeQuery.addEventListener === 'function') schemeQuery.addEventListener('change', onSchemeChange);
    else if (typeof schemeQuery.addListener === 'function') schemeQuery.addListener(onSchemeChange); // Safari < 14
  }

  // Mobile navigation toggle
  let toggle = document.getElementById('navToggle');
  let nav = document.getElementById('mainNav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      let open = nav.classList.toggle('open');
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
  let revealables = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(function (entries) {
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

  // ─────────────────────────────────────────────────────────────────
  // Android direct-APK link.
  //
  // The real, always-available destination is the static href in
  // download.html (`/app.apk` on this origin), so the button ships in the
  // markup and works with JavaScript disabled. releases.json is a purely
  // OPTIONAL enhancement: when a manifest exists it adds the version label
  // and may repoint the link at a versioned artifact.
  //
  // It must never HIDE the button. The previous version only ever unhid it
  // from this callback, so in the shipped state — releases.json absent and
  // 404 — the Download APK button never appeared at all.
  // ─────────────────────────────────────────────────────────────────
  let apkLink = document.getElementById('androidApk');
  if (apkLink) {
    fetch('releases.json', { cache: 'no-store' })
      .then(function (res) { if (!res.ok) throw new Error('no manifest'); return res.json(); })
      .then(function (manifest) {
        if (!manifest) return;
        if (manifest.androidApkUrl) apkLink.setAttribute('href', manifest.androidApkUrl);
        if (manifest.versionName) apkLink.textContent = '⬇ Download APK (v' + manifest.versionName + ')';
      })
      .catch(function () { /* no manifest — keep the static href from download.html */ });
  }
})();
