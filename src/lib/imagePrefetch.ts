/**
 * Course-image prefetch — fills the EXISTING expo-image disk cache with course
 * imagery as soon as course data arrives, so course cards render with their
 * images already warm instead of popping in after login.
 *
 * Design constraints:
 * - NO second cache: expo-image's own memory+disk cache remains the single
 *   source of truth. Prefetching simply populates it earlier — when the card
 *   renders, the <Image source={{uri}}/> cache lookup hits immediately.
 * - Never blocks anything: fire-and-forget from data-arrival points
 *   (loadData callbacks). Failures are swallowed — the card's existing
 *   placeholder fallback still applies on a genuine load failure.
 * - Stable keys: dedup happens on the exact URI string that will be rendered,
 *   so repeated loads of the same list never re-download.
 * - Platform: native only — on web the browser's HTTP cache already does this
 *   and Image.prefetch is a no-op there anyway.
 */

import { Image } from 'expo-image';
import { Platform } from 'react-native';

const inFlight = new Set<string>();
const warmed = new Set<string>();

/**
 * How many images a single data load may warm.
 *
 * WHY A CAP: the dashboard called this with EVERY published course right after
 * login. On a catalog of a few dozen courses that is a burst of large image
 * downloads competing for the same connection the list needs to render, so the
 * thumbnails the student is actually looking at arrived LAST — the reported
 * "course images take too long to appear after login". Warming only the first
 * screenful keeps the benefit (cards at the top are ready) without turning the
 * prefetch into a bandwidth hog. Everything else still loads on demand from
 * expo-image's disk cache, which is warm for the next visit.
 */
export const PREFETCH_LIMIT = 8;

/** Extract the image URL fields the course surfaces actually render. */
export function courseImageUrlsFrom(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const urls: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const u = (c.image_url ?? c.cover_url ?? c.thumbnail_url) as unknown;
    // Same fallback chain the cards use; only absolute http(s) URLs qualify.
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) urls.push(u);
  }
  return urls;
}

/**
 * Fire-and-forget prefetch of the given image URLs. Safe to call on every
 * data load: already-warmed URLs are skipped (no repeat downloads), an
 * in-flight URL is not started twice, and nothing is awaited.
 */
export function prefetchCourseImages(urls: string[], limit: number = PREFETCH_LIMIT): void {
  if (Platform.OS === 'web') return; // browser HTTP cache handles it
  const budget = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : PREFETCH_LIMIT;
  let started = 0;
  for (const uri of urls) {
    if (started >= budget) break;
    if (!uri || warmed.has(uri) || inFlight.has(uri)) continue;
    inFlight.add(uri);
    started++;
    void Image.prefetch(uri)
      .then(() => { warmed.add(uri); })
      .catch(() => { /* cache-full/dead URL → card placeholder still applies */ })
      .finally(() => { inFlight.delete(uri); });
  }
}

/** Test hook: reset dedup state (not used by app code). */
export function _resetPrefetchStateForTests(): void {
  inFlight.clear();
  warmed.clear();
}
