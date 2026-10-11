/**
 * watermarkMotion.ts
 *
 * CONTINUOUS BILLIARD-STYLE MOTION for the application-rendered forensic
 * watermark (`NativeWatermarkOverlay`). Pure, dependency-free, deterministic —
 * every function is a total function of its inputs, so the whole model is
 * verifiable in Node without a device or a renderer.
 *
 * ── WHY THIS REPLACES THE SLOT GRID ─────────────────────────────────────────
 * The previous implementation was a behavioral replica of the Plyr/YouTube
 * in-HTML watermark: nine fixed slots (nativeWatermarkConfig WATERMARK_SLOTS),
 * a random no-repeat slot pick every 30–60 s and a 600 ms glide between them.
 * That is a *teleport with a glide*, not continuous motion: the mark sits
 * almost still, then visibly slides to one of nine known places. It was also
 * fragile in two ways that produced the reported defects:
 *
 *   1. `wmClampPosition` needs the element's real width/height. The overlay
 *      moved on a timer that could fire BEFORE the pill had reported its
 *      layout, so it clamped with a 1×1 assumption — and a right/bottom slot
 *      then clamped to `container - 1 - inset`, pushing a ~200 px pill
 *      hundreds of pixels past the right edge where the container's
 *      `overflow: hidden` clipped it ("partially outside the video frame /
 *      clipped / text missing").
 *   2. Position was only ever assigned at move time, so a container resize
 *      (rotation, fullscreen) left the pill outside the new bounds until the
 *      next 30–60 s tick — and a collapsed (0×0) container produced no
 *      placement at all ("the watermark disappears").
 *
 * This module keeps the position INSIDE the bounds by construction: every step
 * reflects the movement off all four edges of the real video viewport, using
 * the measured element size, and out-of-range positions are impossible.
 *
 * ── MODEL ───────────────────────────────────────────────────────────────────
 *   • Position is the element's TOP-LEFT corner in container pixels.
 *   • Velocity is px/second, so the trajectory is frame-rate independent:
 *     a 120 Hz device and a 30 Hz device travel the same path.
 *   • Bounds are `[0, containerW - elementW] × [0, containerH - elementH]`
 *     — i.e. the element's own box, so the whole watermark stays inside.
 *   • Reflection is exact (the overshoot is reflected, not discarded), so the
 *     mark never "sticks" to a wall and never loses energy.
 *   • `dt` is clamped, so a stalled/backgrounded frame cannot tunnel the mark
 *     through a wall in a single step.
 *
 * ── NON-GOALS ───────────────────────────────────────────────────────────────
 * No randomness at step time (angles are drawn once on create/reflect-jitter),
 * no timers, no React, no Reanimated. The renderer owns the frame loop.
 */

// ─── Tuning ───────────────────────────────────────────────────────────────────

/**
 * Linear speed band, px/second. Deliberately slow: the mark must be visibly
 * moving at all times but must never fight the video for attention. 34–58 px/s
 * crosses a 390 px-wide phone player in roughly 7–11 s per traverse.
 */
export const WM_MOTION_MIN_SPEED = 34;
export const WM_MOTION_MAX_SPEED = 58;

/**
 * Minimum per-axis share of the velocity direction. Without this, a random
 * angle that happens to be nearly axis-aligned produces a mark that slides
 * along one edge for a long time.
 *
 * Each axis carries at least this fraction, so after normalisation the
 * horizontal share |vx|/speed is bounded by
 *     [MIN / √(1 + MIN²),  1 / √(1 + MIN²)]
 * because the extremes occur at the CORNERS (one axis at MIN, the other at 1)
 * — not at the 45° diagonal. At 0.6 that band is 0.514…0.857, i.e. every start
 * direction sits 31°…45° off the nearest axis: visibly diagonal, never sliding
 * along an edge, which is what "changing directions and angles" requires.
 *
 * (The band is asserted directly in tests/watermarkMotion.test.cjs, derived
 * from this constant rather than hard-coded, so retuning it keeps the test
 * meaningful.)
 */
export const WM_MOTION_MIN_AXIS_SHARE = 0.6;

/**
 * Largest simulation step accepted, in seconds. A frame longer than this is
 * treated as exactly this (a stall is not allowed to teleport the mark).
 */
export const WM_MOTION_MAX_STEP_S = 0.05;

