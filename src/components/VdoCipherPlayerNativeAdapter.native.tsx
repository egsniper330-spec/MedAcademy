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

import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { Modal, Pressable, StatusBar, Text, View, ActivityIndicator, useColorScheme } from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
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
  // The SDK's native-controls fullscreen button emits onVdoEnterFullscreen /
  // onVdoExitFullscreen and expects the HOST APP to provide the fullscreen UI
  // (the bridge's own setFullscreen command path is not used here). Without a
  // handler the SDK expanded inside the portrait 16:9 container only — the
  // "fullscreen stays portrait" bug.
  //
  // Architecture (mirrors the proven YouTubePlayer native pattern):
  //   • enter event / our close button / Android back → Modal fullscreen
  //     with a second VdoPlayerView (same otp/playbackInfo — resume synced
  //     by seeking the inline player on close).
  //   • Orientation is locked LANDSCAPE while isFullscreen, PORTRAIT_UP
  //     otherwise — synchronized in one useEffect keyed on isFullscreen.
  //     No timers; app.json keeps the app portrait at all other times.
  //   • The application watermark overlay renders INSIDE the Modal over the
  //     player; the server-side annotate watermark lives in the stream and
  //     is unaffected.
  const [isFullscreen, setIsFullscreen] = useState(false);
  const inlinePlayerRef = useRef<any>(null);
  const modalLastTimeMsRef = useRef(0);
  const modalPlayingRef = useRef(false);
  const inlinePlayingRef = useRef(false);

  // Live gate mirror: while the fullscreen Modal is open, a NEW security
  // violation (e.g. VPN enabled mid-playback) must close it. The authoritative
  // store flips `blocksVideo`; we read it through a ref that the lesson screen's
  // shouldAllowFullscreen callback captures, so we reuse its fail-closed
  // evaluation each render instead of duplicating policy logic here.
  const [fullscreenGateOpen, setFullscreenGateOpen] = useState<boolean | null>(null);
  const gateCheckInFlightRef = useRef(false);
  useEffect(() => {
    if (!isFullscreen || !shouldAllowFullscreen || gateCheckInFlightRef.current) return;
    gateCheckInFlightRef.current = true;
    Promise.resolve()
      .then(() => shouldAllowFullscreen())
      .then((ok) => setFullscreenGateOpen(ok !== false))
      .catch(() => setFullscreenGateOpen(false))
      .finally(() => { gateCheckInFlightRef.current = false; });
  }, [isFullscreen, shouldAllowFullscreen]);
  useEffect(() => {
    if (isFullscreen && fullscreenGateOpen === false) {
      handleCloseFullscreenRef.current?.();
      setFullscreenGateOpen(null);
    }
  }, [isFullscreen, fullscreenGateOpen]);

  useEffect(() => {
    if (isFullscreen) {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    } else {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    }
  }, [isFullscreen]);

  // ── System bars (Issue 5 — same mechanism as the Plyr player) ──────────────
  // RN's Android Modal mirrors the ACTIVITY window's system-bar visibility
  // into its Dialog window (syncSystemBarsVisibility in ReactModalHostView.kt),
  // so Back/Home/Recents stayed visible over the fullscreen video. Hide them
  // on the activity window while fullscreen; restore on every exit path —
  // Modal unmount runs the cleanup and pops the <StatusBar hidden> stack.
  useEffect(() => {
    if (!isFullscreen) return;
    void enterFullscreenSystemUi();
    return () => {
      void exitFullscreenSystemUi();
    };
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

  // Modal-player progress (ms) — tracked for resume-on-close.
  const handleModalProgress = useCallback((event: any) => {
    const ms = event?.currentTime ?? 0;
    if (ms > 0) modalLastTimeMsRef.current = ms;
    onProgress?.(ms / 1000, durationSecRef.current);
  }, [onProgress]);

  // Play/pause tracking for both instances (playWhenReady is the source of
  // truth for whether audio should be running after a transition).
  const handleInlineStateChanged = useCallback((event: any) => {
    if (event && typeof event.playWhenReady === 'boolean') {
      inlinePlayingRef.current = event.playWhenReady;
    }
  }, []);
  const handleModalStateChanged = useCallback((event: any) => {
    if (event && typeof event.playWhenReady === 'boolean') {
      modalPlayingRef.current = event.playWhenReady;
    }
  }, []);

  // onMediaEnded fires when playback reaches the end.
  const handleMediaEnded = useCallback((_event: any) => {
    onEnd?.();
  }, [onEnd]);

  // ── Fullscreen lifecycle handlers ─────────────────────────────────────────
  // Inline player's native fullscreen button → open the fullscreen Modal.
  const handleInlineEnterFullscreen = useCallback(async () => {
    // SECURITY GATE — fail-closed: blocked state, in-flight evaluation, or a
    // thrown error all refuse fullscreen. The Modal renders above the
    // SecurityGate overlay, so it must never mount from a stale decision.
    if (shouldAllowFullscreen) {
      try {
        if (!(await shouldAllowFullscreen())) return;
      } catch {
        return;
      }
    }
    modalLastTimeMsRef.current = 0;
    modalPlayingRef.current = false;
    setIsFullscreen(true);
    // Pause the inline instance while the Modal player takes over — prevents
    // double audio and lets VdoCipher's server-side resume persist a current
    // position for the Modal mount.
    try { inlinePlayerRef.current?.pause(); } catch (_) {}
  }, []);

  // Shared close path: Modal close button, Android back (onRequestClose), and
  // the Modal player's exit-fullscreen control all route here. Restores the
  // inline player to the exact position/play state the user left.
  const handleCloseFullscreen = useCallback(() => {
    const seekMs = modalLastTimeMsRef.current;
    const wasPlaying = modalPlayingRef.current;
    setIsFullscreen(false);
    try {
      if (seekMs > 0) inlinePlayerRef.current?.seek(seekMs);
      if (wasPlaying) { inlinePlayerRef.current?.play(); } else { inlinePlayerRef.current?.pause(); }
    } catch (_) {}
  }, []);
  // Late-bound ref: the gate-close effect above runs before this callback is
  // defined in the render sequence — it reads the ref, not the binding.
  const handleCloseFullscreenRef = useRef<typeof handleCloseFullscreen | null>(null);
  handleCloseFullscreenRef.current = handleCloseFullscreen;

  // Modal player's own fullscreen-exit control → leave fullscreen.
  const handleModalExitFullscreen = useCallback(() => {
    handleCloseFullscreen();
  }, [handleCloseFullscreen]);

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
    <>
      <View style={containerStyle}>
        <VdoPlayerView
          ref={inlinePlayerRef}
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
          onPlayerStateChanged={handleInlineStateChanged}
          onMediaEnded={handleMediaEnded}
          onLoadError={handleLoadError}
          onEnterFullscreen={handleInlineEnterFullscreen}
        />
        {/* Phase 2 — application-level watermark overlay.
            Rendered AFTER VdoPlayerView in the tree so it paints above it.
            pointerEvents="none" is enforced inside NativeWatermarkOverlay.
            VdoCipher's server-side watermark (embedInfo) remains unaffected.
            Requires watermarkId; watermarkName is optional (ID-only mode if absent). */}
        {identity && (
          <NativeWatermarkOverlay
            watermarkId={identity.id}
            watermarkName={identity.name ?? undefined}
          />
        )}
      </View>

      {/* ── Fullscreen Modal ──────────────────────────────────────────────────
          The Modal IS the fullscreen experience (same architecture as the
          Plyr player). Orientation is locked landscape for its lifetime by
          the isFullscreen effect above. The application watermark overlay
          renders inside, above the player; the server-side annotate
          watermark is part of the DRM stream and always present. Exit paths:
          ✕ button, Android back (onRequestClose), and the player's own
          exit-fullscreen control (onExitFullscreen) — all route through
          handleCloseFullscreen, which seeks the inline player to the last
          modal position and restores its play/pause state. */}
      <Modal
        visible={isFullscreen && fullscreenGateOpen !== false}
        animationType="fade"
        statusBarTranslucent
        supportedOrientations={['portrait', 'landscape', 'landscape-left', 'landscape-right']}
        onRequestClose={handleCloseFullscreen}
      >
        <StatusBar hidden />
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <VdoPlayerView
            embedInfo={{
              otp,
              playbackInfo,
              enableAutoResume: true,
            }}
            showNativeControls
            style={{ flex: 1 }}
            onProgress={handleModalProgress}
            onPlayerStateChanged={handleModalStateChanged}
            onMediaEnded={handleMediaEnded}
            onLoadError={handleLoadError}
            onExitFullscreen={handleModalExitFullscreen}
          />
          {identity && (
            <NativeWatermarkOverlay
              watermarkId={identity.id}
              watermarkName={identity.name ?? undefined}
            />
          )}

          {/* Native close button — always visible, large touch target */}
          <Pressable
            onPress={handleCloseFullscreen}
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: 'rgba(0,0,0,0.55)',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 999,
            }}
            accessibilityLabel="Exit fullscreen"
            accessibilityRole="button"
            hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
          >
            <Text style={{ color: '#fff', fontSize: 18, lineHeight: 20, fontWeight: '600' }}>✕</Text>
          </Pressable>
        </View>
      </Modal>
    </>
  );
}
