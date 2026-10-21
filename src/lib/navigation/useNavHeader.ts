/**
 * useNavHeader — the ONE source of truth for a screen's header navigation
 * control (hamburger vs Back) and for what Back does.
 *
 * Inputs, in order of authority:
 *   1. an explicit prop from the screen (`navMode` / legacy `showBack`);
 *   2. the entry intent recorded by the drawer, the tab bar, a quick action or
 *      an internal link for THIS path (consumed once, short TTL);
 *   3. the role's root-route classification when nobody recorded an intent
 *      (deep link, notification, cold start, browser refresh, restored session);
 *   4. real in-app history (`router.canGoBack()`), then the role dashboard as a
 *      safe synthesised destination.
 *
 * Back never fires into nothing: when there is no history the hook pushes the
 * role dashboard (or a screen-provided parent) instead, and both go through
 * `router.push`, which cannot land on an unmatched route.
 */
import { useCallback, useRef, useState } from 'react';
import { useFocusEffect, usePathname, useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import { useProfileStore } from '@/lib/store';
import {
  consumeEntryIntent,
  peekEntryIntent,
  resolveHeaderControl,
  normalizeRoutePath,
  type HeaderControl,
} from '@/lib/navigation/navIntent';
import { dashboardFallback, isRootDestination } from '@/lib/navigation/rootRoutes';

export interface UseNavHeaderOptions {
  /** Legacy explicit Back (stack-pushed screens). */
  showBack?: boolean;
  /** Explicit override; wins over every heuristic. */
  navMode?: HeaderControl;
  /** Screen-specific parent route used when there is no history. */
  fallback?: string;
  /** True when the screen sits under a DrawerProvider (a menu can open). */
  insideDrawer: boolean;
  /** Screen-supplied Back implementation. */
  onBack?: () => void;
}

export interface NavHeaderState {
  control: HeaderControl;
  useFallback: boolean;
}

export function useNavHeader(options: UseNavHeaderOptions): {
  control: HeaderControl;
  handleBack: () => void;
} {
  const { showBack, navMode, fallback, insideDrawer, onBack } = options;
  const pathname = usePathname();
  const router = useRouter();
  const { profile } = useProfileStore();
  const role = profile?.role ?? null;

  const roleFallback = fallback ?? dashboardFallback(role);
  const hasFallback = !!roleFallback
    && normalizeRoutePath(roleFallback) !== normalizeRoutePath(pathname);

  const compute = useCallback(
    (intent: ReturnType<typeof peekEntryIntent>): NavHeaderState => {
      const result = resolveHeaderControl({
        explicitMode: navMode ?? null,
        showBack,
        intent,
        isRootDestination: isRootDestination(role, pathname),
        canGoBack: router.canGoBack(),
        hasFallback,
        insideDrawer,
      });
      return result;
    },
    [navMode, showBack, role, pathname, hasFallback, insideDrawer, router],
  );

  // Initial value uses a non-destructive peek so the first paint already shows
  // the right control (the focus effect below consumes the same mark).
  const [state, setState] = useState<NavHeaderState>(() => compute(peekEntryIntent(pathname)));

  useFocusEffect(
    useCallback(() => {
      // Consume once, on focus — a mark can never leak into a later visit.
      setState(compute(consumeEntryIntent(pathname)));
    }, [compute, pathname]),
  );

  // Guard against a stale closure firing Back twice (double-tap / rapid gesture).
  const backLock = useRef(false);

  const handleBack = useCallback(() => {
    if (onBack) {
      onBack();
      return;
    }
    if (backLock.current) return;
    backLock.current = true;
    setTimeout(() => { backLock.current = false; }, 400);

    if (router.canGoBack()) {
      router.back();
      return;
    }
    if (roleFallback && normalizeRoutePath(roleFallback) !== normalizeRoutePath(pathname)) {
      router.push(roleFallback as RelativePathString);
    }
  }, [onBack, router, roleFallback, pathname]);

  return { control: state.control, handleBack };
}
