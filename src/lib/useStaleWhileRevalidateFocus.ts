/**
 * useStaleWhileRevalidateFocus — the "stop blanking the screen on every
 * focus" loader.
 *
 * THE PROBLEM IT SOLVES
 * ─────────────────────
 * 36 screens do this:
 *
 *     useFocusEffect(useCallback(() => { setLoading(true); loadData(); }, [loadData]));
 *
 * with a render like `{loading ? <Spinner/> : <content/>}`. Every return from
 * any pushed screen, every modal close, every tab change therefore:
 *
 *   1. unmounts the content the user was just reading,
 *   2. replaces it with a full-screen spinner, and
 *   3. waits for the whole request batch to finish before showing anything.
 *
 * That is the "tapping controls triggers visible loading delays" symptom. The
 * data is usually identical to what was already on screen — it was fetched
 * seconds ago and simply discarded.
 *
 * THE FIX
 * ───────
 *   • First entry, or nothing to show yet → behave exactly as before: raise the
 *     full-screen spinner so the screen is never an unexplained blank.
 *   • Later entries with content on screen → refresh in the BACKGROUND. The
 *     existing content stays mounted and interactive; no spinner, no flicker,
 *     no lost scroll position.
 *
 * CORRECTNESS GUARANTEES
 * ──────────────────────
 *  • It never suppresses the spinner when there is genuinely nothing to show,
 *    so an empty/failed first load still presents the loading state rather
 *    than a misleading empty page.
 *  • It never caches or reorders responses — `load()` is called exactly as
 *    before, so API semantics, progress writes and error handling are
 *    untouched.
 *  • It renders nothing and holds no data; it only sequences the spinner flag.
 *
 * NOT A CACHE: this hook deliberately keeps no response data. Caching (and the
 * account-scoping/invalidation rules that go with it) is a separate concern;
 * here the request still runs every time, it just stops blanking the UI.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useFocusEffect } from 'expo-router';

export interface StaleWhileRevalidateFocusOptions {
  /** Screen's loading setter — the same one its `{loading ? …}` render uses. */
  setLoading: (value: boolean) => void;
  /**
   * Returns true when the screen currently has usable content to show.
   * When this is false the hook falls back to the full-screen spinner, so a
   * page never hides its only indicator while still empty.
   */
  hasContent: () => boolean;
}

/**
 * Run `load` on every focus without discarding content already on screen.
 *
 * @param load the screen's existing loader (same reference semantics as before).
 */
export function useStaleWhileRevalidateFocus(
  load: () => Promise<void>,
  { setLoading, hasContent }: StaleWhileRevalidateFocusOptions,
): void {
  // Read the latest callbacks through refs so the focus subscription keeps a
  // stable identity (screens pass inline arrows / changing closures).
  const loadRef = useRef(load);
  const setLoadingRef = useRef(setLoading);
  const hasContentRef = useRef(hasContent);

  useEffect(() => {
    loadRef.current = load;
    setLoadingRef.current = setLoading;
    hasContentRef.current = hasContent;
  });

  // True once a load has completed while content was visible — i.e. we know
  // the screen has something to fall back to.
  const revalidatedRef = useRef(false);

  /**
   * CONCURRENCY GUARD — not a cache.
   *
   * Focus can fire more than once for one visit (nested navigators remount,
   * a modal closes while the screen regains focus, a fast back-and-forward).
   * Without a guard each event starts ANOTHER identical request batch, so the
   * slowest response wins and the server sees duplicate reads for one visit —
   * a direct contributor to "navigating around keeps reloading".
   *
   * A new load is skipped only while one is still running; the running load's
   * own result is what renders, and the next focus (after it settles) fetches
   * normally. No response is ever cached or reordered.
   */
  const inFlightRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      const showContent = revalidatedRef.current && hasContentRef.current();

      if (inFlightRef.current) {
        // A request batch for this screen is already running: let it land.
        // (Nothing to clean up — this focus did not start work.)
        return () => {};
      }

      if (!showContent) {
        // Nothing proven on screen yet → old behaviour (full-screen spinner).
        setLoadingRef.current(true);
      }

      let cancelled = false;
      inFlightRef.current = true;
      void loadRef.current().then(
        () => {
          if (cancelled) return;
          // Retire the spinner only once we know content exists; an empty or
          // failed first load keeps the guard disarmed so the next focus
          // presents the loading state again instead of a bare empty page.
          if (hasContentRef.current()) revalidatedRef.current = true;
        },
        () => {
          /* load() implementations handle their own errors; never throw here. */
        },
      ).finally(() => {
        inFlightRef.current = false;
      });

      // useFocusEffect cleanup: if the screen loses focus mid-flight we must
      // not flip loading state on an unmounted/de-focused screen.
      return () => {
        cancelled = true;
      };
    }, []),
  );
}

export default useStaleWhileRevalidateFocus;
