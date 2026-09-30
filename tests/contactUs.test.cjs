/**
 * contactUs.test.cjs — Contact Us end-to-end regression.
 *
 * Covers the task's scenarios:
 *   • loading always terminates (loaded / empty / error+retry — never a
 *     permanent spinner; the root cause was a never-cleared loading flag)
 *   • error state with Retry on genuine failure; no login redirect, no
 *     session clearing, no security misclassification
 *   • logo renders independently of links; failure degrades to bundled logo
 *   • enabled links only, configured order preserved
 *   • per-platform icon + label from the SINGLE registry (branding.ts)
 *   • URL safety: http(s)/mailto/tel allowed; js/data/file/intent refused
 *   • legacy channels dedupe against configured platforms (no duplicates),
 *     legacy DB values never deleted (they render only when not overridden)
 *   • Super Admin edit path (PUT /platform/branding) stays SA-gated
 *
 * Run: node tests/contactUs.test.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failures.push(msg); console.error(`  ✗ ${msg}`); }
}

const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r/g, '');

// ── Compile the registry so icon selection is tested against real code ────────
// branding.ts imports react + lucide-react-native, so a full standalone build
// needs shims; instead we resolve the exported registry through a tiny
// esbuild-free transpile with module stubs.
function buildBrandingModule() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brandbuild-'));
  // Project tsconfig supplies the @/ path alias; we only override the emit.
  const tsconfig = {
    compilerOptions: {
      module: 'commonjs',
      target: 'es2020',
      skipLibCheck: true,
      esModuleInterop: true,
      jsx: 'react-jsx',
      outDir: outDir,
      baseUrl: ROOT,
      paths: { '@/*': ['src/*'] },
      noEmit: false,
    },
    include: [path.join(ROOT, 'src', 'lib', 'branding.ts')],
  };
  const cfgPath = path.join(outDir, 'tsconfig.json');
  fs.writeFileSync(cfgPath, JSON.stringify(tsconfig));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p', cfgPath,
    ],
    { stdio: 'pipe' },
  );

  // Stub react / lucide / apiFetch so require() works in plain node. The
  // lucide stub MEMOIZES per icon name — real exports are stable references,
  // and the registry's identity comparisons depend on that.
  const lucideCache = {};
  const stubs = {
    'react': { useEffect: (f) => f(), useState: (v) => [typeof v === 'function' ? v() : v, () => {}] },
    'lucide-react-native': new Proxy({}, { get: (_t, name) => (lucideCache[name] ??= function Icon() { return null; }) }),
    '@/client/backendClient': { apiFetch: async () => ({ data: null, error: null }) },
  };
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    if (stubs[request]) return request; // maps to the stub cache below
    return origResolve.call(this, request, ...args);
  };
  const origLoad = require('module')._load;
  require('module')._load = function (request, parent, isMain) {
    if (stubs[request]) return stubs[request];
    return origLoad.call(this, request, parent, isMain);
  };

  // rootDir is inferred as the common root (src/), so the emit lands at
  // <outDir>/lib/branding.js — resolve it robustly instead of assuming.
  const emitted = path.join(outDir, 'lib', 'branding.js');
  if (!fs.existsSync(emitted)) {
    // Fallback: find branding.js anywhere under outDir.
    const find = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { const r = find(p); if (r) return r; }
        else if (e.name === 'branding.js') return p;
      }
      return null;
    };
    const found = find(outDir);
    if (!found) throw new Error('branding.js not emitted');
    return require(found);
  }
  return require(emitted);
}

let branding;
try {
  branding = buildBrandingModule();
} catch (e) {
  console.error('  ✗ branding.ts failed to compile/require:', e.message);
  process.exit(1);
}

console.log('\n── Registry (single source of truth) ──');
{
  const KEYS = ['whatsapp', 'telegram', 'facebook', 'instagram', 'twitter', 'website', 'email', 'phone'];
  for (const key of KEYS) {
    const def = branding.CONTACT_PLATFORMS[key];
    check(!!def && typeof def.icon === 'function', `platform '${key}' has a registry entry with an icon`);
    check(!!def && !!def.label && !!def.description && !!def.color, `platform '${key}' has label/description/color`);
  }
  // Presets mirror the registry (no duplicate list to drift).
  check(
    JSON.stringify(branding.CONTACT_LINK_PRESETS.map((p) => p.key)) === JSON.stringify(KEYS),
    'CONTACT_LINK_PRESETS is derived from the registry (CMS editor has no separate list)',
  );
  // Unknown platform degrades safely to the neutral link icon.
  const unknown = branding.platformDef('bebo');
  check(unknown.icon === branding.platformIcon('bebo') && unknown.icon === branding.platformIcon('anything-else') && !!unknown.label, 'unknown platform degrades to a neutral link icon + capitalized label (no crash)');
}

console.log('\n── Icon mapping (task examples) ──');
{
  // Icons are component references; assert they are distinct functions and map
  // to the expected registry entries.
  const map = {};
  for (const key of Object.keys(branding.CONTACT_PLATFORMS)) map[key] = branding.platformIcon(key);
  check(map.whatsapp === branding.CONTACT_PLATFORMS.whatsapp.icon, 'whatsapp → its registry icon');
  check(map.telegram === branding.CONTACT_PLATFORMS.telegram.icon, 'telegram → its registry icon');
  check(map.facebook === branding.CONTACT_PLATFORMS.facebook.icon, 'facebook → its registry icon');
  check(map.instagram === branding.CONTACT_PLATFORMS.instagram.icon, 'instagram → its registry icon');
  check(map.twitter === branding.CONTACT_PLATFORMS.twitter.icon, 'x/twitter → its registry icon');
  check(map.website === branding.CONTACT_PLATFORMS.website.icon, 'website → its registry icon');
  check(map.email === branding.CONTACT_PLATFORMS.email.icon, 'email → its registry icon');
  check(map.phone === branding.CONTACT_PLATFORMS.phone.icon, 'phone → its registry icon');
  check(new Set(Object.values(map)).size === 8, 'all 8 platform icons are distinct (no shared glyph)');
}

console.log('\n── URL safety (isSafeContactHref / contactLinkHref) ──');
{
  check(branding.isSafeContactHref('https://facebook.com/example') === true, 'https:// allowed');
  check(branding.isSafeContactHref('http://example.com') === true, 'http:// allowed');
  check(branding.isSafeContactHref('mailto:support@medacademy.app') === true, 'mailto: allowed');
  check(branding.isSafeContactHref('tel:+201234567890') === true, 'tel: allowed');
  check(branding.isSafeContactHref('javascript:alert(1)') === false, 'javascript: refused');
  check(branding.isSafeContactHref('data:text/html,hi') === false, 'data: refused');
  check(branding.isSafeContactHref('file:///etc/passwd') === false, 'file: refused');
  check(branding.isSafeContactHref('intent://x') === false, 'intent: refused');
  check(branding.isSafeContactHref('whatsapp://send?text=hi') === false, 'unknown app scheme refused');

  // contactLinkHref adds mailto:/tel: — a raw stored value can never carry a scheme.
  check(branding.contactLinkHref({ platform: 'email', label: 'E', url: 'a@b.c', enabled: true }) === 'mailto:a@b.c', 'email href gets mailto: prefix');
  check(branding.contactLinkHref({ platform: 'phone', label: 'P', url: '+20 123 456 7890', enabled: true }) === 'tel:+201234567890', 'phone href gets tel: prefix (non-digits stripped)');
  check(branding.contactLinkHref({ platform: 'telegram', label: 'T', url: 'https://t.me/x', enabled: true }) === 'https://t.me/x', 'web href passes through unchanged');
}

console.log('\n── parseContactLinks (server contract) ──');
{
  // Enabled ordering preserved; disabled entries flagged (screen filters them).
  const list = branding.parseContactLinks(JSON.stringify([
    { platform: 'telegram', label: 'Telegram', url: 'https://t.me/EG_SNIPER', enabled: true },
    { platform: 'facebook', label: 'Facebook', url: 'https://facebook.com/x', enabled: false },
    { platform: 'whatsapp', label: 'WhatsApp', url: 'https://wa.me/@eg', enabled: true },
  ]));
  check(list.length === 3, 'valid entries parsed');
  check(list[0].platform === 'telegram' && list[2].platform === 'whatsapp', 'configured order preserved');
  check(list[1].enabled === false, 'disabled flag carried through (screen hides it)');
  check(branding.parseContactLinks('not json at all').length === 0, 'malformed JSON → empty list (no crash)');
  check(branding.parseContactLinks(null).length === 0, 'null → empty list');
  check(branding.parseContactLinks([{ platform: '', url: 'https://x' }]).length === 0, 'entry without platform dropped');
}

console.log('\n── Screen contract (source assertions) ──');
const contactSrc = src('src/app/(app)/info/contact.tsx');
const brandingLibSrc = src('src/lib/branding.ts');
{
  console.log('\n── Loading always terminates ──');
  check(
    !/useState\(true\)/.test(contactSrc),
    'no stuck-at-true loading flag (the root cause: loading was initialized true and never cleared)',
  );
  check(
    /brandingStatus === 'ok'/.test(contactSrc),
    'render is driven by the fetch STATUS (loaded/error terminal states)',
  );
  check(
    /Unable to load Contact Us/.test(contactSrc) && /Retry/.test(contactSrc),
    'error state shows "Unable to load Contact Us" with a Retry action',
  );
  check(
    /Contact details are not yet configured\./.test(contactSrc),
    'empty state exists for no configured channels',
  );
  check(
    /refresh: \(\) => setTick/.test(brandingLibSrc) && /runRetry/.test(contactSrc),
    'Retry re-fetches branding (hook refresh wired to the screen)',
  );
  check(
    !/router\.(replace|push)\(.*(login|sign-in)/.test(contactSrc),
    'API failure never redirects to Login',
  );
  check(
    !/signOut|clearSession|SecurityGate/.test(contactSrc),
    'CMS failure is not treated as auth/security (no signOut/session clearing)',
  );

  console.log('\n── Logo ──');
  check(/BrandLogo/.test(contactSrc), 'uses the shared BrandLogo identity component (bundled brand source)');
  check(/logo_url/.test(contactSrc), 'remote logo_url override consumed from branding');
  check(/onError=\{\(\) => setState\('fallback'\)\}/.test(contactSrc), 'failed remote logo falls back to the bundled logo (page never blanks)');
  check(/width: size \* 3, height: size/.test(contactSrc), 'network image has explicit dimensions (RN requirement)');

  console.log('\n── Links rendering ──');
  check(/\.filter\(\(l\) => l\.enabled\)/.test(contactSrc), 'disabled links are filtered out (never shown to users)');
  check(/platformIcon\(item\.platform\)/.test(contactSrc), 'row icon comes from the centralized platformIcon()');
  check(/key=\{item\.platform\}/.test(contactSrc), 'stable React key per row (platform id, not index)');
  check(/accessibilityRole="button"/.test(contactSrc) && /accessibilityLabel=/.test(contactSrc), 'rows are accessible buttons with labels');
  check(
    /configured\.has\('whatsapp'\)/.test(contactSrc) && /configured\.has\('telegram'\)/.test(contactSrc),
    'legacy channels dedupe against configured platforms (no duplicate rows)',
  );
  check(
    !/contacts\.length === 0 \? null/.test(contactSrc),
    'no silently-hidden links (empty state is explicit)',
  );
  check(/Linking\.openURL/.test(contactSrc), 'tap opens the configured destination via Linking');
}

console.log('\n── Super Admin authorization (backend contract unchanged) ──');
{
  const routes = src('backend/routes/api.php');
  check(
    /put\('\/platform\/branding'[^]*super_admin/.test(routes) || /super_admin.*\n.*'updateBranding'/.test(routes) || /role' => \['super_admin'\]/.test(routes),
    'PUT /platform/branding stays super_admin-only (unauthorized users cannot modify links)',
  );
  const pc = src('backend/src/Controllers/PlatformController.php');
  check(/decodeContactLinks/.test(pc) && /catch \(ApiException\)/.test(pc), 'malformed DB JSON degrades to [] (endpoint never crashes)');
  check(
    /\['contact_links'\] = self::decodeContactLinks\(/.test(pc),
    'contact_links always returned as a valid array in the serializer',
  );
  check(/assertSuperAdmin\(\$request\)/.test(pc), 'backend asserts Super Admin on updateBranding');

  // ── Platform identity contract (regression pins) ──
  // Backend: the selected platform is the canonical identity — sanitize keeps
  // it distinct from label, the allowlist matches the client registry 1:1, and
  // an empty label derives from the platform (never hardcoded 'Website').
  check(
    /'platform' => \$platform/.test(pc),
    'backend persists the selected platform as the canonical identity',
  );
  check(
    /CONTACT_LINK_DEFAULT_LABELS\[\$platform\] \?\? ucfirst\(\$platform\)/.test(pc),
    'backend derives the default label from the platform registry map (never a hardcoded label)',
  );
  check(
    /\[\s*'whatsapp',\s*'telegram',\s*'facebook',\s*'instagram',\s*\s*'twitter',\s*'website',\s*'email',\s*'phone',\s*\]/.test(pc.replace(/\r/g, '')),
    'backend CONTACT_LINK_PLATFORMS allowlist covers all 8 registry keys',
  );
  // CMS editor: selecting a platform goes through setPlatform(), which sets
  // ONLY the platform key (plus the label auto-fill) —
  // this is the 'selected Facebook → label became Website' regression guard.
  const cms = src('src/app/(app)/(hubs)/cms.tsx');
  check(
    /onPress=\{\(\) => setPlatform\(index, p\)\}/.test(cms),
    'CMS platform presets route through setPlatform (no blind label overwrite)',
  );
  check(
    /autoFillLabel[\s\S]{0,400}\{ platform: def\.key, label: def\.label \} : \{ platform: def\.key \}/.test(cms),
    'CMS derives the default label from the platform and preserves custom labels',
  );
  check(
    /platform: 'website', label: 'Website', url: ''/.test(cms),
    'new links start from the website preset (label matches its own platform)',
  );
  // Mobile Contact Us: icon comes from the platform key, never the label text.
  const contactPage = src('src/app/(app)/info/contact.tsx');
  check(
    /platformDef\(item\.platform\)/.test(contactPage) && /platformIcon\(item\.platform\)/.test(contactPage),
    'mobile Contact Us resolves icon/color from the platform key (no label matching)',
  );
  check(
    !/label\.includes\(|label\.indexOf\(|label\.match\(/.test(contactPage),
    'mobile Contact Us never infers the platform from label text',
  );
  // Live behaviour over REAL code: select → save → reload keeps the platform.
  {
    const picks = [
      ['facebook', 'Facebook'], ['telegram', 'Telegram'], ['whatsapp', 'WhatsApp'],
      ['instagram', 'Instagram'], ['email', 'Email'], ['phone', 'Phone'],
      ['twitter', 'X / Twitter'], ['website', 'Website'],
    ];
    for (const [key, want] of picks) {
      const stored = branding.parseContactLinks([
        { platform: key, label: '', url: key === 'email' ? 'a@b.co' : key === 'phone' ? '+201000000000' : 'https://x.example', enabled: true },
      ]);
      check(stored.length === 1 && stored[0].platform === key && stored[0].label === want,
        `platform '${key}' → default label '${want}' survives parse (save/reload)`);
    }
    // A custom label must NOT change the icon platform.
    const custom = branding.parseContactLinks([
      { platform: 'facebook', label: 'Our Facebook Page', url: 'https://facebook.com/x', enabled: true },
    ]);
    check(custom[0].platform === 'facebook' && custom[0].label === 'Our Facebook Page',
      'custom label keeps the canonical platform (icon source unchanged)');
  }
}

console.log(`\n═══ contactUs: ${passed} passed, ${failures.length} failed ═══`);
if (failures.length) {
  failures.forEach((f) => console.error(`  FAIL: ${f}`));
  process.exit(1);
}
