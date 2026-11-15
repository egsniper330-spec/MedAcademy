/**
 * VideoPlayer.tsx
 *
 * Provider router for lesson video. YouTube is the ONLY supported provider.
 *
 * ── Why the VdoCipher branch is gone ────────────────────────────────────────
 * VdoCipher was retired as an active provider: its player, SDK, OTP and
 * playback-token flows are no longer part of the app. Lessons created before the
 * retirement still carry `video_type = 'vdocipher'`, and they are NOT rewritten or
 * deleted — this router simply renders an explicit "video unavailable" panel for
 * them instead of a broken player, which is exactly how an out-of-service provider
 * must behave. Content owners can supply a YouTube replacement.
 *
 * ── Adding a new provider ───────────────────────────────────────────────────
 *   1. Create `NewProvider.tsx` implementing VideoPlayerProps
 *   2. Add the new `video_type` value to the DB enum
 *   3. Add a `case` branch below — nothing else changes
 */

import { StyleSheet, Text, View, useColorScheme } from 'react-native';
import { VideoOff } from 'lucide-react-native';
import { YouTubePlayer, extractYouTubeVideoId } from '@/components/YouTubePlayer';
import { useTranslation } from '@/lib/i18n';
import { neuColors, mutedTextStyle } from '@/lib/neu';

// ─── Shared props interface ───────────────────────────────────────────────────

export interface VideoPlayerProps {
  /** DB lesson.video_type — determines which player adapter is used */
  videoType: 'vdocipher' | 'youtube' | string;

  // ── Legacy VdoCipher fields — kept only so old callers still type-check ────
  /** Legacy VdoCipher opaque video ID (no longer used to play anything) */
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
   * Consulted before any fullscreen expansion; false/throw refuses.
   */
  shouldAllowFullscreen?: () => Promise<boolean> | boolean;
  /**
   * LIVE VERDICT (synchronous) — forwarded to the provider player so fullscreen
   * entry is immediate; the gate above re-validates in parallel and a denial
   * collapses fullscreen. Same contract as YouTubePlayerProps.fullscreenVerdictNow.
   */
  fullscreenVerdictNow?: () => boolean;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function VideoPlayer({
  videoType,
  watermarkId,
  watermarkName,
  youtubeVideoId,
  resumePosition = 0,
  onReady,
  onProgress,
  onEnd,
  onError,
  onFullscreen,
  shouldAllowFullscreen,
  fullscreenVerdictNow,
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
        fullscreenVerdictNow={fullscreenVerdictNow}
      />
    );
  }

  // Any other provider (including every legacy `vdocipher` lesson) is unavailable.
  return <UnavailableVideoPlayer videoType={videoType} />;
}

/**
 * Out-of-service provider panel.
 *
 * Deliberately NOT a silent `null`: a blank area reads as a loading failure, and the
 * student would keep waiting. It states the fact and does not touch the lesson record.
 */
function UnavailableVideoPlayer({ videoType }: { videoType: string }) {
  const scheme = useColorScheme();
  const c = scheme === 'dark' ? neuColors.dark : neuColors.light;
  const { t } = useTranslation();

  return (
    <View style={[styles.wrap, { backgroundColor: c.base, borderColor: c.border }]}>
      <VideoOff size={28} color={c.primary} opacity={0.7} />
      <Text style={[styles.title, { color: c.text }]}>{t('video.unavailableTitle')}</Text>
      <Text style={[styles.body, mutedTextStyle(c, 0.7)]}>
        {videoType === 'vdocipher' ? t('video.unavailableLegacy') : t('video.unavailableBody')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    gap: 8,
  },
  title: { fontSize: 15, fontWeight: '800', textAlign: 'center' },
  body: { fontSize: 12.5, textAlign: 'center', lineHeight: 18 },
});
