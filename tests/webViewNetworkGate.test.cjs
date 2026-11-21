/**
 * webViewNetworkGate.test.cjs
 *
 * Regression suite for the NATIVE WebView network gate and the two unnecessary
 * third-party player requests (Build 239 scope):
 *
 *   A. `setBlockNetworkLoads(true)` is applied NATIVELY, at WebView creation and
 *      on the native VPN callback — before React can unmount anything.
 *   B. The first YouTube document is loaded only after a FRESH native VPN
 *      authorization (fail closed: VPN / UNKNOWN / unregistered / no authorizer
 *      / throw all deny), and no JS path can grant it.
 *   C. The player no longer requests Plyr's CDN sprite or noembed.com.
 *   D. Every previous security decision is intact (VPN latch, reasons, cover,
 *      player teardown, no accessibility/UsageStats additions).
 *
 * The native side ships as a maintained patch (patches/react-native-webview+…)
 * because react-native-webview exposes no blockNetworkLoads surface.
 *
 * Run: node tests/webViewNetworkGate.test.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// Normalise line endings: the repo is checked out with CRLF on Windows and a
// regex written for LF must not depend on the workstation's git settings.
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .split(String.fromCharCode(13)).join('');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  \u2705 ' + name); }
  else { failed++; console.error('  \u274c ' + name); }
}

const PKG_VERSION = require(path.join(ROOT, 'node_modules', 'react-native-webview', 'package.json')).version;
const PATCH_REL = `patches/react-native-webview+${PKG_VERSION}.patch`;
const PATCH = read(PATCH_REL);
const PATCHED = (rel) => read(`node_modules/react-native-webview/${rel}`);

const PLUGIN   = read('plugins/withSecurityModule.js');
const YT       = read('src/components/YouTubePlayer.tsx');
const SCRIPT   = read('src/lib/plyr/playerScript.ts');
const SPRITE   = read('src/lib/plyr/plyrSprite.ts');
const SURFACE  = read('src/components/ProtectedContentSurface.tsx');
const LOCK     = read('src/lib/securityLock.ts');

const GATE_KT  = PATCHED('android/src/main/java/com/reactnativecommunity/webview/RNCWebViewNetworkGate.kt');
const IMPL_KT  = PATCHED('android/src/main/java/com/reactnativecommunity/webview/RNCWebViewManagerImpl.kt');
const VIEW_JAVA = PATCHED('android/src/main/java/com/reactnativecommunity/webview/RNCWebView.java');
const NEW_MGR  = PATCHED('android/src/newarch/com/reactnativecommunity/webview/RNCWebViewManager.java');
const OLD_MGR  = PATCHED('android/src/oldarch/com/reactnativecommunity/webview/RNCWebViewManager.java');
const SPEC     = PATCHED('src/RNCWebViewNativeComponent.ts');

// ── A. Native gate: blocked from creation, blocked on VPN ───────────────────
console.log('\nA. Native WebView network gate (blockNetworkLoads)');

check('A1: a maintained patch exists for the installed react-native-webview version',
  /^react-native-webview\+\d+\.\d+\.\d+\.patch$/.test(path.basename(PATCH_REL))
  && PATCH.includes('node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/RNCWebViewNetworkGate.kt')
  && PATCH.includes('ServiceWorkerController'));

check('A2: the gate sets blockNetworkLoads(true) before any document exists',
  /fun setNetworkGate\(viewWrapper: RNCWebViewWrapper, value: Boolean\)/.test(IMPL_KT)
  && /webView\.networkGateAuthorized = false[\s\S]{0,400}webView\.settings\.blockNetworkLoads = true/.test(IMPL_KT));

check('A3: the view is REGISTERED with the gate only while gated',
  /RNCWebViewNetworkGate\.register\(webView\)/.test(IMPL_KT)
  && /RNCWebViewNetworkGate\.unregister\(webView\)/.test(IMPL_KT));

check('A4: the VPN callback blocks and stops loading on the MAIN thread',
  /fun blockAll\(reason: String\)/.test(GATE_KT)
  && /Looper\.myLooper\(\) == Looper\.getMainLooper\(\)/.test(GATE_KT)
  && /main\.post \{ applyBlock\(targets, reason\) \}/.test(GATE_KT)
  && /view\.settings\.blockNetworkLoads = true[\s\S]{0,200}view\.stopLoading\(\)/.test(GATE_KT));

check('A5: a destroyed/detached view can never break the block pass',
  /RNCWebViewNetworkGate\.INSTANCE\.unregister\(this\)/.test(VIEW_JAVA)
  && /catch \(t: Throwable\)/.test(GATE_KT)
  && /private val views = ArrayList<WeakReference<WebView>>\(\)/.test(GATE_KT));

check('A6: repeated registration does not duplicate a view (no stale entries)',
  /if \(ref\.get\(\) === view\) return/.test(GATE_KT)
  && /private fun prune\(\)/.test(GATE_KT));

// ── B. Authorization: fresh, native, fail-closed, non-overridable ───────────
console.log('\nB. Native authorization before the first load');

check('B1: the first load is gated and the refusal returns WITHOUT loading',
  /if \(view\.networkGateEnabled && !view\.networkGateAuthorized\) \{/.test(IMPL_KT)
  && /if \(!decision\.allowed\) \{[\s\S]{0,400}return/.test(IMPL_KT)
  && IMPL_KT.indexOf('RNCWebViewNetworkGate.authorize(view.context)') < IMPL_KT.indexOf('view.loadDataWithBaseURL('));

check('B2: authorization unblocks BEFORE the load (so no reload() is needed)',
  /view\.settings\.blockNetworkLoads = false/.test(IMPL_KT)
  && IMPL_KT.indexOf('view.settings.blockNetworkLoads = false') < IMPL_KT.indexOf('view.loadDataWithBaseURL(')
  && !/view\.reload\(\)/.test(IMPL_KT.split('private fun loadSource')[1] || ''));

check('B3: the app authorizer reads a FRESH ConnectivityManager state, not a cached verdict',
  /fun freshSnapshot\(context: Context\?\): Boolean\?/.test(PLUGIN)
  && /hasDefaultVpn\(cm\) \|\| hasAnyVpnNetwork\(cm\)/.test(PLUGIN)
  && /if \(!registered\) return null/.test(PLUGIN));

check('B4: VPN active is DENIED',
  /fresh -> RNCWebViewNetworkGate\.Decision\(false, "vpn-active"\)/.test(PLUGIN));

check('B5: UNKNOWN / unregistered / unavailable native state is DENIED',
  /fresh == null -> RNCWebViewNetworkGate\.Decision\(false, "vpn-unknown"\)/.test(PLUGIN)
  && /vpn-watch-unregistered/.test(PLUGIN)
  && /val current = authorizer \?: return Decision\(false, "no-native-authorizer"\)/.test(GATE_KT)
  && /Decision\(false, "authorizer-error"\)/.test(GATE_KT));

check('B6: only a fresh clean reading ALLOWS a load',
  /else -> RNCWebViewNetworkGate\.Decision\(true, "no-vpn"\)/.test(PLUGIN));

check('B7: the authorizer is installed before any gated view can exist',
  /fun ensure\(context: Context\?\) \{[\s\S]{0,1200}installWebViewGate\(\)/.test(PLUGIN)
  && /SecurityContainment\.ensureVpnWatch\(applicationContext\)/.test(PLUGIN));

check('B8: the native VPN raise BLOCKS the WebView before the cover/latch is raised',
  /RNCWebViewNetworkGate\.blockAll\("vpn-transport:" \+ source\)[\s\S]{0,300}SecurityContainment\.raise\(SecurityContainment\.REASON_VPN/.test(PLUGIN)
  && /RNCWebViewNetworkGate\.blockAll\("vpn-present:" \+ source\)[\s\S]{0,300}SecurityContainment\.raise\(SecurityContainment\.REASON_VPN/.test(PLUGIN));

check('B9: JS can ENABLE the gate but there is no JS command that unblocks it',
  /networkGate\?: WithDefault<boolean, false>/.test(SPEC)
  && /@ReactProp\(name = "networkGate"\)/.test(NEW_MGR)
  && /@ReactProp\(name = "networkGate"\)/.test(OLD_MGR)
  && !/unblockNetwork|authorizeNetwork|allowNetworkLoads/i.test(SPEC)
  && !/COMMAND_[A-Z_]*NETWORK/.test(IMPL_KT)
  // The only place the view becomes authorized is the native decision above.
  && (IMPL_KT.match(/networkGateAuthorized = true/g) || []).length === 1);

check('B10: the player passes networkGate to the ONE WebView it renders',
  /ref=\{wvRef\}[\s\S]{0,900}?\n          networkGate\n/.test(YT)
  && (YT.match(/\n          networkGate\n/g) || []).length === 1);

check('B11: the JS pre-network barrier is preserved as a second layer',
  /const \[vpnBarrierClear, setVpnBarrierClear\] = useState\(false\)/.test(YT)
  && /if \(!vpnBarrierClear\) \{/.test(YT)
  && /snap\.registered && !snap\.vpnTransport && !snap\.vpnPresent/.test(YT));

check('B12: service-worker network loads are blocked through the framework API, before any page loads',
  /ServiceWorkerController\.getInstance\(\)[\s\S]{0,120}serviceWorkerWebSettings[\s\S]{0,80}blockNetworkLoads = true/.test(GATE_KT)
  && /Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.N/.test(GATE_KT)
  && /RNCWebViewNetworkGate\.blockServiceWorkerNetworkLoads\(\)/.test(PLUGIN)
  // Applied from the process-start path (activity onResume), never per page.
  && /fun ensure\(context: Context\?\) \{[\s\S]{0,1200}blockServiceWorkerNetworkLoads\(\)/.test(PLUGIN));

// ── C. Unnecessary third-party player requests ──────────────────────────────
console.log('\nC. No CDN sprite, no noembed title lookup');

check('C1: the Plyr sprite is bundled locally from the installed package',
  /export const PLYR_SPRITE: string = /.test(SPRITE)
  && /id=\\"plyr-play\\"/.test(SPRITE)
  && /id=\\"plyr-pause\\"/.test(SPRITE));

check('C2: the player document embeds the sprite with the id Plyr looks for',
  /<div id="sprite-plyr" hidden>\$\{PLYR_SPRITE\}<\/div>/.test(YT)
  && YT.includes("import { PLYR_SPRITE } from '../lib/plyr/plyrSprite';"));

check('C3: the sprite is injected BEFORE Plyr initializes',
  YT.indexOf('${PLYR_SPRITE}') < YT.indexOf('${PLYR_JS}'));

check('C4: no iconUrl override is passed to Plyr (the CDN default is simply unreachable)',
  !/iconUrl\s*:/.test(SCRIPT)
  && !/loadSprite\s*:\s*false/.test(SCRIPT));

check('C5: the guard now covers XHR as well as fetch (Plyr 3.8.4 uses XHR)',
  /XMLHttpRequest\.prototype\.open = function \(method, url\)/.test(SCRIPT)
  && /args\[1\] = localUrl;/.test(SCRIPT)
  && /Promise\.reject\(new Error\('blocked third-party video metadata request'\)\)/.test(SCRIPT));

check('C6: the rewrite is narrowed to the three metadata hosts',
  SCRIPT.includes('noembed')
  && SCRIPT.includes('vimeo')
  && SCRIPT.split('\n').some((l) => l.includes('var BLOCKED') && l.includes('oembed') && l.includes('/i;')));

check('C7: the lookup itself is pointed at a local blob document',
  /URL\.createObjectURL/.test(SCRIPT)
  && /window\.__medaLocalMetadataUrl = localUrl;/.test(SCRIPT)
  && /ytUrls\.api = window\.__medaLocalMetadataUrl;/.test(SCRIPT));

check('C8: the XHR branch rewrites instead of rejecting (a rejection would hang Plyr)',
  /args\[1\] = localUrl;[\s\S]{0,160}return nativeOpen\.apply\(this, args\);/.test(SCRIPT)
  && /var nativeOpen = XMLHttpRequest\.prototype\.open;/.test(SCRIPT)
  && !/args\[1\] = localUrl;[\s\S]{0,200}Promise\.reject/.test(SCRIPT));

// ── C9. RUNTIME behaviour of the guard (not just its source text) ───────────
{
  let ok = false;
  const opened = [];
  const marker = 'export const PLAYER_METADATA_GUARD = ';
  const start = SCRIPT.indexOf(marker) + marker.length;
  const end = SCRIPT.indexOf('`;\n\nexport const PLAYER_SCRIPT', start);
  if (start > marker.length && end > start) {
    const guard = eval(SCRIPT.slice(start, end + 1)); // template literal -> script text
    const g = global;
    const saved = { window: g.window, Blob: g.Blob, URL: g.URL, XMLHttpRequest: g.XMLHttpRequest };
    g.window = {};
    g.Blob = class { constructor(parts) { this.parts = parts; } };
    g.URL = { createObjectURL: () => 'blob:local-metadata' };
    g.XMLHttpRequest = function () {};
    g.XMLHttpRequest.prototype.open = function (method, url) { opened.push(url); };
    try {
      new Function(guard)();
      const X = g.XMLHttpRequest.prototype.open;
      new g.XMLHttpRequest().open('GET', 'https://noembed.com/embed?url=https://www.youtube.com/watch?v=abc');
      new g.XMLHttpRequest().open('GET', 'https://www.youtube.com/api/oembed.json?url=x');
      new g.XMLHttpRequest().open('GET', 'https://www.youtube.com/iframe_api');
      new g.XMLHttpRequest().open('GET', 'https://rr3---sn-abc.googlevideo.com/videoplayback?x=1');
      ok = opened[0] === 'blob:local-metadata'
        && opened[1] === 'blob:local-metadata'
        && opened[2] === 'https://www.youtube.com/iframe_api'
        && opened[3] === 'https://rr3---sn-abc.googlevideo.com/videoplayback?x=1'
        && g.window.__medaLocalMetadataUrl === 'blob:local-metadata';
    } finally {
      g.window = saved.window; g.Blob = saved.Blob; g.URL = saved.URL;
      g.XMLHttpRequest = saved.XMLHttpRequest;
    }
  }
  check('C9: at runtime the guard rewrites oEmbed XHRs locally and passes every other URL through', ok);
}

// ── D. Preserved security and product decisions ─────────────────────────────
console.log('\nD. Existing protections preserved');

check('D1: the VPN reason and independent latch are untouched',
  /SecurityContainment\.REASON_VPN/.test(PLUGIN)
  && /fun raise\(/.test(PLUGIN)
  && /fun clear\(/.test(PLUGIN)
  && /REASON_VPN/.test(PLUGIN));

check('D2: the player is still destroyed on a hard lock, not merely hidden',
  /!blocksVideo && !securityLockHard/.test(read('src/app/(app)/lesson/[id].tsx'))
  && /!protectedContent\.visible \?/.test(read('src/app/(app)/lesson/[id].tsx'))
  && /\{visible \? \(/.test(SURFACE));

check('D3: the WebView still refuses navigation while the lock is held',
  /onShouldStartLoadWithRequest=\{\(\) => \{/.test(YT)
  && /if \(isSecurityLocked\(\)\)/.test(YT));

check('D4: no automatic resume was introduced',
  !/WEBVIEW_RESUME_SCRIPT/.test(YT)
  && /registerPlaybackStopper/.test(read('src/lib/useSecurityWebViewStop.ts')));

check('D5: no AccessibilityService is registered and UsageStats stays blocked',
  !/extends\s+AccessibilityService/.test(PLUGIN)
  && !/BIND_ACCESSIBILITY_SERVICE/.test(PLUGIN)
  && !/registerAccessibility/.test(PLUGIN)
  && JSON.stringify(require(path.join(ROOT, 'app.json')).expo.android.blockedPermissions || [])
    .includes('PACKAGE_USAGE_STATS'));

check('D6: the lock module is still the synchronous, holder-based source of truth',
  /const state = snapshot\(\)/.test(LOCK)
  && /new Map<SecurityLockSource, Holder>()/.test(LOCK));

check('D7: the player HTML keeps the official YouTube/Plyr embed and the watermark',
  /new Plyr\('#player'/.test(SCRIPT)
  && /injectWatermark/.test(SCRIPT)
  && /data-plyr-provider="youtube"/.test(YT));

// ───────────────────────────────────────────────────────────────────────────
console.log('\n' + '\u2500'.repeat(62));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('\nWEBVIEW NETWORK GATE TESTS FAILED'); process.exit(1); }
console.log('Native WebView network gate, native authorization and local player assets: OK');