/**
 * Guard against pathological loops when a step is enormous relative to the
 * bounds (e.g. a 1 px container). Reflections per step are capped here.
 */
const MAX_REFLECTIONS_PER_STEP = 8;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MotionBounds {
  /** Container (real video viewport) width in px. */
  width: number;
  /** Container (real video viewport) height in px. */
  height: number;
}

export interface MotionSize {
  /** Watermark element width in px (measured, never assumed). */
  width: number;
  /** Watermark element height in px. */
  height: number;
}

export interface WatermarkMotionState {
  /** Top-left x in container pixels. */
  x: number;
  /** Top-left y in container pixels. */
  y: number;
  /** Horizontal velocity, px/second. */
  vx: number;
  /** Vertical velocity, px/second. */
  vy: number;
}

/** A rng in [0,1) — injectable so tests are deterministic. */
export type RandomFn = () => number;

// ─── Internals ────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Largest legal top-left coordinate on one axis. Floors at 0 so an element
 * wider than its container is pinned to the left/top edge rather than
 * producing a negative range.
 */
function maxCoord(container: number, element: number): number {
  const m = container - element;
  return m > 0 ? m : 0;
}

/**
 * Advance one axis and reflect off both walls.
 *
 * Reflection is EXACT: on hitting the far wall the remainder travels back
 * (`2*max - next`), so speed is preserved and the mark cannot bunch up on an
 * edge. Returns the new position and the (possibly flipped) velocity sign.
 */
