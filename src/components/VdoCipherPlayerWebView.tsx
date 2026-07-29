/**
 * VdoCipherPlayerWebView.tsx
 *
 * Original WebView-based VdoCipher player implementation.
 * Preserved verbatim as a fallback for:
 *   - Web platform (always used)
 *   - Native with USE_NATIVE_VDOCIPHER_PLAYER = false (instant rollback)
 *
 * ── Watermark strategy ──────────────────────────────────────────────────────
 *
 *   Native (Android/iOS)
 *     DOM injection via injectedJavaScriptBeforeContentLoaded.
 *     See: src/lib/watermarkInjection.ts
 *
 *   Web — THREE complementary layers:
 *
 *   1. VdoCipher server-side `annotate` (rtext) — baked into the DRM/OTP token.
 *      Rendered INSIDE the VdoCipher player iframe by VdoCipher's own engine.
 *      Survives all fullscreen modes including Safari iOS native player because
 *      it is part of the video stream itself.
 *      Configured in: supabase/functions/vdocipher-otp/index.ts
 *
 *   2. useFullscreenWatermark (DOM hook) — pure-DOM <div> managed outside React.
 *      In normal mode: position:absolute child of the player container.
 *      On fullscreenchange: re-parented into document.fullscreenElement and
 *      switched to position:fixed so it tracks the promoted fullscreen layer.
 *      On exit: restored to the player container.
 *      Handles: Chrome, Firefox, Edge, Safari macOS (webkitfullscreenchange).
 *      See: src/hooks/useFullscreenWatermark.ts
 *
 *   3. ForensicWatermarkOverlay (Reanimated) — kept for normal (non-fullscreen)
 *      mode as a belt-and-suspenders overlay with smooth entrance animation.
 *      Does NOT survive fullscreen (by design — layer 2 covers that path).
 *      See: src/components/ForensicWatermarkOverlay.tsx
 *
 * ── Safari iPhone ────────────────────────────────────────────────────────────
 *   Safari on iOS can switch to the native AVPlayerViewController for fullscreen.
 *   Mitigations applied here:
 *     • iframe gets webkit-playsinline + playsinline attributes (inline playback)
 *     • VdoCipher embed already passes playsinline:1 inside the iframe
 *   These keep the player inline in Safari iOS, preventing native takeover for
 *   most interactions. When the native player IS used, no DOM overlay is possible;
 *   the VdoCipher server-side annotate watermark (layer 1) remains active.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, ActivityIndicator, useColorScheme } from 'react-native';
import { getVideoPlaybackToken } from '@/lib/api';
import { neuColors } from '@/lib/neu';
import { WebView } from 'react-native-webview';
import { buildWatermarkInjection } from '@/lib/watermarkInjection';
import { ForensicWatermarkOverlay } from '@/components/ForensicWatermarkOverlay';
import { useFullscreenWatermark } from '@/hooks/useFullscreenWatermark';
import type { VdoCipherPlayerProps } from '@/components/VdoCipherPlayer';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildPlayerUrl(otp: string, playbackInfo: string): string {
  return (
    `https://player.vdocipher.com/v2/` +
    `?otp=${encodeURIComponent(otp)}` +
    `&playbackInfo=${encodeURIComponent(playbackInfo)}`
  );
}

// ─── Shared container style ───────────────────────────────────────────────────
//
// position:'relative' makes this the containing block for ForensicWatermarkOverlay
// (position:'absolute') and for the DOM watermark injected by useFullscreenWatermark.
//
// overflow:'hidden' is intentionally REMOVED from the web container.
//
//   Original reason for overflow:'hidden': clip the watermark to the player card
//   rounded-corner bounds in normal mode.
//
//   Why it is now removed:
//     overflow:'hidden' (or 'clip') on a positioned ancestor creates a new
//     CSS "containing block" boundary.  When the browser enters fullscreen it
//     promotes the VdoCipher iframe (or a wrapper element inside it) to a
//     top-level rendering layer.  Any sibling/ancestor with overflow:'hidden'
//     causes the UA to clip child layers — the overlay div is clipped to the
//     original (non-fullscreen) container bounds and disappears.
//
//     Removing overflow:'hidden' allows the DOM watermark (useFullscreenWatermark)
//     to escape the container when re-parented into document.fullscreenElement,
//     and prevents the Reanimated overlay from being clipped in normal mode.
//
// Native (Android/iOS): overflow:'hidden' is kept via containerStyleNative below
// because clipping is desired there and fullscreen is handled by the RN Modal.

const containerStyle = {
  width:           '100%' as const,
  aspectRatio:     16 / 9,
  backgroundColor: '#000',
  position:        'relative' as const,
  // overflow NOT set — intentionally omitted; see comment above
};

const containerStyleNative = {
  ...containerStyle,
  overflow: 'hidden' as const, // safe on native — fullscreen uses RN Modal
};

// ─── Component ────────────────────────────────────────────────────────────────

export function VdoCipherPlayerWebView({
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

  const [playerUrl, setPlayerUrl] = useState<string | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);

  // Web only — container ref for DOM watermark hook + Reanimated overlay dimensions.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerW, setContainerW] = useState(0);
  const [containerH, setContainerH] = useState(0);

  // ── DOM fullscreen watermark — survives fullscreen transitions on web ─────
  // Runs only on web (guard is inside the hook). Manages a pure-DOM <div> that
  // re-parents itself into document.fullscreenElement on fullscreenchange.
  useFullscreenWatermark(
    containerRef,
    watermarkId ? { watermarkId, watermarkName } : null,
    process.env.EXPO_OS === 'web' && !!watermarkId,
  );

  // ── Fetch OTP on mount ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPlayerUrl(null);
    (async () => {
      try {
        const { otp, playbackInfo } = await getVideoPlaybackToken(videoId, lessonId);
        if (!cancelled) {
          const url = buildPlayerUrl(otp, playbackInfo);
          setPlayerUrl(url);
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

  // ── Native WebView → React Native message bridge ──────────────────────────
  const handleNativeMessage = useCallback((event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data ?? '{}');

      if (msg.poc) return;

      if (msg.type === 'vdo:ready')    onReady?.();
      if (msg.type === 'vdo:ended')    onEnd?.();
      if (msg.type === 'vdo:progress') onProgress?.(msg.currentTime ?? 0, msg.duration ?? 0);
      if (msg.type === 'vdo:error')    onError?.(msg.message ?? 'Playback error');
    } catch (_) {}
  }, [onReady, onEnd, onProgress, onError]);

  // ── Web: window.postMessage listener ─────────────────────────────────────
  useEffect(() => {
    if (process.env.EXPO_OS !== 'web') return;
    const handler = (e: MessageEvent) => {
      try {
        const raw = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (!raw) return;
        if (raw.event === 'ready')    onReady?.();
        if (raw.event === 'ended')    onEnd?.();
        if (raw.event === 'progress') onProgress?.(raw.data?.currentTime ?? 0, raw.data?.duration ?? 0);
        if (raw.event === 'error')    onError?.(raw.data?.message ?? 'Playback error');
      } catch (_) {}
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onReady, onEnd, onProgress, onError]);

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={[containerStyleNative, { alignItems: 'center', justifyContent: 'center', gap: 10 }]}>
        <ActivityIndicator color={c.primary} size="large" />
        <Text style={{ fontSize: 13, color: c.text, opacity: 0.5 }}>Loading player…</Text>
      </View>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (error || !playerUrl) {
    return (
      <View style={[containerStyleNative, { backgroundColor: '#0A0A0A', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 8 }]}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff', textAlign: 'center' }}>Video Unavailable</Text>
        <Text style={{ fontSize: 12, color: '#ffffff88', textAlign: 'center', lineHeight: 18 }}>
          {error ?? 'Could not load the player. Please check your connection.'}
        </Text>
      </View>
    );
  }

  // ── Web — <iframe> + DOM fullscreen watermark + Reanimated overlay ────────
  //
  // Layer order (back → front):
  //   1. <iframe>               — VdoCipher player (contains server-side annotate rtext)
  //   2. ForensicWatermarkOverlay — Reanimated overlay for normal mode (z-index:10)
  //   3. DOM watermark div      — managed by useFullscreenWatermark (z-index:2147483647)
  //                               re-parented into fullscreenElement on fullscreenchange
  //
  // The container ref is forwarded to useFullscreenWatermark via containerRef.
  // It must be attached to the actual DOM element (React Native View → <div> on web).
  if (process.env.EXPO_OS === 'web') {
    const handleLayout = (e: any) => {
      const { width, height } = e.nativeEvent.layout;
      setContainerW(width);
      setContainerH(height);
    };
    return (
      <View
        style={containerStyle}
        onLayout={handleLayout}
        ref={containerRef as any}
      >
        {/*
          iframe allow list:
            • fullscreen        — required for browser Fullscreen API
            • encrypted-media   — required for DRM (Widevine/FairPlay)
            • autoplay          — allows VdoCipher to begin playback programmatically
          webkit-playsinline + playsInline:
            • Keeps video inline in Safari iOS instead of launching native AVPlayer.
            • VdoCipher also passes playsinline:1 inside the embed — belt-and-suspenders.
        */}
        <iframe
          src={playerUrl}
          style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
          allow="encrypted-media; autoplay; fullscreen"
          allowFullScreen
          // @ts-ignore — webkit-playsinline + x-webkit-airplay are non-standard Safari
          // attributes not in React/TS typings; suppress the single-line TS error.
          webkit-playsinline="true"
          onLoad={() => onReady?.()}
        />
        {/* ForensicWatermarkOverlay: normal-mode belt-and-suspenders layer */}
        {watermarkId && (
          <ForensicWatermarkOverlay
            watermarkId={watermarkId}
            watermarkName={watermarkName}
            containerWidth={containerW}
            containerHeight={containerH}
          />
        )}
      </View>
    );
  }

  // ── Native (Android / iOS) — WebView ─────────────────────────────────────
  // Pass watermarkId and watermarkName so the injected IIFE renders the
  // forensic watermark overlay.  Previously called with NO arguments, which
  // meant buildWatermarkInjection() returned event-bridge-only code and the
  // watermark div was never created.
  const eventBridgeScript = buildWatermarkInjection(watermarkId, watermarkName);

  return (
    <View style={containerStyleNative}>
      <WebView
        source={{ uri: playerUrl }}
        style={{ flex: 1, backgroundColor: '#000' }}
        injectedJavaScriptBeforeContentLoaded={eventBridgeScript}
        onMessage={handleNativeMessage}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsFullscreenVideo
        javaScriptEnabled
        domStorageEnabled
        allowsProtectedMedia
        onShouldStartLoadWithRequest={(req: { url: string }) =>
          req.url.startsWith('https://player.vdocipher.com')
        }
      />
    </View>
  );
}
