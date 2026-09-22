/**
 * nativeWatermarkConfig.ts
 *
 * THE authoritative watermark configuration — extracted verbatim from the
 * Plyr/YouTube player's in-HTML watermark implementation
 * (src/lib/plyr/playerScript.ts, `injectWatermark`).
 *
 * Chain of authority (per the watermark source-of-truth decision):
 *
 *   Plyr / YouTube player (playerScript.ts)  ← SOURCE OF TRUTH — DO NOT MODIFY
 *        ↓  same slot table, timing, opacity band, typography, glide
 *   nativeWatermarkConfig (this file)
 *        ↓
 *   NativeWatermarkOverlay  →  VdoCipher ONLINE (native adapter)
 *                           →  VdoCipher OFFLINE (offline player)
 *
 * The Plyr implementation itself is NOT touched. This module only republishes
 * its constants so both native VdoCipher paths behave identically to it.
 *
 * Plyr behavior being copied (verified against playerScript.ts):
 *   • 9-slot grid, 8 % inset from every edge (Plyr's `G` table).
 *   • Random no-repeat slot selection (Plyr `nxtSlot`).
 *   • Smooth 600 ms ease GLIDE to the next slot while staying visible —
 *     Plyr never fades out/teleports/hides the watermark (CSS transition
 *     on transform + opacity, 0.6 s ease).
 *   • Rotation jitter ±3° on every move (Plyr `rnd(-3, 3)`).
 *   • Opacity band 0.38–0.58 per move, initial 0.40–0.56 (Plyr `move`/mount).
 *   • Move every 30–60 s, random per tick (Plyr `scheduleTick`).
 *   • Clamp: whole element stays inside the player with ≥6 % inset
 *     (Plyr `mkTransform`).
 *   • Typography: #fff, 13 px, weight 600, letterSpacing 0.3, two-layer
 *     text shadow, single line with ellipsis, max width min(320 px, 55 %).
 *   • Label format: `NAME • ID` (U+2022 bullet), or just `ID` when no name.
 *   • NO security pulse, NO hide gap, NO full fade-out — watermark is
 *     always on screen somewhere.
 */

// ─── Slot table — verbatim from Plyr `G` (9 slots, 8 % inset) ──────────────────
export const WATERMARK_SLOTS: ReadonlyArray<readonly [number, number]> = [
  [0.08, 0.08], [0.42, 0.08], [0.72, 0.08],
  [0.04, 0.42], [0.35, 0.42], [0.68, 0.42],
  [0.08, 0.74], [0.42, 0.74], [0.72, 0.74],
];

// ─── Timing — verbatim from Plyr ────────────────────────────────────────────────
export const WATERMARK_MOVE_MIN_MS  = 30_000; // Plyr scheduleTick lower bound
export const WATERMARK_MOVE_MAX_MS  = 60_000; // Plyr scheduleTick upper bound
export const WATERMARK_GLIDE_MS     =     600; // Plyr CSS transition 0.6s ease
export const WATERMARK_ROTATION_DEG =       3; // Plyr rnd(-3, 3)

// ─── Opacity band — verbatim from Plyr ─────────────────────────────────────────
export const WATERMARK_OPACITY_MIN      = 0.38; // Plyr move()
export const WATERMARK_OPACITY_MAX      = 0.58; // Plyr move()
export const WATERMARK_OPACITY_INIT_MIN = 0.40; // Plyr mount()
export const WATERMARK_OPACITY_INIT_MAX = 0.56; // Plyr mount()

// ─── Layout — verbatim from Plyr ───────────────────────────────────────────────
export const WATERMARK_INSET_FRACTION = 0.06; // Plyr mkTransform ≥6 % inset
export const WATERMARK_MAX_WIDTH_CAP  = 320;  // Plyr max-width:min(320px,55%)
export const WATERMARK_MAX_WIDTH_FRAC = 0.55;

// ─── Random helpers (same semantics as Plyr) ──────────────────────────────────
export function wmRand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Random slot, never the same as `exclude` (Plyr nxtSlot). */
export function wmNextSlotIndex(exclude: number): number {
  let n: number;
  do { n = Math.floor(Math.random() * WATERMARK_SLOTS.length); } while (n === exclude);
  return n;
}

/** Per-move rotation jitter in degrees (Plyr rnd(-3, 3), 1 decimal). */
export function wmRandomRotation(): number {
  return Number(wmRand(-WATERMARK_ROTATION_DEG, WATERMARK_ROTATION_DEG).toFixed(1));
}

/**
 * Plyr `mkTransform` clamp as fractions→pixels: keep the WHOLE element inside
 * the container with a ≥6 % inset, so right/bottom slots can never clip the
 * text on narrow players (this was the native "parts of the watermark are
 * missing" bug when slots were clamped differently than Plyr).
 */
export function wmClampPosition(
  slot: readonly [number, number],
  containerW: number,
  containerH: number,
  elementW: number,
  elementH: number,
): { x: number; y: number } {
  const inset = Math.round(Math.min(containerW, containerH) * WATERMARK_INSET_FRACTION);
  const x = Math.min(
    Math.round(slot[0] * containerW),
    Math.max(inset, containerW - elementW - inset),
  );
  const y = Math.min(
    Math.round(slot[1] * containerH),
    Math.max(inset, containerH - elementH - inset),
  );
  return { x: Math.max(x, inset), y: Math.max(y, inset) };
}

/** Plyr per-move opacity draw. */
export function wmRandomOpacity(): number {
  return Number(wmRand(WATERMARK_OPACITY_MIN, WATERMARK_OPACITY_MAX).toFixed(2));
}

/** Plyr initial opacity draw (mount). */
export function wmInitialOpacity(): number {
  return Number(wmRand(WATERMARK_OPACITY_INIT_MIN, WATERMARK_OPACITY_INIT_MAX).toFixed(2));
}

/** Plyr per-tick delay. */
export function wmNextMoveDelayMs(): number {
  return Math.round(wmRand(WATERMARK_MOVE_MIN_MS, WATERMARK_MOVE_MAX_MS));
}
