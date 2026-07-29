/**
 * YouTubePlayer.tsx
 *
 * Renders a YouTube video using official Plyr controls on all platforms.
 *
 * ── Architecture ─────────────────────────────────────────────────────────────
 *   Web (Expo web):
 *     <iframe src="/player/index.html?v=ID&t=SECONDS&wname=...&wid=..." />
 *     Static files served from public/player/ — no CDN, works offline.
 *
 *   Native (iOS / Android):
 *     <WebView source={{ html }} />
 *     Plyr JS + CSS inlined from src/lib/plyr/plyrBundle.ts (offline capable).
 *     Player logic from src/lib/plyr/playerScript.ts.
 *
 * ── Watermark ────────────────────────────────────────────────────────────────
 *   TWO layers:
 *   1. In-HTML watermark — injected by player.js inside the Plyr container.
 *      Survives Plyr CSS fullscreen on both web and native WebView.
 *   2. React Native overlay (VideoWatermark) — visible in normal mode and
 *      inside the fullscreen Modal.
 *
 * ── Fullscreen (native) ───────────────────────────────────────────────────────
 *   The Modal IS the fullscreen experience. Architecture:
 *
 *     Inline player  ─(enterfullscreen)→  Modal opens, new WebView plays
 *     Modal WebView  ─(hideFullscreen=true)→  no Plyr fullscreen button
 *     Close button   ─(press)→  capture time + state → close Modal → seek inline
 *
 *   The Modal WebView receives hideFullscreen=true in __PLAYER_CONFIG__, which
 *   removes the Plyr fullscreen button and disables Plyr's fullscreen API
 *   entirely — preventing a double-fullscreen state (Modal + Plyr CSS).
 *
 *   Exit is handled by a native close button (top-right) — works on both
 *   iOS and Android. Android back button also dismisses via onRequestClose.
 *
 * ── postMessage protocol (player → host) ─────────────────────────────────────
 *   { type: 'yt:ready' }
 *   { type: 'yt:progress',   currentTime: number, duration: number }
 *   { type: 'yt:playing' }
 *   { type: 'yt:paused' }
 *   { type: 'yt:ended',      currentTime: number, duration: number }
 *   { type: 'yt:error',      message: string }
 *   { type: 'yt:fullscreen', active: boolean }   ← inline player only
 *
 * ── YouTube title note ───────────────────────────────────────────────────────
 *   YouTube's pre-roll title overlay cannot be suppressed via embed parameters
 *   since YouTube deprecated showinfo=0 in September 2018. The official Plyr
 *   demo at plyr.io shows this same overlay. It is a YouTube platform
 *   limitation — not a Plyr bug or implementation gap.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import ReactDOM from 'react-dom';
import { Modal, Platform, Pressable, StatusBar, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { VideoWatermark, type VideoWatermarkProps } from './VideoWatermark';
import { PLAYER_SCRIPT } from '../lib/plyr/playerScript';
import { PLYR_CSS, PLYR_JS } from '../lib/plyr/plyrBundle';

// ─── Public props ─────────────────────────────────────────────────────────────

export interface YouTubePlayerProps {
  /** Any YouTube URL format or a bare 11-character video ID. */
  videoId: string;
  /** Resume position in seconds. */
  resumePosition?: number;
  onReady?: () => void;
  /** currentTime and duration in seconds. */
  onProgress?: (currentTime: number, duration: number) => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
  /**
   * Identity watermark rendered above the player.
   * Rendered as two layers: in-HTML (survives fullscreen) + RN overlay.
   * Does not modify the YouTube iframe.
   */
  watermark?: VideoWatermarkProps;
  /**
   * Called when the player enters or exits fullscreen.
   * Useful for the host screen to adjust its own layout.
   */
  onFullscreen?: (active: boolean) => void;
}

// ─── URL normalization ────────────────────────────────────────────────────────

export function extractYouTubeVideoId(input: string): string {
  if (!input) return input;
  const trimmed = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      if (id) return id;
    }
    const v = url.searchParams.get('v');
    if (v) return v;
    const pathMatch = url.pathname.match(/\/(?:embed|shorts|v)\/([A-Za-z0-9_-]{11})/);
    if (pathMatch) return pathMatch[1];
  } catch {
    // Not a valid URL — bare ID passthrough.
  }
  return trimmed;
}

// ─── Native HTML builder ──────────────────────────────────────────────────────

interface PlayerConfig {
  videoId: string;
  resumeAt: number;
  watermarkName?: string;
  watermarkId?: string;
  /** When true: removes Plyr's fullscreen button and disables its fullscreen API. */
  hideFullscreen?: boolean;
}

function buildNativeHtml(cfg: PlayerConfig): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
    .plyr { width: 100%; height: 100%; }
