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
   * Layout direction to force on the panel TRACK (see `panelTrackStyle`).
   * Forcing it makes the anchor independent of the platform's RTL state.
   */
  layoutDirection: 'ltr' | 'rtl';
  /** Row justification that puts the panel on the inline-start edge. */
  justify: 'flex-start' | 'flex-end';
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
      layoutDirection: 'rtl',
      justify: 'flex-end',
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
    layoutDirection: 'ltr',
    justify: 'flex-start',
  };
}

/**
 * The track that anchors the panel to the inline-start edge.
 *
 * ── WHY NOT `left`/`right` (THE ANDROID BUG THIS REPLACED)
 * The panel used to be pinned with a physical `left: 0` (LTR) / `right: 0`
 * (RTL) plus a `translateX` slide. Those two axes disagree under Android's
 * RTL layout direction: which of `left`/`right` wins for an absolutely
 * positioned view has changed across React Native / Yoga releases (Yoga 1
 * resolved them against the writing direction, later Yoga resolves them
 * physically), so on Android a `right: 0` panel could be laid out on the LEFT
 * edge while the slide offset still moved it rightwards — the reported
 * "opens from the right, settles on the left".
 *
 * Flexbox has no such ambiguity, and the direction here is FORCED from the app
 * locale, so the anchor cannot depend on the platform's own RTL flag:
 *   LTR → direction:ltr + flex-start → the panel's left edge is the screen's
 *         left edge.
 *   RTL → direction:rtl + flex-end   → the panel's right edge is the screen's
 *         right edge.
 * The slide (`translateX`) then travels along the same axis in both cases, so
 * the open and closed positions can never disagree about which side is home.
 */
export function panelTrackStyle(model: DrawerDirectionModel): {
  flexDirection: 'row';
  direction: 'ltr' | 'rtl';
  justifyContent: 'flex-start' | 'flex-end';
  alignItems: 'stretch';
} {
  return {
    flexDirection: 'row',
    direction: model.layoutDirection,
    justifyContent: model.justify,
    alignItems: 'stretch',
  };
}


