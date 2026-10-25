/**
 * drawerDirection.ts — PURE geometry for the side navigation drawer.
 *
 * ROOT CAUSE OF THE RTL DRAWER BUG
 * ─────────────
 * The hamburger button is the first child of a `flexDirection: 'row'` header, so
 * React Native moves it to the RIGHT edge as soon as the layout direction is
 * RTL — that part was already correct. The drawer itself was not: the panel was
 * pinned with physical `left: 0`, it slid in from `translateX: -DRAWER_WIDTH`,
 * its shadow pointed right (+8) and its backdrop covered `left: DRAWER_WIDTH`.
 * None of those are mirrored by `I18nManager`, because they are physical values,
 * so pressing the (now right-hand) button opened the panel on the LEFT edge of
 * the screen, sliding in from the wrong side.
 *
 * The fix is to derive every direction-dependent value from ONE model:
 *
 *   LTR — anchor left,  closed at -width, backdrop on the right, border right,
 *         shadow +x, forward chevron points right, active rule on the left.
 *   RTL — anchor right, closed at +width, backdrop on the left,  border left,
 *         shadow -x, forward chevron points left,  active rule on the right.
 *
 * Keeping this pure lets the whole matrix be unit-tested
 * (tests/navigationDrawerDirection.test.cjs) instead of being asserted from
 * JSX strings.
 */

export type DrawerSide = 'left' | 'right';

export interface DrawerDirectionModel {
  /** Physical edge the panel is pinned to. */
  side: DrawerSide;
  /** The opposite physical edge (where the backdrop lives). */
  oppositeSide: DrawerSide;
  /** Panel translateX when closed (off-screen on `side`). */
  closedOffset: number;
  /** Panel translateX when open. */
  openOffset: number;
  /** Edge that carries the panel's hairline border. */
  borderEdge: DrawerSide;
  /** Horizontal shadow direction: +1 rightwards, -1 leftwards. */
  shadowSign: 1 | -1;
  /** Where a "forward / enter" chevron must point in this direction. */
  forwardChevron: 'left' | 'right';
  /** Edge that carries the active-row indicator rule. */
  activeRuleEdge: DrawerSide;
  /** True for RTL — handy for callers that need one boolean. */
  isRTL: boolean;
  /**
   * Layout direction forced on the panel TRACK (see `panelTrackStyle`).
   * ALWAYS 'ltr' — the track is direction-NEUTRAL so the manual mirror below
   * is the only mirror. See the “DOUBLE REVERSAL” note on panelTrackStyle.
   */
  trackLayoutDirection: 'ltr';
  /**
   * Physical row order of the track for the app's own locale.
   *
   * LTR → 'row'         (main axis runs left→right, panel lands LEFT)
   * RTL → 'row-reverse' (main axis runs right→left, panel lands RIGHT)
   *
   * This is a PHYSICAL property (flexDirection is never flipped by the layout
   * direction), which is why it is used instead of `justifyContent` + Yoga's
   * `direction`.
   */
  trackFlexDirection: 'row' | 'row-reverse';
  /** The app locale's layout direction, applied to the PANEL itself. */
  panelDirection: 'ltr' | 'rtl';
}

/**
 * Build the drawer geometry for a direction and panel width.
 *
 * `width` is the resolved drawer width (290 on phones, 320 on tablets); every
 * offset is derived from it so a rotation or split-screen resize keeps the
 * closed state exactly off-screen.
 */
export function drawerDirection(isRTL: boolean, width: number): DrawerDirectionModel {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 0;

  if (isRTL) {
    return {
      side: 'right',
      oppositeSide: 'left',
      closedOffset: safeWidth, // pushed off the RIGHT edge
      openOffset: 0,
      borderEdge: 'left', // inner edge of a right-hand panel
      shadowSign: -1, // casts to the left, over the content
      forwardChevron: 'left',
      activeRuleEdge: 'right',
      isRTL: true,
      trackLayoutDirection: 'ltr',
      trackFlexDirection: 'row-reverse',
      panelDirection: 'rtl',
    };
  }

  return {
    side: 'left',
    oppositeSide: 'right',
    closedOffset: -safeWidth, // pushed off the LEFT edge
    openOffset: 0,
    borderEdge: 'right',
    shadowSign: 1,
    forwardChevron: 'right',
    activeRuleEdge: 'left',
    isRTL: false,
    trackLayoutDirection: 'ltr',
    trackFlexDirection: 'row',
    panelDirection: 'ltr',
  };
}

/**
 * The track that anchors the panel to the app locale's OWN edge.
 *
 * ── THE DOUBLE-REVERSAL BUG THIS REPLACED (iOS + Android) ───────────────────
 * The previous revision anchored the panel with
 *     direction: 'rtl' + justifyContent: 'flex-end'
 * on the theory that `flex-end` means "the right edge in RTL". It does not.
 * Yoga reverses the MAIN AXIS for `row` under RTL, so main-start is the RIGHT
 * edge and `flex-end` resolves to the **LEFT** one. In Arabic the panel was
 * therefore laid out on the left while its slide vector (`+width`, “closed to
 * the right”) still pointed right: the panel started ~290 px from the left,
 * animated leftwards and settled on the LEFT edge — the reported "opens on one
 * side and jumps to the other", which this time appeared on iPhone too.
 *
 * ── THE ONE RULE NOW ────────────────────────────────────────────────────────
 * `flexDirection` is PHYSICAL — Yoga never flips `row`/`row-reverse` because of
 * `direction`. So the mirror is expressed exactly once, physically:
 *     LTR → flexDirection: 'row'          → panel at the LEFT edge
 *     RTL → flexDirection: 'row-reverse'  → panel at the RIGHT edge
 *
 * The track's own `direction` is pinned to 'ltr' so the platform's I18nManager
 * state (which may still be LTR for one launch after the user switches to
 * Arabic) can NEVER apply a second, invisible reversal on top of this one.
 * The panel then re-declares the app locale's own direction, so its Arabic
 * content still lays out right-to-left.
 *
 * Result: the anchor and the slide vector are derived from the SAME model, so
 * they cannot disagree about which edge is home — on either platform, in
 * either language, before or after a native RTL relaunch.
 */
export function panelTrackStyle(model: DrawerDirectionModel): {
  flexDirection: 'row' | 'row-reverse';
  direction: 'ltr';
  justifyContent: 'flex-start';
  alignItems: 'stretch';
} {
  return {
    flexDirection: model.trackFlexDirection,
    direction: model.trackLayoutDirection,
    justifyContent: 'flex-start',
    alignItems: 'stretch',
  };
}


