/**
 * OfflineVideoPlayer.types.ts — shared props for the offline player adapters.
 *
 * One definition for the .native.tsx adapter (Android/iOS) and the web stub
 * (.tsx), so callers never branch on platform for types.
 */

import type { OfflineVideoEntry } from '@/lib/offlineVideoService';

export interface OfflineVideoPlayerProps {
  entry: OfflineVideoEntry;
  /** SECURITY GATE — same contract as VdoCipherPlayerProps.shouldAllowFullscreen. */
  shouldAllowPlayback?: () => Promise<boolean> | boolean;
  /**
   * Application watermark identity — the viewer's PUBLIC MED-#### identifier
   * (legacy WM id fallback), matching the online player's product rule. When
   * omitted the overlay renders in ID-only mode with the DRM-internal owner
   * binding (never the raw DB user id).
   */
  watermarkId?: string;
  /** Viewer display name for the overlay (optional — ID-only if absent). */
  watermarkName?: string;
  onClose?: () => void;
}
