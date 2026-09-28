/**
 * VdoCipherPlayerNativeAdapter.native.tsx
 *
 * Native SDK adapter for Android and iOS — ONE VdoPlayerView for the whole
 * watch session.
 *
 * Metro resolves this file in preference to VdoCipherPlayerNativeAdapter.tsx
 * on Android and iOS, while the bare .tsx stub is used on Web.
 *
 * ── Public API ──────────────────────────────────────────────────────────────
 * Identical to the original VdoCipherPlayer props — lesson screens require
 * no changes (onFullscreen is now actually forwarded).
 *
 * ── FULLSCREEN + ROTATION (root-cause architecture) ─────────────────────────
 * Fullscreen is IN-PLACE expansion of the SAME VdoPlayerView inside the SAME
 * activity/window — NOT a Modal. The previous Modal created a SECOND native
 * window (Dialog) hosting a SECOND VdoPlayerView: on rotation that window's
 * surface was destroyed/recreated around a still-running decoder → black
 * video with live audio (VdoCipher error 6120 territory; the docs
 * specifically warn that >1 VdoPlayer instance makes renderer errors far
 * more common). In-place expansion has no second window and no second
 * player: MainActivity's manifest configChanges
 * (orientation|screenSize|screenLayout|…) keeps the activity alive, RN
 * re-measures the container, and the SDK resizes its own surface within it.
 * ONE player instance → no remount, no seek/state restoration between
 * inline ↔ fullscreen (position is continuous by construction), no surface
 * teardown, no duplicate DRM session, and audio/video can never
 * desynchronize across rotation.
 *
 * Orientation is locked LANDSCAPE while fullscreen, PORTRAIT_UP otherwise —
 * synchronized in one useEffect keyed on isFullscreen. app.json keeps the
 * app portrait at all other times.
 *
 * ── Fullscreen entry per platform ───────────────────────────────────────────
 * • Android: the SDK's native control bar provides the fullscreen button;
 *   tapping it fires onEnterFullscreen → we expand the same instance.
 *   The SDK's exit control fires onExitFullscreen → we collapse.
 * • iOS: the SDK does NOT surface a fullscreen control in the native bridge
 *   (verified on device — no button renders), so an APP-LEVEL expand button
 *   (top-right, ≥44 pt) is rendered over the player. It runs the same
 *   security gate and expands the same instance. A back-arrow control
 *   (both platforms, in fullscreen) and Android hardware back collapse it.
 *
 * ── Security ────────────────────────────────────────────────────────────────
 * Fullscreen entry re-validates the authoritative SecurityContext verdict
 * (shouldAllowFullscreen — fail-closed). While fullscreen, a NEW violation
 * re-closes it via the live-gate mirror below. Screen capture protection
 * (app-shell FLAG_SECURE lock) is untouched; the watermark overlay lives
 * INSIDE the expanding container so it is visible in both modes.
 *
 * ── Event mapping ───────────────────────────────────────────────────────────
 * onLoaded → onReady(); onProgress(ms) → onProgress(sec, dur); onMediaEnded →
 * onEnd(); onLoadError → onError(message).
 */

import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { BackHandler, Platform, Pressable, StatusBar, Text, View, ActivityIndicator, useColorScheme } from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import { ArrowLeft, Maximize2 } from 'lucide-react-native';
import { VdoPlayerView } from 'vdocipher-rn-bridge';
import { getVideoPlaybackToken } from '@/lib/api';
import { neuColors } from '@/lib/neu';
import type { VdoCipherPlayerProps } from '@/components/VdoCipherPlayer';
import { NativeWatermarkOverlay } from '@/components/NativeWatermarkOverlay';
import { resolveWatermarkIdentity } from '@/lib/watermarkIdentity';
import {
  enterFullscreenSystemUi,
  exitFullscreenSystemUi,
} from '@/lib/fullscreenSystemUi';

