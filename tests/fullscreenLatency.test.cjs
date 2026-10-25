#!/usr/bin/env node
/**
 * Fullscreen ENTRY latency + fail-closed enforcement contract
 * (Plyr/YouTube, offline VdoCipher, online VdoCipher).
 *
 * Reported symptom: "when entering fullscreen in the Plyr player there is a
 * noticeable delay before fullscreen actually appears".
 *
 * ── Root cause (pinned here) ─────────────────────────────────────────────────
 * Fullscreen used to be entered in this order:
 *
 *   tap → await SECURITY GATE (checkBeforeVideo → runGuardedCheck →
 *         runSecurityChecks: 14 detectors in Promise.all including the
 *         NETWORK-bound runPlayIntegrityCheck() and getSecurityPolicies())
 *       → setIsFullscreen(true)
 *       → orientation effect → lockAsync(LANDSCAPE)
 *
 * The visible transition was therefore blocked behind a network round-trip, and
 * the rotation was requested only after it. Not a timer — a network call.
 *
 * ── Fix 1: rotation overlaps the evaluation (ordering) ───────────────────────
 *   beginFullscreenOrientation() runs BEFORE the gate, so the OS rotates while
 *   the verdict is computed. Every denial path calls releaseFullscreenOrientation().
 *
 * ── Fix 2 (user-approved): instant entry on the LIVE verdict ─────────────────
 *   When the host supplies `fullscreenVerdictNow()` (a SYNCHRONOUS read of
 *   SecurityContext's published verdict), fullscreen commits in the same frame as
 *   the tap, and the authoritative gate re-validates IN PARALLEL:
 *     • Plyr/offline  → the background re-validation collapses fullscreen on denial;
 *     • VdoCipher     → the existing live gate mirror (immediate + every 5s) collapses it.
 *   Fail-closed on BOTH sides: a false/throwing sync verdict never expands, and a
 *   background denial always collapses. The host's render gate (`blocksVideo`)
 *   remains authoritative and now also collapses the screen's fullscreen layout.
 *
 * Usage: node tests/fullscreenLatency.test.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}

/**
 * Function body with comments stripped (so prose can never satisfy a pin).
 * Strips block comments, whole-line comments and TRAILING comments — a trailing
 * `// …` would otherwise hide an assignment from the pins below.
 */
function fnBody(src, signature) {
  const i = src.indexOf(signature);
  if (i === -1) return '';
  const end = src.indexOf('\n  }, [', i);
  const raw = src.slice(i, end === -1 ? Math.min(src.length, i + 4000) : end + 8);
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+\/\/[^\n]*/g, ''); // requires whitespace before // → never eats 'https://'
}

const PLAYERS = [
  { name: 'Plyr/YouTube', file: 'src/components/YouTubePlayer.tsx' },
  { name: 'VdoCipher online', file: 'src/components/VdoCipherPlayerNativeAdapter.native.tsx' },
  { name: 'VdoCipher offline', file: 'src/components/OfflineVideoPlayer.native.tsx' },
];
const ENTER = 'const enterFullscreen = useCallback(async () => {';
const EXIT = 'const exitFullscreen = useCallback(() => {';

