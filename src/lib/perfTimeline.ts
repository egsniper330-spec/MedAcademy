/**
 * perfTimeline — DEV-ONLY startup/navigation stage timing.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * "The app feels slow" is not measurable from source code. The startup path has
 * four serial phases that can each dominate on a real device, and which one
 * dominates depends on the device, the network and the account:
 *
 *   1. js-start          — Hermes loads the bundle and this module initialises
 *   2. session-restored  — SecureStore read resolves; the UI may render
 *   3. security-verdict  — the security evaluation finishes and releases the
 *                          network lock that holds every protected request
 *   4. profile-resolved  — GET profile returns; the role redirect can run
 *   5. screen-data       — the first screen's own batch landed
 *
 * Without timestamps for those five points there is no way to tell a slow
 * device from a slow network from a slow security gate — every optimisation
 * becomes a guess. These marks cost nothing in production (the whole module
 * compiles to `if (!__DEV__) return;`) and give exact deltas on a real device.
 *
 * ── HOW TO READ IT ──────────────────────────────────────────────────────────
 * In a development build the timeline is printed once per launch, when the first
 * screen reports its data:
 *
 *   [Perf] cold launch timeline (ms since JS start)
 *     js-start            0
 *     session-restored   34
 *     security-verdict  920   (+886)
 *     profile-resolved 1180   (+260)
 *     screen-data      1495   (+315)
 *
 * Reproduce with: cold launch (force-quit, reopen), background→foreground
 * (resume), and a screen round-trip. Compare `security-verdict` against
 * `profile-resolved`: if the verdict dominates, the time is security/network
 * bound; if `screen-data` dominates, it is the screen's own request or render.
 *
 * There is NO production behaviour change and NO sensitive data: only stage
 * names and millisecond offsets are recorded, never payloads, tokens or ids.
 */

/** The stages the app reports. Ordering is the expected startup order. */
export type PerfStage =
  | 'js-start'
  | 'session-restored'
  | 'security-verdict'
  | 'profile-resolved'
  | 'screen-data';

const STAGE_ORDER: PerfStage[] = [
  'js-start',
  'session-restored',
  'security-verdict',
  'profile-resolved',
  'screen-data',
];

/**
 * Origin for every delta. Set when this module is first evaluated, which on a
 * cold launch is effectively "JS started running".
 */
const ORIGIN = Date.now();

const marks = new Map<PerfStage, number>();
let printed = false;

/** True in a development build only — everything below is a no-op otherwise. */
function enabled(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

/**
 * Record a stage. The FIRST observation wins: a resume or a second screen must
 * not overwrite the cold-launch timeline that is being measured.
 */
export function markPerf(stage: PerfStage): void {
  if (!enabled()) return;
  if (marks.has(stage)) return;
  marks.set(stage, Date.now());
}

/** Milliseconds from JS start to `stage`, or null when it never happened. */
export function perfSinceStart(stage: PerfStage): number | null {
  const at = marks.get(stage);
  return at === undefined ? null : at - ORIGIN;
}

/** The recorded timeline in stage order (dev builds only). */
export function perfTimeline(): { stage: PerfStage; at: number | null }[] {
  return STAGE_ORDER.map((stage) => ({ stage, at: perfSinceStart(stage) }));
}

/**
 * Print the timeline ONCE per launch (dev builds only). Called when the first
 * screen's data arrives, which is the last stage the app can observe.
 */
export function logPerfTimeline(): void {
  if (!enabled() || printed) return;
  const rows = perfTimeline().filter((r) => r.at !== null) as { stage: PerfStage; at: number }[];
  if (rows.length < 2) return; // nothing meaningful recorded yet
  printed = true;

  const lines = ['', '[Perf] cold launch timeline (ms since JS start)'];
  let previous = 0;
  for (const { stage, at } of rows) {
    const delta = at - previous;
    lines.push(`  ${stage.padEnd(18)} ${String(at).padStart(5)}   (+${delta})`);
    previous = at;
  }
  console.log(lines.join('\n'));
}

/** Test hook: reset recorded marks (never used by app code). */
export function __resetPerfTimelineForTests(): void {
  marks.clear();
  printed = false;
}
