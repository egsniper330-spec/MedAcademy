/**
 * OfflineVideoPlayer.tsx
 *
 * Offline playback through the OFFICIAL VdoCipher DRM player only.
 *
 * ── Guarantees ──────────────────────────────────────────────────────────────
 * • embedInfo is ALWAYS {offline:true, mediaId} — no otp/streaming fallback,
 *   no raw file, no external player, no custom DRM path.
 * • SECURITY REVALIDATION: before the player mounts (and before fullscreen
 *   opens) the authoritative SecurityContext result is re-checked via
 *   checkBeforeVideo(). A live gate denial closes fullscreen.
 * • SCREEN CAPTURE: covered by the (app)/_layout app-shell FLAG_SECURE lock —
 *   this component never releases any capture key.
 * • WATERMARK: the ONE NativeWatermarkOverlay (Plyr-parity behavior via
 *   nativeWatermarkConfig), fed by the shared identity resolver — public
 *   MED-#### id only, NEVER the internal user UUID. The overlay lives INSIDE
 *   the expanding player container, so it stays visible and correctly
 *   positioned in normal AND fullscreen (it re-clamps on resize).
 * • FULLSCREEN + ROTATION (root-cause fix): fullscreen is IN-PLACE expansion
 *   of the SAME VdoPlayerView instance inside the SAME activity window —
 *   NOT a Modal. The old Modal created a second native window (Dialog); on
 *   rotation that window's surface was destroyed/recreated around a still-
 *   running decoder → black video with live audio. In-place expansion has
 *   no second window at all: MainActivity's manifest configChanges
 *   (orientation|screenSize|screenLayout|…) keeps the activity alive and RN
 *   simply re-measures the container; the SDK resizes its own TextureView
 *   surface within it. ONE player instance for the whole watch session →
 *   no remount, no seek/state restoration, no surface teardown, and audio/
 *   video can never desynchronize across rotation.
 * • Orientation: ANDROID locks LANDSCAPE while fullscreen, PORTRAIT_UP
 *   otherwise. iOS is NEVER locked — fullscreen keeps whatever orientation
 *   the user is currently in (Portrait stays Portrait, Landscape stays
 *   Landscape), the system Rotation Lock is never overridden, and the
 *   device is never force-rotated; only the layout adapts (the absolute-
 *   fill container re-measures to whatever window it gets).
 * • Exit: the SDK's exit control and the safe-area-aware back arrow both
 *   call the same exitFullscreen(); Android hardware back collapses it.
 * • DRM ERRORS: an expired/invalid offline license surfaces a clear error
 *   (6187 → expiration UX); playback never silently retries into an online
 *   path.
 *
 * Lifecycle: the player unmounts with the screen; VdoPlayerView releases its
 * native resources on unmount (official component contract). No player state
 * is cached across mounts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, BackHandler, Platform, Pressable, StatusBar, Text, View,
} from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import { ArrowLeft } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VdoPlayerView } from 'vdocipher-rn-bridge';
import {
  isOfflineVideoExpired,
  classifyOfflineLoadError,
  reconcileOfflineMediaState,
} from '@/lib/offlineVideoService';
import { resolveWatermarkIdentity } from '@/lib/watermarkIdentity';
import { NativeWatermarkOverlay } from '@/components/NativeWatermarkOverlay';
import {
  enterFullscreenSystemUi,
  exitFullscreenSystemUi,
} from '@/lib/fullscreenSystemUi';

import type { OfflineVideoPlayerProps } from './OfflineVideoPlayer.types';
export type { OfflineVideoPlayerProps };

type PlayerError = { message: string; expired: boolean };

export function OfflineVideoPlayer({ entry, shouldAllowPlayback, watermarkId, watermarkName, onClose }: OfflineVideoPlayerProps) {
  void onClose; // kept for API compatibility; collapse/close is owned by the host screen header

  const [gateDenied, setGateDenied] = useState(false);
  const [error, setError] = useState<PlayerError | null>(null);
  const [ready, setReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const insets = useSafeAreaInsets();

  // ── WATERMARK IDENTITY — one authoritative resolution ─────────────────────
  // Explicit props (the screens pass the profile-derived public id) win;
  // otherwise the shared resolver decides. NO entry.meta.userId fallback —
  // that field is the internal DB UUID and must never reach the screen.
  const identity = useMemo(
    () => resolveWatermarkIdentity(
      watermarkId ? { public_user_id: watermarkId, watermark_id: watermarkId, full_name: watermarkName } : null
    ),
    [watermarkId, watermarkName]
  );

  // Server-issued rental window is authoritative for the pre-mount expiry
  // check (isExpired() is Android-only in the official SDK).
  const expired = useMemo(() => isOfflineVideoExpired(entry), [entry]);

  // ── Pre-mount security revalidation (fail-closed) ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!shouldAllowPlayback) return;
      try {
        const allowed = await shouldAllowPlayback();
        if (!cancelled && !allowed) setGateDenied(true);
      } catch {
        if (!cancelled) setGateDenied(true); // evaluation failure → never play
      }
    })();
    return () => { cancelled = true; };
  }, [shouldAllowPlayback]);

  // ── Orientation — Android-only locks; iOS is NEVER locked ──────────────
  // Fullscreen must not rotate the device or bypass Rotation Lock on iOS.
  // Android: landscape while fullscreen, portrait otherwise (unchanged —
  // the manifest configChanges + in-place expansion keep the ONE player
  // instance alive through rotation).
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (isFullscreen) {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    } else {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    }
  }, [isFullscreen]);

  // ── System bars while fullscreen (same controller as the online player) ───
  useEffect(() => {
    if (!isFullscreen) return;
    void enterFullscreenSystemUi();
    return () => {
      void exitFullscreenSystemUi();
    };
  }, [isFullscreen]);

  const handleLoadError = useCallback((e: { errorDescription?: { errorMsg?: string; errorCode?: number | string } }) => {
    // Official DRM errors (VdoCipher error-code table): 6187 = expired rental
    // license; 6102/5160/5161 = offline media not complete/present; 6120-class
    // = renderer/secure-decoder (documented to correlate with >1 VdoPlayer
    // instance); 6157-class = Widevine CDM state. Map each to an honest user
    // message, and reconcile our local state against the SDK registry when the
    // SDK says the media is not (or no longer) a completed download.
    const code = e?.errorDescription?.errorCode;
    const raw = e?.errorDescription?.errorMsg || 'Offline playback failed.';
    const kind = classifyOfflineLoadError(code);
    console.info(
      `[offline-play] load error code=${String(code ?? '?')} kind=${kind} mediaId=${entry.meta.mediaId}`
    );
    if (kind === 'incomplete_media') {
      void reconcileOfflineMediaState(entry.meta.mediaId);
    }
    setError({
      message:
        kind === 'expired' ? 'The offline rental license has expired.'
        : kind === 'incomplete_media'
          ? 'This download is not complete on this device. Delete it and download again while online.'
          : kind === 'renderer'
            ? `${raw} (code ${String(code)}). Close and reopen the app — if it persists, make sure no other video is playing in the app and try again.`
            : kind === 'drm_state'
              ? `${raw} (code ${String(code)}). Close and reopen the app to reset the DRM module, then try again.`
              : raw,
      expired: kind === 'expired',
    });
  }, [entry.meta.mediaId]);

  // ── Fullscreen enter/exit (same player instance both ways) ────────────────
  const enterFullscreen = useCallback(async () => {
    // SECURITY: re-validate through the authoritative gate immediately before
    // entering fullscreen — never trust the mount-time result.
    if (shouldAllowPlayback) {
      try {
        const allowed = await shouldAllowPlayback();
        if (!allowed) { setGateDenied(true); return; }
      } catch { setGateDenied(true); return; }
    }
    setIsFullscreen(true);
  }, [shouldAllowPlayback]);

  const exitFullscreen = useCallback(() => {
    setIsFullscreen(false);
  }, []);

  // Android hardware back collapses fullscreen (no Modal → no onRequestClose).
  useEffect(() => {
    if (!isFullscreen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      exitFullscreen();
      return true;
    });
    return () => sub.remove();
  }, [isFullscreen, exitFullscreen]);

  // PLAYBACK-TIME COMPLETION GUARD (docs: only completed downloads may load;
  // a non-completed load is the documented cause of database/renderer errors).
  // Runs when a playing session starts: if the native SDK registry does not
  // confirm a completed download, the player surfaces the honest retry
  // message instead of attempting a doomed DRM load.
  const mediaId = entry.meta.mediaId;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const verdict = await reconcileOfflineMediaState(mediaId);
      if (cancelled) return;
      if (verdict === 'not_completed') {
        setError({
          message: 'This download is not complete on this device. Delete it and download again while online.',
          expired: false,
        });
      }
      // 'unknown' (registry unreachable) → keep local state; DRM still gates
      // the actual load. 'completed' → proceed silently.
    })();
    return () => { cancelled = true; };
  }, [mediaId]);

  // ── Early-exit surfaces AFTER all hooks (hooks order is render-stable) ────
  // ── Early-exit surfaces AFTER all hooks (hooks order is render-stable) ────
  if (expired) {
    return (
      <OfflinePlayerMessage
        title="Download Expired"
        body="The offline license for this video has expired. Reconnect to the internet to renew your access, then download the video again."
      />
    );
  }

  if (gateDenied) {
    return (
      <OfflinePlayerMessage
        title="Playback Blocked"
        body="Your device does not currently meet MedAcademy's security requirements. Playback is unavailable until every security issue is resolved."
      />
    );
  }

  if (error) {
    return (
      <OfflinePlayerMessage
        title={error.expired ? 'Download Expired' : 'Playback Error'}
        body={error.expired
          ? 'The offline license has expired. Reconnect to the internet and download the video again to continue watching.'
          : `The DRM player could not play this download. ${error.message}`}
      />
    );
  }

  const offlineEmbedInfo = { offline: true as const, mediaId: entry.meta.mediaId };

  return (
    // In-place fullscreen: when fullscreen, this container expands to fill the
    // watch screen (absolute fill of the screen root) — the SAME window, the
    // SAME VdoPlayerView instance, the SAME decoder surface. Rotation only
    // re-measures the container; nothing is torn down. When not fullscreen it
    // is the normal 16:9 block under the watch header.
    <View
      style={
        isFullscreen
          ? {
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              zIndex: 100, backgroundColor: '#000',
            }
          : {
              width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000',
              position: 'relative', overflow: 'hidden',
            }
      }
    >
      {isFullscreen && <StatusBar hidden />}
      {!ready && (
        <View style={{ ...({ position: 'absolute' as const }), inset: 0, alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>
          <ActivityIndicator size="large" color="#1E90FF" />
        </View>
      )}
      <VdoPlayerView
        embedInfo={offlineEmbedInfo}
        showNativeControls
        autoPlay
        style={{ flex: 1 }}
        onLoaded={() => setReady(true)}
        onLoadError={handleLoadError}
        onError={handleLoadError}
        onEnterFullscreen={enterFullscreen}
        onExitFullscreen={exitFullscreen}
      />
      {/* Application watermark — Plyr-parity component + shared identity.
          Renders only when a SAFE public identity exists (no UUID fallback).
          It lives INSIDE the expanding container → visible and correctly
          positioned in normal AND fullscreen (re-clamps on resize). */}
      {identity && (
        <NativeWatermarkOverlay watermarkId={identity.id} watermarkName={identity.name ?? undefined} />
      )}
      {/* SINGLE FULLSCREEN CONTROL — the SDK control bar's own fullscreen
          button (Android always; iOS since bridge 2.9.4 via
          didTapEnterFullScreen) fires onEnterFullscreen above, which maps
          into the ONE app fullscreen state (gate re-validated at entry).
          The former app-level expand button was a SECOND fullscreen
          system on iOS — duplicate opposite buttons + split UI — removed. */}
      {/* Fullscreen back control — the single app-level EXIT affordance,
          safe-area aware so it never sits under the Dynamic Island/status
          area. Collapses back to the inline layout; playback continues in
          the same player instance (no recreation, position preserved). */}
      {isFullscreen && (
        <Pressable
          onPress={exitFullscreen}
          style={{ position: 'absolute', top: Math.max(12, insets.top + 8), left: 12, width: 44, height: 44, borderRadius: 22, backgroundColor: '#00000080', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}
          accessibilityRole="button"
          accessibilityLabel="Exit fullscreen"
          hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
        >
          <ArrowLeft size={22} color="#fff" />
        </Pressable>
      )}
    </View>
  );
}

function OfflinePlayerMessage({ title, body }: { title: string; body: string }) {
  return (
    <View style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: '#0b1220', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16, marginBottom: 8 }}>{title}</Text>
      <Text style={{ color: '#ffffff99', fontSize: 13, textAlign: 'center', lineHeight: 19 }}>{body}</Text>
    </View>
  );
}

export default OfflineVideoPlayer;
