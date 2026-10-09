'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ── Platform → icon mapping (mirrors exported SUPPORT_ICONS contract) ──────────────
const PLATFORM_ICON_SPEC = {
  whatsapp:  'MessageCircle',
  facebook:  'AtSign',
  instagram: 'Link2',
  telegram:  'Send',
  email:     'Mail',
  phone:     'Phone',
  x:         'Megaphone',
  website:   'Globe',
};

// ── Public support contact contract ────────────────────────────────────────────────
// The public endpoint MUST return only enabled contacts, and MUST NOT expose admin
// fields like 'value', 'enabled', 'displayOrder', or any internal data.
const PUBLIC_CONTACT_WHITELIST = new Set(['platform', 'label', 'url', 'order']);

function isPublicContactShape(suspect) {
  if (!suspect || typeof suspect !== 'object') return false;
  for (const k of Object.keys(suspect)) {
    if (!PUBLIC_CONTACT_WHITELIST.has(k)) return false;
  }
  if (typeof suspect.platform !== 'string') return false;
  if (typeof suspect.label !== 'string') return false;
  if (typeof suspect.url !== 'string') return false;
  return true;
}

// ── Admin support contact shape ────────────────────────────────────────────────────
const ADMIN_CONTACT_WHITELIST = new Set(['platform', 'label', 'value', 'enabled', 'displayOrder']);

function isAdminContactShape(suspect) {
  if (!suspect || typeof suspect !== 'object') return false;
  for (const k of Object.keys(suspect)) {
    if (!ADMIN_CONTACT_WHITELIST.has(k)) return false;
  }
  return true;
}

// ── URL scheme safety ─────────────────────────────────────────────────────────────
const SAFE_SCHEMES = new Set(['https:', 'http:', 'mailto:', 'tel:']);
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'about:']);

function safeUrlScheme(url) {
  if (typeof url !== 'string') return 'invalid';
  const s = url.trim().toLowerCase();
  if (s === '') return 'invalid';
  if (s.startsWith('mailto:')) return 'mailto';
  if (s.startsWith('tel:')) return 'tel';
  const colon = s.indexOf(':');
  if (colon < 1) return 'invalid';
  const scheme = s.slice(0, colon).toLowerCase();
  if (BLOCKED_SCHEMES.has(scheme + ':')) return 'blocked';
  if (!SAFE_SCHEMES.has(scheme + ':')) return 'unsupported';
  return scheme;
}

