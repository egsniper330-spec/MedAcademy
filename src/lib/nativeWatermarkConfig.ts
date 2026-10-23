/**
 * nativeWatermarkConfig.ts
 *
 * Shared design tokens for the application-rendered forensic watermark
 * (NativeWatermarkOverlay → VdoCipher native adapter + offline player).
 *
 * ── ONE MARK, FOUR RENDERERS ─────────────────────────────────────────────────
 * The watermark is a single product control with four implementations, so its
 * numbers are published once here instead of being re-invented per renderer:
 *
 *   Plyr / YouTube in-HTML mark   src/lib/plyr/playerScript.ts
 *   VdoCipher WebView injection   src/lib/watermarkInjection.ts
 *   fullscreen DOM hook           src/hooks/useFullscreenWatermark.ts
 *   native overlay                src/components/NativeWatermarkOverlay.tsx
 *
 * Shared model (the three generated scripts interpolate the same rules):
 *   • CONTINUOUS billiard motion — the position advances from ELAPSED TIME every
 *     animation frame and reflects exactly off the four edges of the measured
 *     video box, subtracting the mark's own size so it never clips. The mark is
 *     independent of the playback-control idle timer: hiding the controls can
 *     never hide it, and it never fades, blinks or sits still.
 *   • TWO-LINE IDENTITY — the recipient's display name, then the complete public
 *     id directly underneath, never an `ID:` prefix.
 *   • RESPONSIVE TYPE — WATERMARK_FONT_FRAC of the smaller box dimension,
 *     clamped to WATERMARK_FONT_MIN_PX…WATERMARK_FONT_MAX_PX, so the mark reads
 *     on a phone and grows clearly larger in fullscreen.
 *   • Typography — #fff, weight 600 (id line 700), letterSpacing 0.3, two-layer
 *     text shadow, no background, one ellipsised line per identity part.
 *   • pointer-events:none — the mark can never intercept a tap, seek or control.
 *
 * The motion maths itself (bounds, reflection, clamping) lives in
 * src/lib/watermarkMotion.ts. This module only publishes design tokens.
 */

// ─── Typography ───────────────────────────────────────────────────────────────

/** Canonical size before any measurement exists (and the CSS floor). */
export const WATERMARK_FONT_PX = 15;
/** Responsive rule: this fraction of the SMALLER box dimension. */
export const WATERMARK_FONT_FRAC = 0.062;
export const WATERMARK_FONT_MIN_PX = 13;
export const WATERMARK_FONT_MAX_PX = 34;
/** Name line renders slightly smaller than the id line. */
export const WATERMARK_NAME_FONT_RATIO = 0.9;

// ─── Visibility ───────────────────────────────────────────────────────────────

/** Native per-mount opacity draw — always visible, never animated. */
export const WATERMARK_OPACITY_MIN = 0.38;
export const WATERMARK_OPACITY_MAX = 0.58;
/** Per-mount tilt jitter, ±3°. */
export const WATERMARK_ROTATION_DEG = 3;

// ─── Layout ───────────────────────────────────────────────────────────────────

export const WATERMARK_MAX_WIDTH_CAP = 320;
export const WATERMARK_MAX_WIDTH_FRAC = 0.55;

// ─── Random helpers ───────────────────────────────────────────────────────────

export function wmRand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Per-mount rotation jitter in degrees (±WATERMARK_ROTATION_DEG, 1 decimal). */
export function wmRandomRotation(): number {
  return Number(wmRand(-WATERMARK_ROTATION_DEG, WATERMARK_ROTATION_DEG).toFixed(1));
}

/** Per-mount opacity draw — inside the always-readable band. */
export function wmRandomOpacity(): number {
  return Number(wmRand(WATERMARK_OPACITY_MIN, WATERMARK_OPACITY_MAX).toFixed(2));
}
