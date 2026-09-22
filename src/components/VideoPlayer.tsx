/**
 * VideoPlayer.tsx
 *
 * Provider router — selects the correct player based on the lesson's
 * video_type.  All lesson screens use <VideoPlayer> exclusively;
 * they never import VdoCipherPlayer or YouTubePlayer directly.
 *
 * ── Provider routing ────────────────────────────────────────────────────────
 *
 *   video_type = 'vdocipher'  →  VdoCipherPlayer
 *   video_type = 'youtube'    →  YouTubePlayer (Plyr)
 *
 * ── Adding a new provider ────────────────────────────────────────────────────
 *   1. Create `NewProvider.tsx` implementing VideoPlayerProps
 *   2. Add the new `video_type` value to the DB enum
 *   3. Add a `case` branch below — nothing else changes
 */

import { VdoCipherPlayer } from '@/components/VdoCipherPlayer';
import { YouTubePlayer, extractYouTubeVideoId } from '@/components/YouTubePlayer';

// ─── Shared props interface ───────────────────────────────────────────────────

export interface VideoPlayerProps {
  /** DB lesson.video_type — determines which player adapter is used */
  videoType: 'vdocipher' | 'youtube' | string;

  // ── VdoCipher-specific ────────────────────────────────────────────────────
  /** VdoCipher opaque video ID (required when videoType = 'vdocipher') */
  videoId?: string;
  /** Student WM-NNNN sequential watermark identifier */
  watermarkId?: string;
  /** Student display name for overlay watermark */
  watermarkName?: string;

  // ── YouTube-specific ──────────────────────────────────────────────────────
  /** 11-character YouTube video ID (required when videoType = 'youtube') */
  youtubeVideoId?: string;

  // ── Shared callbacks ──────────────────────────────────────────────────────
  lessonId: string;
  resumePosition?: number;
  onReady?: () => void;
  /** currentTime and duration in seconds */
  onProgress?: (currentTime: number, duration: number) => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
  /** Called when the player enters/exits fullscreen — used by the lesson screen
   *  to hide all non-video content for a YouTube-style fullscreen experience. */
  onFullscreen?: (active: boolean) => void;
  /**
   * SECURITY GATE (fullscreen boundary) — forwarded to the provider player.
   * Consulted before any fullscreen surface mounts; false/throw refuses.
   */
  shouldAllowFullscreen?: () => Promise<boolean> | boolean;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function VideoPlayer({
  videoType,
  videoId,
  watermarkId,
  watermarkName,
  youtubeVideoId,
  lessonId,
  resumePosition = 0,
  onReady,
  onProgress,
  onEnd,
  onError,
  onFullscreen,
  shouldAllowFullscreen,
}: VideoPlayerProps) {
  // youtubeVideoId must be a validated 11-char ID; garbage strings would only
  // render a YouTube "invalid parameter" error inside the embed.
  const validatedYoutubeId = extractYouTubeVideoId(youtubeVideoId ?? '');
  if (videoType === 'youtube' && validatedYoutubeId) {
    const ytWatermark =
      watermarkName && watermarkId
        ? { name: watermarkName, studentId: watermarkId }
        : undefined;
    return (
      <YouTubePlayer
        videoId={validatedYoutubeId}
        resumePosition={resumePosition}
        watermark={ytWatermark}
        onReady={onReady}
        onProgress={onProgress}
        onEnd={onEnd}
        onError={onError}
        onFullscreen={onFullscreen}
        shouldAllowFullscreen={shouldAllowFullscreen}
      />
    );
  }

  // Default / vdocipher — keeps all existing behavior unchanged
  if (videoType === 'vdocipher' && videoId) {
    return (
      <VdoCipherPlayer
        videoId={videoId}
        lessonId={lessonId}
        watermarkId={watermarkId}
        watermarkName={watermarkName}
        onReady={onReady}
        onProgress={(currentTime, duration) => onProgress?.(currentTime, duration)}
        onEnd={onEnd}
        onError={onError}
        shouldAllowFullscreen={shouldAllowFullscreen}
      />
    );
  }

  return null;
}