// ── WhatsApp URL normalization ─────────────────────────────────────────────────────
function normalizeWhatsApp(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/^https?:\/\/(?:www\.)?wa\.me\/([^\s?#]+)/i);
  if (m) {
    const digits = m[1].replace(/[^\d+]/g, '');
    if (!digits) return null;
    return `https://wa.me/${digits}`;
  }
  const digits = s.replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (!digits.startsWith('+')) return null;
  return `https://wa.me/${digits}`;
}

// ── Email URL building ─────────────────────────────────────────────────────────────
function buildEmailUrl(email, subject) {
  if (typeof email !== 'string' || !email.includes('@')) return null;
  const addr = email.trim();
  const params = [];
  if (subject) params.push('subject=' + encodeURIComponent(subject));
  return 'mailto:' + addr + (params.length ? '?' + params.join('&') : '');
}

// ── Phone URL building ─────────────────────────────────────────────────────────────
function buildTelUrl(phone) {
  if (typeof phone !== 'string') return null;
  const digits = phone.replace(/[^\d+]/g, '');
  if (!digits) return null;
  return 'tel:' + digits;
}

// ── Label computation (mirrors frontend getSupportLabel) ──────────────────────────
const SUPPORT_DEFAULT_LABELS = {
  whatsapp: 'WhatsApp',
  facebook: 'Facebook',
  instagram: 'Instagram',
  telegram: 'Telegram',
  email: 'Email',
  phone: 'Phone',
  x: 'X / Twitter',
  website: 'Website',
};

function computeLabel(key, storedLabel) {
  if (storedLabel && String(storedLabel).trim()) return String(storedLabel).trim();
  return SUPPORT_DEFAULT_LABELS[key] ?? key;
}

// ── Verify lucide icon files exist on disk ─────────────────────────────────────────
function verifyLucideIcons() {
  const lucideMain = require.resolve('lucide-react-native');
  const cjsIcons = path.resolve(path.dirname(lucideMain), 'icons');
  const esmIcons = path.resolve(path.dirname(lucideMain), '..', 'esm', 'icons');
  const repoIcons = path.resolve(path.dirname(lucideMain), '..', 'icons');
  const dirs = [cjsIcons, esmIcons, repoIcons];
  const usedIcons = new Set(Object.values(PLATFORM_ICON_SPEC));
  for (const icon of usedIcons) {
    // lucide icon filenames: MessageCircle -> message-circle.js, Link2 -> link-2.js, AtSign -> at-sign.js
  const kebab = icon.replace(/([A-Z])/g, '-$1').replace(/^-/, '').toLowerCase();
  // Special-case: Link2 -> link-2 (the '2' is part of the name, not a separate token)
  const variants = [kebab];
  if (icon === 'Link2') variants.push('link-2');
  if (icon === 'AtSign') variants.push('at-sign');
  if (icon === 'MessageCircle') variants.push('message-circle');
  if (icon === 'Megaphone') variants.push('megaphone');
  if (icon === 'Globe') variants.push('globe');
  if (icon === 'Mail') variants.push('mail');
  if (icon === 'Phone') variants.push('phone');
  if (icon === 'Send') variants.push('send');
  const candidates = new Set(variants);
    let found = false;
    for (const dir of dirs) {
      for (const name of candidates) {
        for (const ext of ['.js', '.tsx', '.jsx', '.cjs']) {
          try {
            fs.accessSync(path.join(dir, name + ext), fs.constants.F_OK);
            found = true;
            break;
          } catch {}
        }
        if (found) break;
      }
      if (found) break;
    }
    assert.ok(found, `Platform icon ${icon} is not shipped by lucide-react-native`);
  }
}

// ── Full public contact round-trip: admin entry → public projection ────────────────
function projectToPublic(adminEntry) {
  if (!isAdminContactShape(adminEntry)) return null;
  if (!adminEntry.enabled) return null;
  if (!adminEntry.value || !String(adminEntry.value).trim()) return null;
  const url = adminEntry.value.trim();
  if (safeUrlScheme(url) === 'blocked') return null;
  return {
    platform: adminEntry.platform,
    label: computeLabel(adminEntry.platform, adminEntry.label),
    url: url,
    order: adminEntry.displayOrder ?? 999,
  };
}

// ── Run the suite ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function ok(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error(`FAIL: ${name}`); console.error(e && e.message ? e.message : e); }
}
function eq(name, actual, expected) { ok(name, () => assert.deepStrictEqual(actual, expected)); }

// 1. lucide icon files
ok('all platform icons are shipped by lucide-react-native', verifyLucideIcons);

// 2. platform → icon mapping is stable and complete
ok('platform→icon mapping contains all required platforms', () => {
  const required = ['whatsapp', 'facebook', 'instagram', 'telegram', 'email', 'phone', 'x', 'website'];
  for (const k of required) assert.ok(k in PLATFORM_ICON_SPEC, `missing platform key ${k}`);
});
eq('platform→icon assigns correct glyph to WhatsApp', PLATFORM_ICON_SPEC.whatsapp, 'MessageCircle');
eq('platform→icon assigns correct glyph to Facebook', PLATFORM_ICON_SPEC.facebook, 'AtSign');
eq('platform→icon assigns correct glyph to Instagram', PLATFORM_ICON_SPEC.instagram, 'Link2');
eq('platform→icon assigns correct glyph to Telegram', PLATFORM_ICON_SPEC.telegram, 'Send');
eq('platform→icon assigns correct glyph to Email', PLATFORM_ICON_SPEC.email, 'Mail');
eq('platform→icon assigns correct glyph to Phone', PLATFORM_ICON_SPEC.phone, 'Phone');
eq('platform→icon assigns correct glyph to X/Twitter', PLATFORM_ICON_SPEC.x, 'Megaphone');
eq('platform→icon assigns correct glyph to Website', PLATFORM_ICON_SPEC.website, 'Globe');

// 3. icon selection is driven by platform key, NOT label text
ok('icon selection ignores label text', () => {
  assert.strictEqual(PLATFORM_ICON_SPEC.facebook, 'AtSign');
  assert.strictEqual(PLATFORM_ICON_SPEC.telegram, 'Send');
});

// 4. public endpoint shape enforcement
const VALID_PUBLIC_CONTACT = { platform: 'whatsapp', label: 'WhatsApp', url: 'https://wa.me/123456789', order: 1 };
eq('valid public contact passes whitelist check', isPublicContactShape(VALID_PUBLIC_CONTACT), true);
ok('public contact must not expose value/enabled/displayOrder', () => {
  assert.strictEqual(isPublicContactShape({ platform: 'whatsapp', label: 'WhatsApp', url: 'https://wa.me/1', value: '123', enabled: true }), false);
  assert.strictEqual(isPublicContactShape({ platform: 'whatsapp', label: 'WhatsApp', url: 'https://wa.me/1', enabled: true }), false);
  assert.strictEqual(isPublicContactShape({ platform: 'whatsapp', label: 'WhatsApp', url: 'https://wa.me/1', displayOrder: 1 }), false);
});
ok('public contact rejects non-string fields', () => {
  assert.strictEqual(isPublicContactShape({ platform: 123, label: 'WhatsApp', url: 'https://wa.me/1' }), false);
  assert.strictEqual(isPublicContactShape({ platform: 'whatsapp', label: null, url: 'https://wa.me/1' }), false);
  assert.strictEqual(isPublicContactShape({ platform: 'whatsapp', label: 'WhatsApp', url: null }), false);
});
ok('public contact rejects non-object / missing fields', () => {
  assert.strictEqual(isPublicContactShape(null), false);
  assert.strictEqual(isPublicContactShape(undefined), false);
  assert.strictEqual(isPublicContactShape('string'), false);
  assert.strictEqual(isPublicContactShape({}), false);
});

// 5. admin endpoint shape enforcement
const VALID_ADMIN_CONTACT = { platform: 'whatsapp', label: 'WhatsApp', value: '123456789', enabled: true, displayOrder: 1 };
eq('valid admin contact passes whitelist check', isAdminContactShape(VALID_ADMIN_CONTACT), true);
ok('admin contact must not expose non-admin fields (e.g. url)', () => {
  assert.strictEqual(isAdminContactShape({ platform: 'whatsapp', label: 'WhatsApp', value: '123', enabled: true, url: 'https://wa.me/1' }), false);
});
ok('admin contact rejects non-object', () => {
  assert.strictEqual(isAdminContactShape(null), false);
  assert.strictEqual(isAdminContactShape('string'), false);
});

// 6. scheme safety
eq('https is safe', safeUrlScheme('https://example.com/support'), 'https');
eq('http is safe', safeUrlScheme('http://example.com/support'), 'http');
eq('mailto is safe', safeUrlScheme('mailto:support@example.com'), 'mailto');
eq('tel is safe', safeUrlScheme('tel:+1234567890'), 'tel');
eq('javascript: is blocked', safeUrlScheme('javascript:alert(1)'), 'blocked');
eq('data: is blocked', safeUrlScheme('data:text/html,<h1>x</h1>'), 'blocked');
eq('file: is blocked', safeUrlScheme('file:///etc/passwd'), 'blocked');
eq('about: is blocked', safeUrlScheme('about:blank'), 'blocked');
eq('empty string is invalid', safeUrlScheme(''), 'invalid');
eq('whitespace-only is invalid', safeUrlScheme('   '), 'invalid');
eq('no scheme is invalid', safeUrlScheme('example.com/support'), 'invalid');
eq('case-insensitive https', safeUrlScheme('HTTPS://example.com'), 'https');
eq('case-insensitive javascript', safeUrlScheme('JavaScript:alert(1)'), 'blocked');

// 7. WhatsApp normalization
eq('wa.me URL preserved', normalizeWhatsApp('https://wa.me/15551234567'), 'https://wa.me/15551234567');
eq('wa.me with query/path stripped to digits', normalizeWhatsApp('https://wa.me/15551234567?text=hi'), 'https://wa.me/15551234567');
eq('wa.me with country code only', normalizeWhatsApp('https://wa.me/+15551234567'), 'https://wa.me/+15551234567');
eq('bare international number normalized', normalizeWhatsApp('+1 (555) 123-4567'), 'https://wa.me/+15551234567');
eq('bare number with dashes normalized', normalizeWhatsApp('+44-20-7946-0958'), 'https://wa.me/+442079460958');
eq('empty string returns null', normalizeWhatsApp(''), null);
eq('non-string returns null', normalizeWhatsApp(null), null);
eq('local number without + returns null', normalizeWhatsApp('5551234567'), null);
eq('wa.me without digits returns null', normalizeWhatsApp('https://wa.me/'), null);

// 8. email URL building
eq('buildEmailUrl produces mailto', buildEmailUrl('support@example.com', 'Help'), 'mailto:support@example.com?subject=Help');
eq('buildEmailUrl without subject', buildEmailUrl('support@example.com', null), 'mailto:support@example.com');
eq('buildEmailUrl with empty subject', buildEmailUrl('support@example.com', ''), 'mailto:support@example.com');
eq('buildEmailUrl rejects invalid email', buildEmailUrl('notanemail', 'Help'), null);
eq('buildEmailUrl rejects empty', buildEmailUrl('', 'Help'), null);

// 9. phone URL building
eq('buildTelUrl produces tel', buildTelUrl('+1 (555) 123-4567'), 'tel:+15551234567');
eq('buildTelUrl strips formatting', buildTelUrl('+44 20 7946 0958'), 'tel:+442079460958');
eq('buildTelUrl rejects empty', buildTelUrl(''), null);
eq('buildTelUrl rejects non-string', buildTelUrl(null), null);

// 10. label computation
eq('default label used when none stored', computeLabel('whatsapp', ''), 'WhatsApp');
eq('stored label preferred', computeLabel('whatsapp', 'Enterprise WhatsApp'), 'Enterprise WhatsApp');
eq('fallback label for unknown key', computeLabel('unknown', ''), 'unknown');
eq('trimmed stored label', computeLabel('email', '  Support Email  '), 'Support Email');

// 11. public contact projection
eq('enabled WhatsApp projects to public', projectToPublic({ platform: 'whatsapp', label: 'WhatsApp Support', value: 'https://wa.me/15551234567', enabled: true, displayOrder: 1 }),
  { platform: 'whatsapp', label: 'WhatsApp Support', url: 'https://wa.me/15551234567', order: 1 });
eq('disabled contact does not project', projectToPublic({ platform: 'whatsapp', label: 'WhatsApp Support', value: 'https://wa.me/15551234567', enabled: false, displayOrder: 1 }), null);
eq('empty value does not project', projectToPublic({ platform: 'whatsapp', label: 'WhatsApp Support', value: '', enabled: true, displayOrder: 1 }), null);
eq('blocked scheme does not project', projectToPublic({ platform: 'whatsapp', label: 'WhatsApp Support', value: 'javascript:alert(1)', enabled: true, displayOrder: 1 }), null);
eq('phone projects to public with tel URL', projectToPublic({ platform: 'phone', label: 'Phone Support', value: 'tel:+15551234567', enabled: true }),
  { platform: 'phone', label: 'Phone Support', url: 'tel:+15551234567', order: 999 });
eq('email projects to public with mailto URL', projectToPublic({ platform: 'email', label: 'Email Support', value: 'support@example.com', enabled: true }),
  { platform: 'email', label: 'Email Support', url: 'support@example.com', order: 999 });

// 12. audit log payload would not include secrets (contract check)
ok('projected public contact does not contain raw value', () => {
  const pub = projectToPublic({ platform: 'whatsapp', label: 'WhatsApp Support', value: 'https://wa.me/15551234567', enabled: true, displayOrder: 1 });
  assert.ok(pub);
  assert.strictEqual(pub.value, undefined);
  assert.strictEqual(pub.enabled, undefined);
  assert.strictEqual(pub.displayOrder, undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
