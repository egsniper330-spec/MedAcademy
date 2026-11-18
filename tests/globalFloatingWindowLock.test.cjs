/**
 * globalFloatingWindowLock.test.cjs
 *
 * Regression suite for the THREE reported defects fixed in this round:
 *
 *   A. A foreign floating / pop-up window must lock the WHOLE application
 *      (not just the video player), and only a positive full-screen reading
 *      plus a FRESH verdict may release it.
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

check('A1: the model treats a foreign window as a prohibited window mode',
  M.isProhibitedWindowMode('foreign_window') === true);

check('A2: a prohibited window mode renders the full-screen block page',
  M.rendersBlockScreen('BLOCKED_MULTI_WINDOW') === true
  && M.resolveSecurityGateState({
    evaluating: false, hasVerdict: true, overlayBlocked: false,
    multiWindowBlocked: true, backgroundResumeBlocked: false,
    vpnBlocked: false, violationBlocked: false,
  }) === 'BLOCKED_MULTI_WINDOW');

check('A3: the JS applier takes the GLOBAL window-mode lock for a foreign window',
  /engageSecurityLock\(LOCK_SRC_WINDOW_MODE, \{ hard: true \}\)/.test(FOREIGN));

check('A4: the lock is HARD, so screens unmount the player',
  FOREIGN.includes('{ hard: true }'));

check('A5: it still conceals/destroys protected content at the same instant',
  /blockProtectedContent\('foreign-window'\)/.test(FOREIGN));

check('A6: the branch no longer returns after a video-only response',
  FOREIGN.indexOf('engageSecurityLock') < FOREIGN.indexOf("blockProtectedContent('foreign-window')")
  && /engageSecurityLock/.test(FOREIGN));

check('A7: the engaged mode is remembered for the gate copy',
  /windowModeEngagedModeRef\.current = mode;/.test(FOREIGN)
  && /windowModeEngagedSerialRef\.current = verdictSerialRef\.current;/.test(FOREIGN));

check('A8: release needs a restored mode AND a strictly newer verdict',
  M.canClearMultiWindowBlock({ modeRestored: false, hasFreshVerdict: true }) === false
  && M.canClearMultiWindowBlock({ modeRestored: true, hasFreshVerdict: false }) === false
  && M.canClearMultiWindowBlock({ modeRestored: true, hasFreshVerdict: true }) === true);

check('A9: a stale verdict cannot release the hold (serial is compared, not a boolean)',
  /hasFreshVerdict: verdictSerialRef\.current > windowModeEngagedSerialRef\.current/.test(CONTEXT));

check('A10: the gate has a dedicated foreign-window page (not the split-screen copy)',
  GATE.includes("windowMode === 'foreign_window'")
  && GATE.includes("'security.window.foreign.title'")
  && GATE.includes("'security.window.foreign.message'"));

check('A11: the foreign page copy exists in BOTH locales (en + ar)',
  (RES.match(/'security\.window\.foreign\.title'/g) || []).length === 2
  && (RES.match(/'security\.window\.foreign\.message'/g) || []).length === 2);

check('A12: the model\u2019s foreign copy never names the other app',
  !/package|com\.[a-z]+\./i.test(M.windowModeBlockCopy('foreign_window').message));

check('A13: the gate traps the hardware back button while the page is up',
  /BackHandler\.addEventListener\('hardwareBackPress', \(\) => true\)/.test(GATE));

// ── Native signal ─────────────────────────────────────────────────────────
check('A14: the activity reports a foreign window only when ANOTHER ACTIVITY owns the top-resumed slot',
  TOP_RESUMED.length > 0 && /topResumedActivity = isTopResumed/.test(TOP_RESUMED));

check('A15: that signal is reported IMMEDIATELY (no 700 ms settle)',
  /WindowModeBridge\.report\(isInMultiWindowMode\(\), isInPictureInPictureMode\(\), true, true\)/.test(TOP_RESUMED)
  && !/scheduleForeignCheck/.test(TOP_RESUMED));

check('A16: the notification shade cannot be mistaken for a foreign app (API 29+)',
  /SDK_INT >= 29 && topResumedActivity\) return false/.test(PLUGIN));

check('A17: returning the top-resumed slot reports full screen again',
  /WindowModeBridge\.report\(isInMultiWindowMode\(\), isInPictureInPictureMode\(\), false, true\)/.test(TOP_RESUMED));

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

check('D2: slot position is direction-independent arithmetic',
  /\(i: number\) => \(Number\.isFinite\(tabWidth\) && tabWidth > 0 \? i \* tabWidth : 0\)/.test(TABS_CODE)
  && !/rowSpan - \(i \+ 1\) \* tabWidth/.test(TABS_CODE));

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