console.log('── Root cause: the fullscreen gate is network-bound ──');
{
  const security = read('src/lib/security.ts');
  const ctx = read('src/lib/SecurityContext.tsx');

  ok(/export async function runSecurityChecks/.test(security), 'runSecurityChecks() exists');
  ok(/runPlayIntegrityCheck\(\)/.test(security),
    'the pipeline awaits the NETWORK-bound Play Integrity check (backend nonce → Google → backend verify)');
  // The fetch is now STARTED before the detectors and awaited where its result is
  // used (so the network wait overlaps the native probes instead of being
  // serialised after them). The pipeline still AWAITS it — it is not
  // fire-and-forget, and the decision still comes from the server.
  ok(/await getSecurityPolicies\(\)/.test(security) || /const policies\s*= await policiesP;/.test(security),
    'the pipeline awaits the server security-policy fetch');
  ok(/genuinelyOffline \? Promise\.resolve\(null\) : runPlayIntegrityCheck\(\)/.test(security),
    'the offline fast-path skips only the genuinely-offline case (honest, not a bypass)');
  ok(/const checkBeforeVideo = useCallback\(async \(\): Promise<boolean> => \{/.test(ctx),
    'checkBeforeVideo() is async (callers must await a network round-trip)');
  // Pre-video re-validation must be a FRESH, complete evaluation: it is the
  // moment protected media is authorised, so it can never ride on cached
  // evidence. The reason it passes is what selects the scope, and only a
  // resume/periodic trigger may use the narrower one.
  ok(/await runGuardedCheck\('pre-video'\)/.test(ctx) &&
    /const scope: SecurityCheckScope = \(reason\.startsWith\('resume'\) \|\| reason === 'periodic'\)[\s\S]{0,120}\? 'resume'[\s\S]{0,40}: 'full'/.test(ctx),
    'checkBeforeVideo() runs a FULL fresh evaluation (not a cached verdict read)');
  ok(!/setTimeout/.test(fnBody(ctx, 'const checkBeforeVideo = useCallback')),
    'the delay is NOT an artificial timer — it is the evaluation itself');
}

console.log('── Fix 1: rotation requested in parallel with the evaluation ──');
{
  for (const p of PLAYERS) {
    const enter = fnBody(read(p.file), ENTER);
    ok(enter !== '', `${p.name}: enterFullscreen() located`);
    const beginIdx = enter.indexOf('beginFullscreenOrientation()');
    ok(beginIdx !== -1 && beginIdx < 120,
      `${p.name}: rotation is requested at the very start of entry`);
    ok(!/await beginFullscreenOrientation|await ScreenOrientation/.test(enter),
      `${p.name}: the rotation request never blocks entry`);
    ok(!/setTimeout|setInterval/.test(enter),
      `${p.name}: no timers introduced in the entry path`);
  }
  const helper = read('src/lib/fullscreenOrientation.ts');
  ok(/Platform\.OS !== 'android'/.test(helper), 'orientation helper is Android-only (iOS never forced)');
  ok(!/setTimeout|setInterval/.test(helper), 'orientation helper is timer-free');
  ok(/OrientationLock\.PORTRAIT_UP/.test(helper), 'helper can roll the rotation back');
}

console.log('── Fix 2: instant entry on the live verdict (fail-closed both ways) ──');
{
  for (const p of PLAYERS) {
    const src = read(p.file);
    const enter = fnBody(src, ENTER);

    ok(/fullscreenVerdictNow/.test(src), `${p.name}: declares the live-verdict prop`);

    // The prop is reached directly (offline) or through a live ref (Plyr / VdoCipher),
    // so the read is either `fullscreenVerdictNow()` or `verdictNow()`.
    const syncNeedle = enter.includes('fullscreenVerdictNow()') ? 'fullscreenVerdictNow()' : 'verdictNow()';
    const syncIdx = enter.indexOf(syncNeedle);
    ok(syncIdx !== -1, `${p.name}: reads the synchronous verdict (${syncNeedle})`);
    ok(syncIdx !== -1 && syncIdx < enter.indexOf('await '),
      `${p.name}: the sync verdict is read BEFORE any await (entry is immediate)`);

    ok(/let allowedNow = false;/.test(enter),
      `${p.name}: fail-closed default (no verdict read == denied)`);
    ok(/catch \{\s*allowedNow = false;\s*\}/.test(enter),
      `${p.name}: a throwing verdict read denies entry`);

    const denyIdx = enter.indexOf('releaseFullscreenOrientation();');
    ok(denyIdx !== -1, `${p.name}: a denied request rolls the rotation back`);

    // commit happens inside the sync branch, before the fallback await
    const commitIdx = enter.indexOf('setIsFullscreen(true)');
    ok(commitIdx !== -1 && commitIdx < syncIdx + 600,
      `${p.name}: fullscreen commits immediately in the sync branch`);
  }

  // Parallel re-validation must exist, or the sync path would skip enforcement.
  const yt = fnBody(read('src/components/YouTubePlayer.tsx'), ENTER);
  ok(/void \(async \(\) => \{[\s\S]*?await gateFn\(\)[\s\S]*?setIsFullscreen\(false\)/.test(yt),
    'Plyr: the authoritative gate re-runs in PARALLEL and collapses fullscreen on denial');
  ok(/catch \{\s*setIsFullscreen\(false\);/.test(yt),
    'Plyr: a throwing background evaluation also collapses (fail-closed)');

  const offline = fnBody(read('src/components/OfflineVideoPlayer.native.tsx'), ENTER);
  ok(/void \(async \(\) => \{[\s\S]*?await shouldAllowPlayback\(\)[\s\S]*?setIsFullscreen\(false\)/.test(offline),
    'offline: the authoritative gate re-runs in PARALLEL and collapses on denial');
  ok(/setGateDenied\(true\)/.test(offline),
    'offline: a denial also marks the gate denied (honest blocked UI)');

  const vdo = read('src/components/VdoCipherPlayerNativeAdapter.native.tsx');
  ok(/const iv = setInterval\(recheck, 5000\);/.test(vdo) && /void recheck\(\);/.test(vdo),
    'VdoCipher: the existing live gate mirror re-checks immediately and every 5s');
  ok(/if \(!cancelled && ok === false\) setIsFullscreen\(false\);/.test(vdo),
    'VdoCipher: the live mirror collapses fullscreen when the verdict refuses');

  // The strict path must still exist for surfaces that do not supply a verdict.
  for (const p of PLAYERS) {
    const enter = fnBody(read(p.file), ENTER);
    ok(/FALLBACK|await shouldAllowFullscreen\(\)|await gate\(\)|await shouldAllowPlayback\(\)/.test(enter),
      `${p.name}: the blocking fallback path is preserved when no verdict is wired`);
  }
}

console.log('── Hosts supply the live verdict (and stay fail-closed) ──');
{
  const lesson = read('src/app/(app)/lesson/[id].tsx');
  // STRENGTHENED (security-lock pass): the live verdict must also refuse when
  // the CENTRAL security lock is held. A VPN raises `block_login`, never
  // `blocksVideo`, so keying fullscreen on blocksVideo alone would let a
  // blocked device still promote the player above the security gate.
  ok(/fullscreenVerdictNow=\{\(\) => isSuperAdmin \|\| \(!blocksVideo && !securityLockHard\)\}/.test(lesson),
    'lesson screen: verdict = Super Admin bypass OR (no blocksVideo AND no hard security lock)');
  ok(/if \(!blocksVideo && !securityLockHard\) return;\s*setIsFullscreen\(false\);/.test(lesson),
    'lesson screen: a violation (or a hard lock) collapses the fullscreen layout too');

  const router = read('src/components/VideoPlayer.tsx');
  ok((router.match(/fullscreenVerdictNow=\{fullscreenVerdictNow\}/g) || []).length === 2,
    'VideoPlayer forwards the live verdict to BOTH the YouTube and VdoCipher players');

  for (const [name, rel] of [['offline-course', 'src/app/(app)/offline-course.tsx'],
                             ['offline-library', 'src/app/(app)/offline-library.tsx']]) {
    const src = read(rel);
    ok(/fullscreenVerdictNow=\{\(\) => !blocksVideo && !securityLockHard\}/.test(src),
      `${name}: passes the live verdict (and the hard security lock) to the offline player`);
    ok(/shouldAllowPlayback=\{async \(\) => !\(await checkBeforeVideo\(\)\)\}/.test(src),
      `${name}: keeps the authoritative async gate (still re-validated)`);
  }
}

console.log('── Exit stays immediate, no player recreation, no stray re-entry ──');
{
  for (const p of PLAYERS) {
    const src = read(p.file);
    const enter = fnBody(src, ENTER);
    const exit = fnBody(src, EXIT);
    ok(/setIsFullscreen\(false\)/.test(exit), `${p.name}: exit is a single synchronous flip`);
    ok(!/await /.test(exit), `${p.name}: exit awaits nothing (immediate)`);
    ok(!/enterFullscreen\(/.test(exit), `${p.name}: exit never re-enters fullscreen`);
    ok(!/key=\{|setPlayerKey/.test(enter + exit),
      `${p.name}: the transition never recreates/reloads the player`);
  }
  const yt = read('src/components/YouTubePlayer.tsx');
  ok(/allowsFullscreenVideo=\{false\}/.test(yt),
    'Plyr: native/WebView fullscreen stays disabled — ONE in-place RN fullscreen');
}

console.log(failed
  ? `\nRESULT: ${passed} passed, ${failed} failed`
  : `\nPASS: ${passed} fullscreen-latency checks (instant entry + parallel re-validation + fail-closed)`);
process.exit(failed ? 1 : 0);
