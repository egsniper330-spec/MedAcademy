/**
 * +native-intent.ts — expo-router native linking hook
 *
 * Called by expo-router on every incoming URL before route matching.
 * Normalizes scheme-only cold-start URLs (medacademy:///, medacademy://)
 * to "/" so the root index route is always matched on first launch.
 *
 * Without this, Linking.createURL('/') on Android produces "medacademy:///"
 * which extractPathFromURL strips to "" (empty string), causing:
 *   "Unmatched Route — medacademy:///"
 */
export function redirectSystemPath({
  path,
  initial,
}: {
  path: string;
  initial: boolean;
}): string {
  // On cold start (initial=true), an empty or bare "/" path means the app
  // was launched from the home screen with no deep-link target.
  // Return "/" to ensure the root index screen is matched.
  if (initial && (path === '' || path === '/')) {
    return '/';
  }
  return path;
}
