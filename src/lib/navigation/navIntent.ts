/**
 * navIntent — "how was this screen entered?", resolved into ONE header control.
 *
 * THE PROBLEM
 * ───────────
 * Every screen rendered its own guess: many hub/list screens hardcoded the
 * hamburger (fine when the drawer opened them, wrong when a dashboard quick
 * action did), nested screens hardcoded Back, and a few had no control at all.
 * A single global boolean cannot express this — the SAME route can legitimately
 * be reached from the drawer (menu expected) or from a quick action (Back
 * expected).
 *
 * THE MODEL
 * ─────────
 *  • The navigation that STARTED a transition records its intent for the TARGET
 *    path: 'main' (drawer / tab bar) or 'nested' (quick action, card, internal
 *    link).
 *  • The destination consumes that intent once, on focus (short TTL so a stale
 *    mark can never leak into a later visit).
 *  • No intent (deep link, notification, cold start, restored session, browser
 *    refresh) → fall back to the route's ROLE classification, then to real
 *    navigation history, and only then to the safe menu control.
 *
 * This module is dependency-free on purpose: the resolver is unit-tested in
 * plain Node (tests/contextualBackNavigation.test.cjs).
 */

export type EntryIntent = 'main' | 'nested';
export type HeaderControl = 'menu' | 'back';

export interface ResolveHeaderInput {
  /** Explicit override from the screen (rarely needed). */
  explicitMode?: HeaderControl | null;
  /** Legacy prop: true = a stack screen that always shows Back. */
  showBack?: boolean;
  /** Intent recorded by the navigation that opened this screen, if any. */
  intent: EntryIntent | null;
  /** True when the route is a primary drawer/tab destination for the role. */
  isRootDestination: boolean;
  /** router.canGoBack() — real, usable in-app history. */
  canGoBack: boolean;
  /** A role-appropriate dashboard/parent route is available as a fallback. */
  hasFallback: boolean;
  /** True when the screen sits inside a DrawerProvider (a menu can open). */
  insideDrawer: boolean;
}

export interface ResolveHeaderResult {
  control: HeaderControl;
  /** Back needs to synthesise the destination instead of popping history. */
  useFallback: boolean;
}

/**
 * Resolution order (first match wins):
 *   1. explicit override
 *   2. showBack (explicit nested intent)
 *   3. recorded 'main' intent      → menu
 *   4. recorded 'nested' intent    → back
 *   5. root destination            → menu
 *   6. usable in-app history       → back
 *   7. menu (safe default)
 * A Back that could not go anywhere is degraded to menu unless a fallback route
 * exists; and a menu with no drawer on the screen degrades to Back when history
 * exists, so a stack screen is never left without any control.
 */
export function resolveHeaderControl(input: ResolveHeaderInput): ResolveHeaderResult {
  const {
    explicitMode = null,
    showBack = false,
    intent = null,
    isRootDestination = false,
    canGoBack = false,
    hasFallback = false,
    insideDrawer = true,
  } = input;

  const wantsBack = (): ResolveHeaderResult => {
    if (canGoBack) return { control: 'back', useFallback: false };
    if (hasFallback) return { control: 'back', useFallback: true };
    return { control: insideDrawer ? 'menu' : 'back', useFallback: false };
  };

  if (explicitMode === 'menu') {
    // A menu the screen cannot render is worse than Back.
    if (!insideDrawer && canGoBack) return { control: 'back', useFallback: false };
    return { control: 'menu', useFallback: false };
  }
  if (explicitMode === 'back') return wantsBack();
  if (showBack) return wantsBack();

  if (intent === 'main') {
    if (!insideDrawer && canGoBack) return { control: 'back', useFallback: false };
    return { control: 'menu', useFallback: false };
  }
  if (intent === 'nested') return wantsBack();

  if (isRootDestination) {
    if (!insideDrawer && canGoBack) return { control: 'back', useFallback: false };
    return { control: 'menu', useFallback: false };
  }

  // Not a main destination and no recorded intent: this is a deep link, a
  // restored session or a browser refresh on a nested screen. Real history
  // wins; otherwise synthesise the role/parent route instead of leaving the
  // user on a dead menu.
  if (canGoBack) return { control: 'back', useFallback: false };
  if (hasFallback) return { control: 'back', useFallback: true };
  return { control: insideDrawer ? 'menu' : 'back', useFallback: false };
}

/* ── Entry-intent store ───────────────────────────────────────────────────── */

/** Marks older than this are never consumed — a stale mark cannot leak. */
export const INTENT_TTL_MS = 15_000;
const MAX_ENTRIES = 40;

interface Entry {
  intent: EntryIntent;
  at: number;
}

const entries = new Map<string, Entry>();

/**
 * Canonical key for a route: query/hash dropped, group segments `(app)`/
 * `(doctor)` removed, trailing slash removed, lower-cased.
 */
export function normalizeRoutePath(path: string | null | undefined): string {
  if (!path) return '';
  let p = String(path).split('?')[0].split('#')[0];
  p = p.replace(/\/\([^)]+\)/g, '');
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+$/, '');
  return (p === '' ? '/' : p).toLowerCase();
}

function prune(now: number): void {
  for (const [key, entry] of entries) {
    if (now - entry.at > INTENT_TTL_MS) entries.delete(key);
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** Record how the next screen at `path` is being entered. */
export function markEntryIntent(path: string, intent: EntryIntent): void {
  const key = normalizeRoutePath(path);
  if (!key) return;
  const now = Date.now();
  prune(now);
  entries.set(key, { intent, at: now });
}

/** Read without consuming (diagnostics/tests). */
export function peekEntryIntent(path: string): EntryIntent | null {
  const key = normalizeRoutePath(path);
  const found = entries.get(key);
  if (!found) return null;
  if (Date.now() - found.at > INTENT_TTL_MS) {
    entries.delete(key);
    return null;
  }
  return found.intent;
}

/** Read once, on focus. Returns null for a stale or absent mark. */
export function consumeEntryIntent(path: string): EntryIntent | null {
  const key = normalizeRoutePath(path);
  const found = entries.get(key);
  if (!found) return null;
  entries.delete(key);
  if (Date.now() - found.at > INTENT_TTL_MS) return null;
  return found.intent;
}

/** Clears every mark (sign-out, tests). */
export function clearEntryIntents(): void {
  entries.clear();
}