function advanceAxis(
  pos: number,
  vel: number,
  dtSec: number,
  max: number,
): { pos: number; vel: number; reflected: boolean } {
  if (max <= 0 || vel === 0 || dtSec <= 0) {
    return { pos: clamp(pos, 0, max), vel, reflected: false };
  }
  let next = pos + vel * dtSec;
  let v = vel;
  let reflected = false;

  for (let i = 0; i < MAX_REFLECTIONS_PER_STEP; i++) {
    if (next < 0) {
      next = -next;
      v = -v;
      reflected = true;
    } else if (next > max) {
      next = 2 * max - next;
      v = -v;
      reflected = true;
    } else {
      break;
    }
    // A reflect can legitimately land out of range again when dt is large
    // relative to the span; the loop resolves it, then the exactness of the
    // final clamp below guarantees an in-range result regardless.
  }
  return { pos: clamp(next, 0, max), vel: v, reflected };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Draw a varied, non-repeating initial direction.
 *
 * Both axes get a share of at least WM_MOTION_MIN_AXIS_SHARE, so the start is
 * always clearly diagonal; the four sign combinations are equally likely, so
 * successive sessions begin in visually different quadrants. Speed is drawn
 * from the band.
 */
export function wmRandomDirection(
  rng: RandomFn = Math.random,
  speed: number = wmRandomSpeed(rng),
): { vx: number; vy: number } {
  // WM_MOTION_MIN_AXIS_SHARE…1 per axis, then normalised — the ratio decides
  // the angle.
  const ax = WM_MOTION_MIN_AXIS_SHARE + rng() * (1 - WM_MOTION_MIN_AXIS_SHARE);
  const ay = WM_MOTION_MIN_AXIS_SHARE + rng() * (1 - WM_MOTION_MIN_AXIS_SHARE);
  const len = Math.hypot(ax, ay) || 1;
  const sx = rng() < 0.5 ? -1 : 1;
  const sy = rng() < 0.5 ? -1 : 1;
  return {
    vx: (ax / len) * speed * sx,
    vy: (ay / len) * speed * sy,
  };
}

/** Linear speed drawn from the band. */
export function wmRandomSpeed(rng: RandomFn = Math.random): number {
  return WM_MOTION_MIN_SPEED + rng() * (WM_MOTION_MAX_SPEED - WM_MOTION_MIN_SPEED);
}

/**
 * Create the initial motion state: somewhere random inside the bounds (never
 * exactly on an edge, so the first visible frames are unambiguous movement)
 * with a diagonal velocity.
 */
export function createWatermarkMotion(
  bounds: MotionBounds,
  size: MotionSize,
  rng: RandomFn = Math.random,
): WatermarkMotionState {
  const maxX = maxCoord(bounds.width, size.width);
  const maxY = maxCoord(bounds.height, size.height);
  const { vx, vy } = wmRandomDirection(rng);
  return {
    // 10–90 % of the legal span: not pinned to a wall, not dead-centre.
    x: maxX > 0 ? maxX * (0.1 + rng() * 0.8) : 0,
    y: maxY > 0 ? maxY * (0.1 + rng() * 0.8) : 0,
    vx,
    vy,
  };
}

/**
 * Advance the mark by `dtSec` seconds, reflecting off all four boundaries of
 * the actual video area. The result is ALWAYS inside
 * `[0, w - elementW] × [0, h - elementH]`.
 *
 * `dtSec` is clamped to WM_MOTION_MAX_STEP_S, so a long stall cannot tunnel
 * the mark through a wall; it simply resumes from where it was with one
 * bounded step.
 */
export function stepWatermarkMotion(
  state: WatermarkMotionState,
  dtSec: number,
  bounds: MotionBounds,
  size: MotionSize,
): WatermarkMotionState {
  const dt = clamp(dtSec, 0, WM_MOTION_MAX_STEP_S);
  if (dt === 0) {
    return { ...state };
  }
  const maxX = maxCoord(bounds.width, size.width);
  const maxY = maxCoord(bounds.height, size.height);

  const ax = advanceAxis(state.x, state.vx, dt, maxX);
  const ay = advanceAxis(state.y, state.vy, dt, maxY);

  return { x: ax.pos, y: ay.pos, vx: ax.vel, vy: ay.vel };
}

/** True when the last step hit a wall on either axis — used for diagnostics. */
export function didReflect(
  prev: WatermarkMotionState,
  next: WatermarkMotionState,
): boolean {
  return Math.sign(prev.vx) !== Math.sign(next.vx) || Math.sign(prev.vy) !== Math.sign(next.vy);
}

/**
 * Re-project the motion into new bounds after a resize / rotation / fullscreen
 * transition.
 *
 * The position is scaled proportionally (the mark keeps its relative place in
 * the video area) and then clamped, so a shrink can never leave it outside.
 * Velocity is preserved in magnitude and direction — the trajectory continues
 * smoothly instead of being re-randomised mid-playback (which would read as a
 * teleport). Between the bounds change and the next step the mark is therefore
 * already legal: `resolveWatermarkMotionBounds` is always safe to apply
 * synchronously in a layout callback.
 */
export function resolveWatermarkMotionBounds(
  state: WatermarkMotionState,
  prevBounds: MotionBounds,
  nextBounds: MotionBounds,
  size: MotionSize,
): WatermarkMotionState {
  const prevMaxX = maxCoord(prevBounds.width, size.width);
  const prevMaxY = maxCoord(prevBounds.height, size.height);
  const nextMaxX = maxCoord(nextBounds.width, size.width);
  const nextMaxY = maxCoord(nextBounds.height, size.height);

  const fx = prevMaxX > 0 ? state.x / prevMaxX : 0;
  const fy = prevMaxY > 0 ? state.y / prevMaxY : 0;

  return {
    x: clamp(fx * nextMaxX, 0, nextMaxX),
    y: clamp(fy * nextMaxY, 0, nextMaxY),
    vx: state.vx,
    vy: state.vy,
  };
}

/**
 * Re-clamp the current position for the CURRENT size/bounds without touching
 * velocity. Used when the element's own measured size changes (e.g. the text
 * grows): a position that was legal for a smaller pill may not be legal for a
 * larger one, and that is exactly how a mark ends up hanging outside the frame.
 */
export function clampWatermarkMotion(
  state: WatermarkMotionState,
  bounds: MotionBounds,
  size: MotionSize,
): WatermarkMotionState {
  const maxX = maxCoord(bounds.width, size.width);
  const maxY = maxCoord(bounds.height, size.height);
  return { ...state, x: clamp(state.x, 0, maxX), y: clamp(state.y, 0, maxY) };
}

/** True when every coordinate is legal for the given bounds/size. */
export function isWatermarkMotionInBounds(
  state: WatermarkMotionState,
  bounds: MotionBounds,
  size: MotionSize,
): boolean {
  const maxX = maxCoord(bounds.width, size.width);
  const maxY = maxCoord(bounds.height, size.height);
  return state.x >= 0 && state.x <= maxX && state.y >= 0 && state.y <= maxY;
}
