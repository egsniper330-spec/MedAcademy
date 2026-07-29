/**
 * VdoCipherPlayer.tsx
 *
 * Thin router — selects the correct player adapter based on:
 *   1. Platform (web always uses WebView/iframe)
 *   2. USE_NATIVE_VDOCIPHER_PLAYER feature flag (native SDK vs WebView fallback)
 *
 * Public API is unchanged — lesson screens need no modifications.
 *
 * ── Adapter selection ───────────────────────────────────────────────────────
 *
 *   Web                            → VdoCipherPlayerWebView  (iframe + Reanimated overlay)
 *   Native + flag=true  (default)  → VdoCipherPlayerNativeAdapter  (vdocipher-rn-bridge)
 *   Native + flag=false (rollback) → VdoCipherPlayerWebView  (original WebView player)
 *
 * ── Rollback ────────────────────────────────────────────────────────────────
 *   Set USE_NATIVE_VDOCIPHER_PLAYER = false in src/lib/vdoPlayerFeatureFlag.ts
 *   to revert to the WebView player instantly without touching lesson screens.
 *
 * ── Platform file resolution ────────────────────────────────────────────────
 *   VdoCipherPlayerNativeAdapter.native.tsx  → bundled on Android / iOS
 *   VdoCipherPlayerNativeAdapter.tsx         → web stub (never rendered on web)
 *   Metro resolves .native.tsx first on native targets.
 */

import { USE_NATIVE_VDOCIPHER_PLAYER } from '@/lib/vdoPlayerFeatureFlag';
import { VdoCipherPlayerWebView } from '@/components/VdoCipherPlayerWebView';
import { VdoCipherPlayerNativeAdapter } from '@/components/VdoCipherPlayerNativeAdapter';

// ─── Public types (re-exported so adapters and callers share one definition) ──

export interface VdoCipherPlayerProps {
  videoId: string;
  lessonId: string;
  /** Student's WM-NNNN sequential watermark identifier */
  watermarkId?: string;
  /** Student display name for watermark (omit for ID-only / privacy mode) */
  watermarkName?: string;
  onReady?: () => void;
  /** currentTime and duration are in seconds */
  onProgress?: (currentTime: number, duration: number) => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function VdoCipherPlayer(props: VdoCipherPlayerProps) {
  // Web: always use WebView/iframe — native SDK is unavailable in browsers.
  if (process.env.EXPO_OS === 'web') {
    return <VdoCipherPlayerWebView {...props} />;
  }

  // Native: feature flag selects between SDK and WebView rollback.
  if (USE_NATIVE_VDOCIPHER_PLAYER) {
    return <VdoCipherPlayerNativeAdapter {...props} />;
  }

  return <VdoCipherPlayerWebView {...props} />;
}
