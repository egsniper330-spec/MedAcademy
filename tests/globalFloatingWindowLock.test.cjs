/**
 * globalFloatingWindowLock.test.cjs
 *
 * Regression suite for the THREE reported defects fixed in this round:
 *
 *   A. The floating-window (focus-loss) detector is REMOVED — completely, from
 *      the native template, the JS model, the gate copy and both locales — and
 *      a window-mode lock still needs a restored mode plus a FRESH verdict to
 *      release it.
 *
 *   B. VPN / proxy detection must destroy the player IMMEDIATELY (hard
 *      containment), so MedAcademy's own WebView cannot keep issuing player or
 *      metadata requests during the network-bound verdict window. No automatic
 *      resume, and no metadata service in the app.
 *
 *   C. A disabled VPN must never clear a separate floating-window violation —
 *      the lock holders compose, so releasing one source cannot release another.
 *
 * Run: node tests/globalFloatingWindowLock.test.cjs
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  \u2705 ' + name); }
  else { failed++; console.error('  \u274c ' + name); }
}

// ── Compile the PURE modules exactly as the app compiles them ───────────────
function build(relSource, outName) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'globalwindow-'));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, relSource),
      '--outDir', tmp,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return require(path.join(tmp, outName));
}

const M = build('src/lib/securityStateModel.ts', 'securityStateModel.js');
const L = build('src/lib/securityLock.ts', 'securityLock.js');

const PLUGIN   = read('plugins/withSecurityModule.js');
const CONTEXT  = read('src/lib/SecurityContext.tsx');
const GATE     = read('src/app/(app)/security-gate.tsx');
const LESSON   = read('src/app/(app)/lesson/[id].tsx');
const YT       = read('src/components/YouTubePlayer.tsx');
const SURFACE  = read('src/components/ProtectedContentSurface.tsx');
const TABS     = read('src/components/navigation/GlassTabBar.tsx');
/** GlassTabBar with comments stripped: a comment that QUOTES the old mirroring
 *  must not be able to satisfy (or defeat) the contract being asserted. */
const TABS_CODE = TABS
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const RES      = read('src/lib/i18n/resources.ts');

/** The foreign-window branch of applyWindowModeReading (comment-safe slice). */
const APPLY_START = CONTEXT.indexOf('const applyWindowModeReading = useCallback');
const APPLY_END   = CONTEXT.indexOf('nativeWindowPreflightRef.current', APPLY_START);
const APPLY       = CONTEXT.slice(APPLY_START, APPLY_END);
const FOREIGN     = (() => {
  const a = APPLY.indexOf("if (mode === 'foreign_window') {");
  const b = APPLY.indexOf("if (isProhibitedWindowMode(mode)) {", a);
  return a >= 0 && b > a ? APPLY.slice(a, b) : '';
})();

/** The injected Activity override for the top-resumed signal. */
const TOP_RESUMED = (() => {
  const a = PLUGIN.indexOf('override fun onTopResumedActivityChanged');
  const b = PLUGIN.indexOf('override fun onWindowFocusChanged', a);
  return a >= 0 ? PLUGIN.slice(a, b > a ? b : a + 4000) : '';
})();

// ══════════════════════════════════════════════════════════════════════════
console.log('\nA. App-wide lock for a foreign floating window');
// ══════════════════════════════════════════════════════════════════════════

check('A1: a foreign (floating) window is NO LONGER a prohibited window mode',
  M.isProhibitedWindowMode('foreign_window') === false
  && M.isProhibitedWindowMode('multi_window') === true
  && M.isProhibitedWindowMode('picture_in_picture') === true);

check('A2: a prohibited window mode renders the full-screen block page',
  M.rendersBlockScreen('BLOCKED_MULTI_WINDOW') === true
  && M.resolveSecurityGateState({
    evaluating: false, hasVerdict: true, overlayBlocked: false,
    multiWindowBlocked: true, backgroundResumeBlocked: false,
    vpnBlocked: false, violationBlocked: false,
  }) === 'BLOCKED_MULTI_WINDOW');

