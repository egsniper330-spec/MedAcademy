/**
 * headerTokens.ts — Single source of truth for header spacing.
 *
 * All header components (PageHeader, DashboardHeader) and every
 * inline header MUST import these constants — never define local ones.
 *
 * Design rationale (matches Google, Telegram, Notion, Discord, Instagram):
 *  • EDGE_PAD: distance between the safe-area edge and the button container.
 *    4dp is the professional standard — button feels "attached" to the margin.
 *  • BUTTON_SIZE: 40×40dp touch target (visual), 8dp hitSlop = 56dp touch = ≥44pt HIG minimum.
 *  • BUTTON_ICON: 22dp — slightly larger than 20dp for better legibility at all DPI.
 *  • TITLE_GAP: gap between button right edge and title left edge. 10dp tight, consistent.
 *  • BREATHING: gap between OS status-bar inset and first pixel of header content. 8dp.
 *  • BOTTOM_PAD: visual space below header content before page body starts.
 *  • LANDSCAPE_EXTRA: additional left padding in landscape to clear side notch.
 *  • TABLET_LEFT_PAD: left pad on tablet (768+dp short side). Generous but not wasteful.
 */

/** dp from safe-area LEFT edge to button container's LEFT edge */
export const HEADER_EDGE_PAD = 4;

/** Minimum left padding floor (applies when insets.left is 0) */
export const HEADER_MIN_LEFT_PAD = 8;

/** dp from safe-area RIGHT edge to right content's RIGHT edge */
export const HEADER_RIGHT_PAD = 12;

/** Breathing room between OS status bar bottom and header content top */
export const HEADER_BREATHING = 8;

/** Minimum total top padding (floor for Web / simulator with insets=0) */
export const HEADER_TOP_MIN = 24;

/** Visual padding below header content row, before page body */
export const HEADER_BOTTOM_PAD = 12;

/** Button container: width = height */
export const HEADER_BTN_SIZE = 40;

/** Button corner radius */
export const HEADER_BTN_RADIUS = 12;

/** Icon size inside button */
export const HEADER_ICON_SIZE = 22;

/** Gap between button right edge and title left edge */
export const HEADER_TITLE_GAP = 10;

/** Gap between title right edge and right actions */
export const HEADER_RIGHT_GAP = 8;

/** Title font size (phone) */
export const HEADER_TITLE_FONT = 20;

/** Title font size (tablet) */
export const HEADER_TITLE_FONT_TABLET = 22;

/** Title line height (phone) */
export const HEADER_TITLE_LINE_H = 26;

/** Title line height (tablet) */
export const HEADER_TITLE_LINE_H_TABLET = 30;

/** Tablet left padding (overrides formula on wide screens) */
export const HEADER_TABLET_LEFT_PAD = 16;