${PLYR_CSS}
  </style>
</head>
<body>
  <div data-plyr-provider="youtube" data-plyr-embed-id="" id="player"></div>
  <script>window.__PLAYER_CONFIG__ = ${JSON.stringify(cfg)};</script>
  <script>${PLYR_JS}</script>
  <script>${PLAYER_SCRIPT}</script>
</body>
</html>`;
}

// ─── Message handler ──────────────────────────────────────────────────────────

interface PlayerMessage {
  type: string;
  currentTime?: number;
  duration?: number;
  message?: string;
  active?: boolean;
}

function parsePlayerMessage(data: string | object): PlayerMessage | null {
  try {
    return typeof data === 'string' ? JSON.parse(data) : (data as PlayerMessage);
  } catch {
    return null;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function YouTubePlayer({
  videoId: rawVideoId,
  resumePosition = 0,
  onReady,
  onProgress,
  onEnd,
  onError,
  watermark,
  onFullscreen,
}: YouTubePlayerProps) {
  const videoId = extractYouTubeVideoId(rawVideoId);

  const inner = Platform.OS === 'web' ? (
    <YouTubePlayerWeb
      videoId={videoId}
      resumePosition={resumePosition}
      onReady={onReady}
      onProgress={onProgress}
      onEnd={onEnd}
      onError={onError}
      watermark={watermark}
      onFullscreen={onFullscreen}
    />
  ) : (
    <YouTubePlayerNative
      videoId={videoId}
      resumePosition={resumePosition}
      onReady={onReady}
      onProgress={onProgress}
      onEnd={onEnd}
      onError={onError}
      watermark={watermark}
      onFullscreen={onFullscreen}
    />
  );

  return (
    <View style={{ width: '100%', flexDirection: 'column' }}>
      {inner}
    </View>
  );
}

// ─── Sub-component props ──────────────────────────────────────────────────────

interface SubProps {
  videoId: string;
  resumePosition: number;
  onReady?: () => void;
  onProgress?: (ct: number, dur: number) => void;
  onEnd?: () => void;
  onError?: (msg: string) => void;
  watermark?: VideoWatermarkProps;
  onFullscreen?: (active: boolean) => void;
}

// ─── Web sub-component ────────────────────────────────────────────────────────
//
// Watermark is passed as URL params so player.js injects it inside the Plyr
// container — ensuring it survives Plyr's requestFullscreen().
// The React-level overlay is omitted: it sits outside the iframe and therefore
// disappears when the iframe enters native fullscreen.
//
// Fullscreen approach: single persistent iframe, CSS-only transition.
// When pseudoFullscreen toggles, only the iframe's style changes — it is never
// remounted, so the video keeps playing from the exact same position.

function YouTubePlayerWeb({
  videoId,
  resumePosition,
  onReady,
  onProgress,
  onEnd,
  onError,
  watermark,
  onFullscreen,
}: SubProps) {
  const wmParams = watermark
    ? `&wname=${encodeURIComponent(watermark.name)}&wid=${encodeURIComponent(watermark.studentId)}`
    : '';
  const src = `/player/index.html?v=${encodeURIComponent(videoId)}&t=${resumePosition}${wmParams}`;

  // CSS pseudo-fullscreen — used when document.fullscreenEnabled = false inside
  // the iframe chain (e.g. platform sandbox nesting). Expands the player to cover
  // the entire viewport via position:fixed instead of requestFullscreen().
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const msg = parsePlayerMessage(event.data);
      if (!msg) return;
      switch (msg.type) {
        case 'yt:ready':
          onReady?.();
          break;
        case 'yt:progress':
          onProgress?.(msg.currentTime ?? 0, msg.duration ?? 0);
          break;
        case 'yt:ended':
          onEnd?.();
          break;
        case 'yt:error':
          onError?.(msg.message ?? 'Playback error');
          break;
        case 'yt:fullscreen':
          onFullscreen?.(msg.active ?? false);
          setPseudoFullscreen(msg.active ?? false);
          break;
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onReady, onProgress, onEnd, onError, onFullscreen]);

  return (
    <>
      {/* Placeholder div — always holds the 16:9 slot in the page layout.
          The iframe escapes this box via position:fixed when in fullscreen,
          but the div keeps its height so the rest of the page doesn't jump. */}
      <div style={{ width: '100%', aspectRatio: '16/9', backgroundColor: '#000', position: 'relative' }}>
        {/* Single persistent iframe — style toggles between inline and fixed.
            No key change, no remount: video plays through the transition uninterrupted. */}
        <iframe
          key={src}
          src={src}
          style={pseudoFullscreen ? {
            position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
            zIndex: 99999, border: 'none', display: 'block', backgroundColor: '#000',
          } : {
            border: 'none', width: '100%', height: '100%', display: 'block',
          }}
          allow="autoplay; fullscreen; picture-in-picture"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          title="Video Player"
        />
      </div>

      {/* Exit button — portaled to document.body so it paints above the fixed
          iframe and any RN Web compositing layers (z-index: 100000). */}
      {pseudoFullscreen && typeof document !== 'undefined' && ReactDOM.createPortal(
        <button
          onClick={() => { setPseudoFullscreen(false); onFullscreen?.(false); }}
          style={{
            position: 'fixed', top: 14, right: 14, zIndex: 100000,
            background: 'rgba(0,0,0,0.6)', color: '#fff',
            border: '1px solid rgba(255,255,255,0.25)',
            borderRadius: 7, padding: '6px 14px',
            cursor: 'pointer', fontSize: 13, fontFamily: 'system-ui, sans-serif',
            backdropFilter: 'blur(4px)',
          }}
          aria-label="Exit fullscreen"
        >
          ✕ Exit
        </button>,
        document.body,
      )}
    </>
  );
}

// ─── Native sub-component ─────────────────────────────────────────────────────
//
// Fullscreen architecture:
//   • Inline player has the Plyr fullscreen button (hideFullscreen=false).
//     Tapping it fires enterfullscreen → postMessage yt:fullscreen:true → Modal opens.
//   • Modal player has hideFullscreen=true:
//       – The Plyr fullscreen button is absent (removed from controls array).
//       – Plyr's fullscreen API is disabled (fullscreen.enabled=false).
//       – The Modal itself IS the fullscreen experience.
//   • A native RN close button (top-right) dismisses the Modal on both iOS & Android.
//   • Android back button also works via onRequestClose.
//
// State sync on close:
//   yt:progress messages from the Modal WebView update lastTimeRef continuously.
//   yt:playing / yt:paused messages update modalPlayingRef.
//   On close: inline WebView is seeked to lastTimeRef and play/pause restored.
//
// Cleanup:
//   Modal visible=false → React unmounts Modal children (including WebView).
//   All WebView listeners are released; no dangling intervals or timers.

function YouTubePlayerNative({
  videoId,
  resumePosition,
  onReady,
  onProgress,
  onEnd,
  onError,
  watermark,
  onFullscreen,
}: SubProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Shared playback-position tracker — updated by whichever WebView is active.
  const lastTimeRef      = useRef(resumePosition);
  // Play/pause state of the INLINE player — captured when fullscreen is entered
  // so the Modal starts in the correct play/pause state.
  const inlinePlayingRef = useRef(false);
  // Play/pause state of the MODAL player — used to restore inline on close.
  const modalPlayingRef  = useRef(false);
  const inlineWvRef      = useRef<WebView>(null);

  // ── Inline HTML (normal mode) ───────────────────────────────────────────────
  // Memoized so the WebView's source prop never changes identity between renders.
  // Without memo, setIsFullscreen(true) triggers a re-render that produces a new
  // HTML string, causing the WebView to reload and tear down the Plyr instance
  // just as the Modal is opening — resulting in a blank inline player on close.
  const inlineHtml = useMemo(
    () => buildNativeHtml({
      videoId,
      resumeAt:      resumePosition,
      watermarkName: watermark?.name,
      watermarkId:   watermark?.studentId,
      hideFullscreen: false,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videoId, resumePosition, watermark?.name, watermark?.studentId],
  );

  // ── Progress tracking ───────────────────────────────────────────────────────
  const handleProgress = useCallback(
    (ct: number, dur: number) => {
      lastTimeRef.current = ct;
      onProgress?.(ct, dur);
    },
    [onProgress],
  );

  const onInlineMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const msg = parsePlayerMessage(event.nativeEvent.data);
      if (!msg) return;
      switch (msg.type) {
        case 'yt:ready':
          onReady?.();
          break;
        case 'yt:progress':
          handleProgress(msg.currentTime ?? 0, msg.duration ?? 0);
          break;
        case 'yt:playing':
          inlinePlayingRef.current = true;
          break;
        case 'yt:paused':
          inlinePlayingRef.current = false;
          break;
        case 'yt:ended':
          onEnd?.();
          break;
        case 'yt:error':
          onError?.(msg.message ?? 'Playback error');
          break;
        case 'yt:fullscreen':
          if (msg.active) {
            // Snapshot inline play/pause state before the Modal mounts.
            modalPlayingRef.current = inlinePlayingRef.current;
            setIsFullscreen(true);
            onFullscreen?.(true);
          }
          break;
      }
    },
    [onReady, handleProgress, onEnd, onError, onFullscreen],
  );

  // ── Modal WebView message handler ──────────────────────────────────────────
  // No yt:fullscreen handling here — the Modal has no fullscreen button.
  const onModalMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const msg = parsePlayerMessage(event.nativeEvent.data);
      if (!msg) return;
      switch (msg.type) {
        case 'yt:progress':
          handleProgress(msg.currentTime ?? 0, msg.duration ?? 0);
          break;
        case 'yt:playing':
          modalPlayingRef.current = true;
          break;
        case 'yt:paused':
          modalPlayingRef.current = false;
          break;
        case 'yt:ended':
          onEnd?.();
          break;
        case 'yt:error':
          onError?.(msg.message ?? 'Playback error');
          break;
      }
    },
    [handleProgress, onEnd, onError],
  );

  // ── Close handler — used by both the native button and onRequestClose ───────
  // 1. Capture the last known time (already in lastTimeRef via onModalMessage).
  // 2. Close the Modal (unmounts Modal WebView → no memory leak).
  // 3. Seek the inline WebView to the captured position.
  // 4. Restore play/pause state.
  const handleClose = useCallback(() => {
    const seekTime = lastTimeRef.current;
    const wasPlaying = modalPlayingRef.current;

    setIsFullscreen(false);
    onFullscreen?.(false);

    // Defer the inject until after the Modal unmounts and the inline WebView
    // is in the foreground again (next event-loop tick is sufficient).
    setTimeout(() => {
      const js = [
        `if(window.__plyr){`,
        `  window.__plyr.currentTime=${seekTime};`,
        wasPlaying
          ? `  window.__plyr.play().catch(function(){});`
          : `  window.__plyr.pause();`,
        `}`,
        `true;`,
      ].join('');
      inlineWvRef.current?.injectJavaScript(js);
    }, 50);
  }, [onFullscreen]);

  // ── Modal HTML — memoized for the lifetime of the fullscreen session ────────
  // Built once when isFullscreen first becomes true; never rebuilt during the
  // session. Without useMemo, any state change in YouTubePlayerNative (e.g. a
  // future re-render triggered by onProgress) would rebuild the HTML string and
  // hand a new object to the WebView source prop, causing a hard reload of the
  // entire player mid-playback.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const modalHtml = useMemo(
    () => buildNativeHtml({
      videoId,
      resumeAt:       lastTimeRef.current,
      watermarkName:  watermark?.name,
      watermarkId:    watermark?.studentId,
      hideFullscreen: true,
    }),
    // Deps: only re-build when a new fullscreen session starts (isFullscreen
    // toggles true) or the video itself changes. lastTimeRef is intentionally
    // NOT a dep — it is a ref, not state; we read its value at the moment the
    // memo runs (when isFullscreen becomes true).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isFullscreen, videoId, watermark?.name, watermark?.studentId],
  );

  return (
    <>
      {/* ── Inline player ───────────────────────────────────────────── */}
      <View style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000', position: 'relative' }}>
        <WebView
          ref={inlineWvRef}
          source={{ html: inlineHtml, baseUrl: 'https://medacademy.app' }}
          style={{ flex: 1, backgroundColor: '#000' }}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          allowsFullscreenVideo
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={['*']}
          onMessage={onInlineMessage}
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        />
        {watermark && <VideoWatermark {...watermark} />}
      </View>

      {/* ── Fullscreen Modal ─────────────────────────────────────────── */}
      {/* visible=false unmounts children → Modal WebView is destroyed, no leak */}
      <Modal
        visible={isFullscreen}
        animationType="fade"
        statusBarTranslucent
        supportedOrientations={['portrait', 'landscape', 'landscape-left', 'landscape-right']}
        onRequestClose={handleClose}
        onShow={() => {}}
      >
        <StatusBar hidden />
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          {/* Modal player — Plyr fullscreen button absent (hideFullscreen=true) */}
          <WebView
            source={{ html: modalHtml, baseUrl: 'https://medacademy.app' }}
            style={{ flex: 1, backgroundColor: '#000' }}
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            allowsFullscreenVideo={false}
            javaScriptEnabled
            domStorageEnabled
            originWhitelist={['*']}
            onMessage={onModalMessage}
            scrollEnabled={false}
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
          />

          {/* Watermark overlay inside the Modal */}
          {watermark && <VideoWatermark {...watermark} />}

          {/* ── Native close button ─────────────────────────────────── */}
          {/* Always visible; large touch target; works on iOS and Android */}
          <Pressable
            onPress={handleClose}
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
            <Text style={{ color: '#fff', fontSize: 18, lineHeight: 20, fontWeight: '600' }}>
              ✕
            </Text>
          </Pressable>
        </View>
      </Modal>
    </>
  );
}