check('A3: no foreign branch survives in the JS applier',
  FOREIGN === '' && !/foreign_window/.test(APPLY));

check('A4: split-screen / PiP take the HARD lock (screens unmount the player)',
  /if \(isProhibitedWindowMode\(mode\)\) \{[\s\S]{0,600}engageSecurityLock\(LOCK_SRC_WINDOW_MODE, \{ hard: true \}\)/.test(APPLY));

check('A5: they still conceal/destroy protected content at the same instant',
  /blockProtectedContent\('multi-window'\)/.test(APPLY));

check('A6: the lock engages before the content block (no video-only window)',
  APPLY.indexOf('engageSecurityLock') < APPLY.indexOf("blockProtectedContent('multi-window')"));

check('A7: the engaged mode is remembered for the gate copy',
  /windowModeEngagedModeRef\.current = mode;/.test(APPLY)
  && /windowModeEngagedSerialRef\.current = verdictSerialRef\.current/.test(APPLY));

check('A8: release needs a restored mode AND a strictly newer verdict',
  M.canClearMultiWindowBlock({ modeRestored: false, hasFreshVerdict: true }) === false
  && M.canClearMultiWindowBlock({ modeRestored: true, hasFreshVerdict: false }) === false
  && M.canClearMultiWindowBlock({ modeRestored: true, hasFreshVerdict: true }) === true);

check('A9: a stale verdict cannot release the hold (serial is compared, not a boolean)',
  /hasFreshVerdict: verdictSerialRef\.current > windowModeEngagedSerialRef\.current/.test(CONTEXT));

check('A10: the gate has NO foreign-window page left',
  !GATE.includes('foreign_window') && !GATE.includes('security.window.foreign'));

check('A11: no foreign-window copy survives in either locale',
  !/security\.window\.foreign/.test(RES)
  && !/security\.window\.foreign/.test(read('src/lib/i18n/resources.ts')));

check('A12: the multi-window copy never claims an overlay or another app',
  !/overlay/i.test(M.windowModeBlockCopy('multi_window').message)
  && !/another app is showing/i.test(M.windowModeBlockCopy('multi_window').message));

check('A13: the gate traps the hardware back button while the page is up',
  /BackHandler\.addEventListener\('hardwareBackPress', \(\) => true\)/.test(GATE));

// ── Native signal ─────────────────────────────────────────────────────────
check('A14: the top-resumed / focus-loss override is GONE from the activity',
  TOP_RESUMED === '' && !/onTopResumedActivityChanged/.test(PLUGIN.slice(0, PLUGIN.indexOf('const WINDOW_MODE_ACTIVITY_MARKER'))));

check('A15: no settled focus re-check (700 ms) remains in the emitted Kotlin',
  // The JS upgrade guard NAMES the retired symbols on purpose (so an already
  // patched MainActivity is re-injected); the Kotlin TEMPLATE must not contain
  // them. Only the template is scanned, so the guard's own regex cannot count.
  !/scheduleForeignCheck|cancelForeignCheck|activityPaused|foreignWindowCheck|onTopResumedActivityChanged/
    .test(PLUGIN.slice(0, PLUGIN.indexOf('const WINDOW_MODE_ACTIVITY_MARKER'))));

check('A16: the activity still reports real mode changes and resume',
  /WindowModeBridge\.report\(isInMultiWindowMode, isInPictureInPictureMode\(\), "mode-change"\)/.test(PLUGIN)
  && /WindowModeBridge\.report\(isInMultiWindowMode\(\), isInPictureInPictureMode\(\), "lifecycle"\)/.test(PLUGIN));

check('A17: overlay prevention (permission, focus hook, listener) is removed',
  // The Kotlin template only: the JS upgrade guard names retired symbols.
  !/applyHideOverlayWindows|HIDE_OVERLAY_WINDOWS|enableOverlayProtection/.test(
    PLUGIN.slice(0, PLUGIN.indexOf('const WINDOW_MODE_ACTIVITY_MARKER')))
  && !/onWindowFocusChanged/.test(PLUGIN.slice(0, PLUGIN.indexOf('const WINDOW_MODE_ACTIVITY_MARKER')))
  && !/observeTouch|isWindowObscured/.test(PLUGIN.slice(0, PLUGIN.indexOf('const WINDOW_MODE_ACTIVITY_MARKER'))));

check('A18: an already-patched MainActivity is UPGRADED, not skipped',
  /UPGRADE PATH for an already-patched activity/.test(PLUGIN)
  && /contents\.slice\(0, blockStart\) \+ contents\.slice\(classBrace\)/.test(PLUGIN));

// ══════════════════════════════════════════════════════════════════════════
console.log('\nB. VPN detection: immediate hard containment, no post-lock requests');
// ══════════════════════════════════════════════════════════════════════════

check('B1: the native VPN callback takes a HARD lock (not provisional)',
  /engageSecurityLock\(LOCK_SRC_NATIVE_VPN, \{ hard: true \}\)/.test(CONTEXT));

check('B2: the lesson screen destroys the player when the lock is hard',
  /!blocksVideo && !securityLockHard/.test(LESSON));

check('B3: the player is rendered only when protected content is visible',
  /!protectedContent\.visible \?/.test(LESSON));

check('B4: concealment UNMOUNTS the WebView (children only while visible)',
  /if \(!visible\) return null/.test(SURFACE.replace(/\s+/g, ' '))
  || /visible \? /.test(SURFACE));

check('B5: the WebView refuses NEW navigations while the security lock is held',
  /onShouldStartLoadWithRequest=\{\(\) => \{/.test(YT)
  && /if \(isSecurityLocked\(\)\)/.test(YT));

check('B6: no navigation URL/host is logged (privacy)',
  !/console\.(log|warn)\([^)]*req\.url/.test(YT));

check('B7: there is NO automatic resume of the player',
  !/WEBVIEW_RESUME_SCRIPT/.test(YT)
  && /const revealWebPlayer = useCallback\(\(\) => \{[\s\S]{0,160}Intentionally no play/.test(YT));

check('B8: a hard WebView stopper (pause + detach) is still registered with the lock',
  /registerPlaybackStopper/.test(read('src/lib/useSecurityWebViewStop.ts')));

// The vendor bundle is the SOURCE of the leak (Plyr's default urls.youtube.api),
// so it is excluded from the scan and the app's own code must not reference the
// service anywhere except the guard that refuses it.
const METADATA_HITS = (() => {
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|js|cjs|json)$/.test(entry.name)) continue;
      if (full.endsWith(path.join('lib', 'plyr', 'plyrBundle.ts'))) continue;
      if (/noembed\.com|youtube\.com\/oembed|oembed\./i.test(fs.readFileSync(full, 'utf8'))) hits.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  return hits;
})();

check('B9: the vendored Plyr bundle is the ONLY origin of the noembed request',
  /noembed\.com\/embed\?url=https:\/\/www\.youtube\.com\/watch\?v=\{0\}/
    .test(read('src/lib/plyr/plyrBundle.ts')));

check('B9-2: the app\'s own code never CALLS an oEmbed/noembed service',
  METADATA_HITS.every((f) => f.endsWith(path.join('lib', 'plyr', 'playerScript.ts')))
  && METADATA_HITS.length === 1);

check('B9-3: the player refuses those metadata URLs before the library loads',
  /export const PLAYER_METADATA_GUARD = `/.test(read('src/lib/plyr/playerScript.ts'))
  && /BLOCKED\.test\(url\)/.test(read('src/lib/plyr/playerScript.ts'))
  && /Promise\.reject\(new Error\('blocked third-party video metadata request'\)\)/
    .test(read('src/lib/plyr/playerScript.ts'))
  && YT.indexOf('${PLAYER_METADATA_GUARD}') > 0
  && YT.indexOf('${PLAYER_METADATA_GUARD}') < YT.indexOf('${PLYR_JS}'));

check('B10: no player retry loop re-mounts after a violation',
  !/setTimeout\([^)]*playerVisible\s*=\s*true/.test(LESSON)
  && !/autoRetry|retryPlayback/i.test(YT));

// ══════════════════════════════════════════════════════════════════════════
console.log('\nC. Lock composition: a disabled VPN cannot clear a floating window');
// ══════════════════════════════════════════════════════════════════════════

L._resetSecurityLockForTests();
L.engageSecurityLock('window-mode', { hard: true });
L.engageSecurityLock('native-vpn', { hard: true });
L.releaseSecurityLock('native-vpn');
check('C1: releasing the VPN holder keeps the floating-window lock engaged',
  L.isSecurityLocked() === true
  && L.getSecurityLockState().sources.includes('window-mode'));

check('C2: the surviving hold is still hard (player stays destroyed)',
  L.isSecurityLockHard() === true);

L.releaseSecurityLock('window-mode');
check('C3: only releasing the window-mode holder unlocks the app',
  L.isSecurityLocked() === false);

check('C4: a lock engaged before mount still runs containment on registration',
  /if \(holders\.size > 0\) \{[\s\S]{0,200}stop\(\);/.test(read('src/lib/securityLock.ts')));

check('C5: the release path never reads React state (synchronous lock module)',
  /const state = snapshot\(\)/.test(read('src/lib/securityLock.ts')));

// ══════════════════════════════════════════════════════════════════════════
console.log('\nD. Liquid Bar: one authoritative route \u2192 slot \u2192 bubble mapping');
// ══════════════════════════════════════════════════════════════════════════

check('D1: the row is reversed ONCE and never double-mirrored',
  /isRTL \? \[\.\.\.visibleRoutes\]\.reverse\(\) : visibleRoutes/.test(TABS_CODE)
  && !/row-reverse/.test(TABS_CODE));

// RN SWAPS `left`/`right` in RTL (doLeftAndRightSwapInRTL), proven on the tablet:
// a plain `left: i * tabWidth` put the selected Home slot under Profile. The
// mapping is therefore written from the swapped edge when the platform swaps.
check('D2: the slot mapping accounts for the platform RTL edge swap',
  /const swapEdges = I18nManager\.isRTL && I18nManager\.doLeftAndRightSwapInRTL !== false;/.test(TABS_CODE)
  && /swapEdges\s*\n?\s*\? Math\.max\(rowSpan - \(i \+ 1\) \* tabWidth, 0\)\s*\n?\s*: i \* tabWidth;/.test(TABS_CODE));

check('D2-2: the drag hit-test and travel are converted through the same model',
  /const bubbleStart = specifiedToPhysical\(liveX\.current\);/.test(TABS_CODE)
  && /\* \(swapEdges \? -1 : 1\)/.test(TABS_CODE));

check('D3: the span is measured on the row itself and bounded by the pill',
  /onRowLayout\(event\.nativeEvent\.layout\.width\)/.test(TABS)
  && /Math\.min\(rawSpan, pillSpan\)/.test(TABS));

check('D4: a stale measurement cannot overwrite newer geometry',
  /if \(epoch !== layoutEpoch\.current\) return;/.test(TABS));

check('D5: the bubble can never be hidden behind a zero geometry',
  /opacity: indicatorWidth > 0 \? 1 : 0,/.test(TABS));

// ══════════════════════════════════════════════════════════════════════════
console.log('\n' + '\u2500'.repeat(62));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('\nGLOBAL / FLOATING-WINDOW LOCK TESTS FAILED'); process.exit(1); }
console.log('Global floating-window lock, VPN containment and tab mapping: OK');
