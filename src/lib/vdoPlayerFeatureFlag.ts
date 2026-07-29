/**
 * vdoPlayerFeatureFlag.ts
 *
 * Phase 1 migration toggle.
 *
 * When true  → VdoPlayerView (vdocipher-rn-bridge native SDK) on Android/iOS
 * When false → WebView-based player (original implementation) on Android/iOS
 *
 * Web always uses the WebView/iframe path regardless of this flag —
 * the native SDK is not available in a browser environment.
 *
 * Set to false for an instant rollback to the WebView player.
 */
export const USE_NATIVE_VDOCIPHER_PLAYER = true;
