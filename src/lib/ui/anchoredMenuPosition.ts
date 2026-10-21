/**
 * anchoredMenuPosition.ts — PURE placement math for menus/popovers that hang
 * off a trigger (sort menus, filter menus, pickers).
 *
 * WHY THIS EXISTS (root cause of the RTL bug)
 * ──────────────
 * Every anchored menu in this app used to be a plain absolutely-positioned
 * `View` with a hardcoded side (`top: 46, right: 0`). `right` is a PHYSICAL
 * edge in React Native: it is never mirrored by `I18nManager`, and it says
 * nothing about which side of the trigger the menu should open on. In Arabic
 * the trigger moves to the inline-start (right) side of the row, but the menu
 * still opened toward the left and could run off-screen.
 *
 * The correct model is logical, not physical:
 *   • The menu's INLINE-START edge is aligned to the trigger's inline-start
 *     edge — that is the LEFT edge in LTR and the RIGHT edge in RTL.
 *   • The menu opens DOWNWARD (below the trigger) when it fits, otherwise it
 *     flips above.
 *   • Once placed, it is clamped inside the window with a margin, so a trigger
 *     near an edge can never push the menu off-screen.
 *
 * Everything here is a pure function of rects, so the RTL/LTR and collision
 * behaviour is unit-tested in plain Node (tests/rtlMenuPlacement.test.cjs)
 * instead of being asserted from source text.
 */

export type MenuDirection = 'ltr' | 'rtl';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowSize {
  width: number;
  height: number;
}

export interface MenuPlacementInput {
  /** Trigger rect in WINDOW coordinates (from `measureInWindow`). */
  anchor: Rect;
  /** Desired menu size; height may be 0 before the content is measured. */
  menuWidth: number;
  menuHeight: number;
  window: WindowSize;
  /** Effective layout direction of the app. */
  direction: MenuDirection;
  /** Space between the trigger and the menu. */
  gap?: number;
  /** Minimum distance the menu keeps from every window edge. */
  margin?: number;
}

export interface MenuPlacement {
  /** Absolute left in window coordinates. */
  left: number;
  /** Absolute top in window coordinates. */
  top: number;
  /** Final width (clamped to the available window width). */
  width: number;
  /** Max height so the menu scrolls instead of overflowing. */
  maxHeight: number;
  /** Which edge of the trigger the menu is aligned to (logical). */
  align: 'start' | 'end';
  /** True when the menu had to open above the trigger. */
  flipped: boolean;
  /** True when the preferred side did not fit and the opposite edge was used. */
  collided: boolean;
}

const DEFAULT_GAP = 6;
const DEFAULT_MARGIN = 8;

/** Which physical edge of the window the inline-start is on. */
export function inlineStartEdge(direction: MenuDirection): 'left' | 'right' {
  return direction === 'rtl' ? 'right' : 'left';
}

/**
 * Compute where an anchored menu must be drawn.
 *
 * Horizontal: align the menu's inline-start edge with the trigger's
 * inline-start edge (right/right in RTL, left/left in LTR). If that would push
 * the menu past the opposing window edge, the opposite alignment is used —
 * a deliberate, visible fallback rather than hiding the menu. Finally the
 * position is clamped so the menu is always fully inside the window.
 *
 * Vertical: below the trigger when it fits, otherwise above; clamped to the
 * window with `margin`, and capped in height so it never exceeds the space.
 */
export function computeMenuPlacement({
  anchor,
  menuWidth,
  menuHeight,
  window,
  direction,
  gap = DEFAULT_GAP,
  margin = DEFAULT_MARGIN,
}: MenuPlacementInput): MenuPlacement {
  const winW = Math.max(0, window.width);
  const winH = Math.max(0, window.height);

  // Never wider than the window (minus margins) — small phones / split view.
  const availableWidth = Math.max(0, winW - margin * 2);
  const width = Math.max(0, Math.min(menuWidth, availableWidth));

  // ── Horizontal ────────────────────────────────────────────────────────────
  const anchorStart = direction === 'rtl' ? anchor.x + anchor.width : anchor.x;
  const preferredLeft = direction === 'rtl' ? anchorStart - width : anchorStart;

  const minLeft = margin;
  const maxLeft = Math.max(minLeft, winW - margin - width);

  let left = preferredLeft;
  let align: 'start' | 'end' = 'start';
  let collided = false;

  if (preferredLeft < minLeft || preferredLeft > maxLeft) {
    // Align the other edge of the trigger to the opposite physical side.
    const oppositeLeft = direction === 'rtl' ? anchor.x : anchor.x + anchor.width - width;
    const clampedOpposite = Math.min(Math.max(oppositeLeft, minLeft), maxLeft);
    collided = true;
    align = 'end';
    left = clampedOpposite;
  }

  // Always inside the window, even when both alignments would overflow.
  left = Math.min(Math.max(left, minLeft), maxLeft);

  // ── Vertical ──────────────────────────────────────────────────────────────
  const spaceBelow = winH - (anchor.y + anchor.height) - margin;
  const spaceAbove = anchor.y - margin;
  const needed = menuHeight + gap;

  let flipped = false;
  let top: number;
  let maxHeight: number;

  if (needed <= spaceBelow || spaceBelow >= spaceAbove) {
    top = anchor.y + anchor.height + gap;
    maxHeight = spaceBelow;
  } else {
    flipped = true;
    maxHeight = spaceAbove;
    top = anchor.y - gap - Math.min(menuHeight, spaceAbove);
  }

  // Keep the whole menu inside the window.
  maxHeight = Math.max(0, maxHeight);
  const maxTop = Math.max(margin, winH - margin - Math.min(menuHeight || maxHeight, maxHeight));
  top = Math.min(Math.max(top, margin), maxTop);

  return { left, top, width, maxHeight, align, flipped, collided };
}

/** Convenience: the direction string for the current app locale. */
export function menuDirection(isRTL: boolean): MenuDirection {
  return isRTL ? 'rtl' : 'ltr';
}