// ─── Container styles ─────────────────────────────────────────────────────────
//
// INLINE (normal): 16:9 block in the page flow.
//   • position:'relative' — containing block for the NativeWatermarkOverlay
//     (position:'absolute'), keeping the watermark clipped to the player
//     frame (with overflow:'hidden') in normal mode.
//   • overflow:'hidden' — clips the watermark pill to the card's rounded
//     bounds; irrelevant in fullscreen (the container IS the screen then,
//     and its own inset clamps apply).
//
// FULLSCREEN: absolute-fill of the SCREEN ROOT (the lesson screen hosts this
// component as a direct child of its root View) — same window, same player
// instance, same decoder surface. Rotation only re-measures the container.

const INLINE_STYLE = {
  width:      '100%' as const,
  aspectRatio: 16 / 9,
  backgroundColor: '#000',
  position:   'relative' as const,
  overflow:   'hidden'   as const,
};

const FULLSCREEN_STYLE = {
  position: 'absolute' as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 100,
  backgroundColor: '#000' as const,
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
  onFullscreen,
  shouldAllowFullscreen,
}: VdoCipherPlayerProps) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  // WATERMARK IDENTITY — the ONE authoritative resolver (shared with offline).
  // Public MED-#### id only; a UUID in the id slot is dirty data and renders
  // nothing (never the internal DB user id). Stable across re-renders — the
  // identity cannot flip mid-session.
  const identity = useMemo(
    () => resolveWatermarkIdentity(
      watermarkId ? { public_user_id: watermarkId, watermark_id: watermarkId, full_name: watermarkName } : null
    ),
    [watermarkId, watermarkName]
  );

  const [otp, setOtp]               = useState<string | null>(null);
  const [playbackInfo, setPlaybackInfo] = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);

  // Duration captured from onLoaded → forwarded on every onProgress tick.
  const durationSecRef = useRef(0);

  // ── Fullscreen state — the SINGLE owner of fullscreen + orientation ───────
  // The same VdoPlayerView instance stays mounted through every transition;
  // only the container style toggles between INLINE_STYLE and FULLSCREEN_STYLE.
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Forward enter/exit to the host screen (contract: host may hide non-video
  // chrome; with the pinned-player layout this is cosmetic redundancy).
  useEffect(() => {
    onFullscreen?.(isFullscreen);
  }, [isFullscreen, onFullscreen]);

  // ── Orientation lock — landscape in fullscreen, portrait otherwise ────────
  useEffect(() => {
    if (isFullscreen) {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    } else {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    }
  }, [isFullscreen]);

  // ── System bars while fullscreen (same controller as the offline player) ──
  useEffect(() => {
    if (!isFullscreen) return;
    void enterFullscreenSystemUi();
    return () => {
      void exitFullscreenSystemUi();
    };
  }, [isFullscreen]);

  // ── SECURITY: live gate mirror while fullscreen ────────────────────────────
  // A NEW security violation (e.g. VPN enabled mid-playback) must collapse
  // fullscreen. We re-run the host-supplied authoritative gate on an interval
  // — the same fail-closed callback used at entry — and exit when it refuses.
  const shouldAllowRef = useRef(shouldAllowFullscreen);
  shouldAllowRef.current = shouldAllowFullscreen;
  useEffect(() => {
    if (!isFullscreen) return;
    let cancelled = false;
    const recheck = async () => {
      const gate = shouldAllowRef.current;
      if (!gate) return; // gateless surface (never the lesson screen)
      try {
        const ok = await gate();
        if (!cancelled && ok === false) setIsFullscreen(false);
      } catch {
        if (!cancelled) setIsFullscreen(false); // evaluation error → fail-closed
      }
    };
    const iv = setInterval(recheck, 5000);
    void recheck();
    return () => { cancelled = true; clearInterval(iv); };
  }, [isFullscreen]);

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

  // ── Fullscreen enter/exit (SAME player instance both ways) ────────────────
  const enterFullscreen = useCallback(async () => {
    // SECURITY GATE — fail-closed: blocked state, in-flight evaluation, or a
    // thrown error all refuse fullscreen.
    if (shouldAllowFullscreen) {
      try {
        if (!(await shouldAllowFullscreen())) return;
      } catch {
        return;
      }
    }
    setIsFullscreen(true);
  }, [shouldAllowFullscreen]);

  const exitFullscreen = useCallback(() => {
    setIsFullscreen(false);
  }, []);

  // SDK fullscreen events (Android native controls; no-ops on iOS where the
  // SDK renders no fullscreen button — our app-level control drives entry).
  const handleSdkEnterFullscreen = useCallback(() => {
    void enterFullscreen();
  }, [enterFullscreen]);
  const handleSdkExitFullscreen = useCallback(() => {
    exitFullscreen();
  }, [exitFullscreen]);

  // Android hardware back collapses fullscreen (in-place → BackHandler, not
  // Modal onRequestClose).
  useEffect(() => {
    if (!isFullscreen || Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      exitFullscreen();
      return true;
    });
    return () => sub.remove();
  }, [isFullscreen, exitFullscreen]);

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={[INLINE_STYLE, { alignItems: 'center', justifyContent: 'center', gap: 10 }]}>
        <ActivityIndicator color={c.primary} size="large" />
        <Text style={{ fontSize: 13, color: c.text, opacity: 0.5 }}>Loading player…</Text>
      </View>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (error || !otp || !playbackInfo) {
    return (
      <View style={[INLINE_STYLE, {
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

  // ── Native SDK player — ONE instance for the whole session ────────────────
  //
  // embedInfo.enableAutoResume=true activates VdoCipher's server-side resume
  // feature so the SDK automatically seeks to the last saved position on load.
  // showNativeControls=true renders VdoCipher's built-in control bar
  // (play/pause, seek, quality, and — on Android — the fullscreen button).
  // autoPlay=true mirrors the original WebView behaviour.

  return (
    <View style={isFullscreen ? FULLSCREEN_STYLE : INLINE_STYLE}>
      {isFullscreen && <StatusBar hidden />}
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
        onEnterFullscreen={handleSdkEnterFullscreen}
        onExitFullscreen={handleSdkExitFullscreen}
      />
      {/* Application watermark — Plyr-parity overlay (the ONLY client-side
          watermark; the server-side annotate watermark was removed from the
          OTP). Lives INSIDE the expanding container → visible and correctly
          positioned in normal AND fullscreen (re-clamps on resize). */}
      {identity && (
        <NativeWatermarkOverlay
          watermarkId={identity.id}
          watermarkName={identity.name ?? undefined}
        />
      )}

      {/* iOS app-level ENTER-fullscreen control — the SDK's native bridge
          renders no fullscreen button on iOS (device-verified), so the app
          provides one over the same player instance. Android relies on the
          SDK's control-bar button. ≥44 pt touch target. */}
      {!isFullscreen && Platform.OS === 'ios' && (
        <Pressable
          onPress={() => void enterFullscreen()}
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: 'rgba(0,0,0,0.45)',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 20,
          }}
          accessibilityLabel="Enter fullscreen"
          accessibilityRole="button"
          hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
        >
          <Maximize2 size={20} color="#fff" />
        </Pressable>
      )}

      {/* EXIT-fullscreen control (both platforms) — same language as the
          offline player's back arrow. Collapses the SAME instance back into
          the portrait layout; playback continues uninterrupted. */}
      {isFullscreen && (
        <Pressable
          onPress={exitFullscreen}
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: '#00000080',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 999,
          }}
          accessibilityLabel="Exit fullscreen"
          accessibilityRole="button"
          hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
        >
          <ArrowLeft size={22} color="#fff" />
        </Pressable>
      )}
    </View>
  );
}
