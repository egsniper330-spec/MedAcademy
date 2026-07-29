/**
 * VdoCipherPlayerNativeAdapter.native.tsx
 *
 * Phase 1 — Native SDK adapter for Android and iOS.
 * Replaces the WebView player with VdoPlayerView from vdocipher-rn-bridge.
 *
 * Metro resolves this file in preference to VdoCipherPlayerNativeAdapter.tsx
 * on Android and iOS, while the bare .tsx stub is used on Web.
 *
 * ── Public API ──────────────────────────────────────────────────────────────
 * Identical to the original VdoCipherPlayer props — lesson screens require
 * no changes.
 *
 * ── Event mapping ───────────────────────────────────────────────────────────
 * VdoPlayerView event     → VdoCipherPlayerProps callback
 * ─────────────────────── ─────────────────────────────────────────────────
 * onLoaded                → onReady()
 * onProgress(ms)          → onProgress(currentTimeSec, durationSec)
 * onMediaEnded            → onEnd()
 * onLoadError             → onError(message)
 * onEnterFullscreen       → internal state (native SDK manages fullscreen UI)
 * onExitFullscreen        → internal state
 *
 * ── Unit conversion ─────────────────────────────────────────────────────────
 * The VdoCipher native SDK reports all times in milliseconds.
 * The existing public API (and lesson screen) expects seconds.
 * All times are divided by 1000 before being forwarded to callbacks.
 *
 * ── Duration tracking ───────────────────────────────────────────────────────
 * Duration is captured from mediaInfo.duration in the onLoaded event and
 * stored in a ref. Every subsequent onProgress tick forwards the cached
 * duration so callers always receive (currentTimeSec, durationSec).
 *
 * ── Watermark ───────────────────────────────────────────────────────────────
 * Phase 2 — NativeWatermarkOverlay is rendered as a sibling View above
 * VdoPlayerView.  It uses Reanimated to move a translucent pill across a
 * 9-slot grid every 12–20 s without any React re-renders.
 *
 * VdoCipher's own server-side watermark feature is NOT replaced by this
 * overlay; both can be active simultaneously.
 *
 * ── Fullscreen ──────────────────────────────────────────────────────────────
 * VdoPlayerView with showNativeControls=true handles fullscreen natively —
 * the user taps the fullscreen button in the native control bar.
 * No additional RN code is needed.
 *
 * ── Resume position ─────────────────────────────────────────────────────────
 * enableAutoResume=true is passed in EmbedInfo. This activates VdoCipher's
 * server-side resume feature (requires it to be enabled on the VdoCipher
 * dashboard). Client-side seek-to-position is a Phase 3 addition.
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import { View, Text, ActivityIndicator, useColorScheme } from 'react-native';
import { VdoPlayerView } from 'vdocipher-rn-bridge';
import { getVideoPlaybackToken } from '@/lib/api';
import { neuColors } from '@/lib/neu';
import type { VdoCipherPlayerProps } from '@/components/VdoCipherPlayer';
import { NativeWatermarkOverlay } from '@/components/NativeWatermarkOverlay';

// ─── Container style — matches the WebView player exactly ────────────────────
//
// position:'relative' + overflow:'hidden' are both required:
//   • position:'relative'  — makes this the containing block for the
//                            NativeWatermarkOverlay (position:'absolute')
//   • overflow:'hidden'    — clips the absolute overlay to the card's
//                            rounded-corner bounds in normal (non-fullscreen)
//                            mode, preventing the watermark pill from
//                            escaping into the surrounding scroll content
//
// Without these, the overlay's absolute position is resolved against the
// nearest ancestor that has position set, which may be the ScrollView or
// screen root — causing the watermark to appear outside or far below the
// player frame in normal mode, while fullscreen (which takes over the full
// system window) renders correctly because it has its own stacking context.

const containerStyle = {
  width:      '100%' as const,
  aspectRatio: 16 / 9,
  backgroundColor: '#000',
  position:   'relative' as const,
  overflow:   'hidden'   as const,
};

// ─── Component ────────────────────────────────────────────────────────────────

export function VdoCipherPlayerNativeAdapter({
  videoId,
  lessonId,
  watermarkId,
  watermarkName,
  onReady,
  onProgress,
  onEnd,
  onError,
}: VdoCipherPlayerProps) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const [otp, setOtp]               = useState<string | null>(null);
  const [playbackInfo, setPlaybackInfo] = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);

  // Duration captured from onLoaded → forwarded on every onProgress tick.
  const durationSecRef = useRef(0);

  // ── Fetch OTP on mount (identical flow to WebView player) ────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setOtp(null);
    setPlaybackInfo(null);
    durationSecRef.current = 0;

    (async () => {
      try {
        const result = await getVideoPlaybackToken(videoId, lessonId);
        if (!cancelled) {
          setOtp(result.otp);
          setPlaybackInfo(result.playbackInfo);
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          const msg = err?.message ?? 'Unable to load video. Please try again.';
          setError(msg);
          setLoading(false);
          onError?.(msg);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [videoId, lessonId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Event handlers ────────────────────────────────────────────────────────

  // onLoaded fires when the media is ready to play.
  // mediaInfo.duration is in milliseconds.
  const handleLoaded = useCallback((event: any) => {
    const durationMs = event?.mediaInfo?.duration ?? 0;
    durationSecRef.current = durationMs / 1000;
    onReady?.();
  }, [onReady]);

  // onProgress fires roughly every second.
  // event.currentTime is in milliseconds.
  const handleProgress = useCallback((event: any) => {
    const currentTimeSec = (event?.currentTime ?? 0) / 1000;
    onProgress?.(currentTimeSec, durationSecRef.current);
  }, [onProgress]);

  // onMediaEnded fires when playback reaches the end.
  const handleMediaEnded = useCallback((_event: any) => {
    onEnd?.();
  }, [onEnd]);

  // onLoadError fires when the SDK fails to load the media.
  const handleLoadError = useCallback((event: any) => {
    const msg =
      event?.errorDescription?.errorMsg ??
      `Playback error (code: ${event?.errorDescription?.errorCode ?? 'unknown'})`;
    setError(msg);
    onError?.(msg);
  }, [onError]);

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={[containerStyle, { alignItems: 'center', justifyContent: 'center', gap: 10 }]}>
        <ActivityIndicator color={c.primary} size="large" />
        <Text style={{ fontSize: 13, color: c.text, opacity: 0.5 }}>Loading player…</Text>
      </View>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (error || !otp || !playbackInfo) {
    return (
      <View style={[containerStyle, {
        backgroundColor: '#0A0A0A',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
        gap: 8,
      }]}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff', textAlign: 'center' }}>
          Video Unavailable
        </Text>
        <Text style={{ fontSize: 12, color: '#ffffff88', textAlign: 'center', lineHeight: 18 }}>
          {error ?? 'Could not load the player. Please check your connection.'}
        </Text>
      </View>
    );
  }

  // ── Native SDK player ─────────────────────────────────────────────────────
  //
  // embedInfo.enableAutoResume=true activates VdoCipher's server-side resume
  // feature so the SDK automatically seeks to the last saved position on load.
  // (Requires the feature to be enabled in the VdoCipher dashboard settings.)
  //
  // showNativeControls=true renders VdoCipher's built-in control bar including
  // play/pause, seek bar, quality selector, and fullscreen button.
  //
  // autoPlay=true mirrors the original WebView behaviour where playback starts
  // immediately after the player is ready.

  return (
    <View style={containerStyle}>
      <VdoPlayerView
        embedInfo={{
          otp,
          playbackInfo,
          enableAutoResume: true,
        }}
        showNativeControls
        autoPlay
        style={{ flex: 1 }}
        onLoaded={handleLoaded}
        onProgress={handleProgress}
        onMediaEnded={handleMediaEnded}
        onLoadError={handleLoadError}
      />
      {/* Phase 2 — application-level watermark overlay.
          Rendered AFTER VdoPlayerView in the tree so it paints above it.
          pointerEvents="none" is enforced inside NativeWatermarkOverlay.
          VdoCipher's server-side watermark (embedInfo) remains unaffected.
          Requires watermarkId; watermarkName is optional (ID-only mode if absent). */}
      {!!watermarkId && (
        <NativeWatermarkOverlay
          watermarkId={watermarkId}
          watermarkName={watermarkName}
        />
      )}
    </View>
  );
}
