/**
 * YouTubePlayer.tsx
 *
 * Renders a YouTube video using official Plyr controls on all platforms.
 *
 * ── Architecture ─────────────────────────────────────────────────────────────
 *   Web (Expo web):
 *     <iframe src="/player/index.html?v=ID&t=SECONDS&wname=...&wid=...&fs=0|1" />
 *     Static files served from public/player/ — no CDN, works offline.
 *
 *   Native (iOS / Android):
 *     <WebView source={{ html }} />
 *     Plyr JS + CSS inlined from src/lib/plyr/plyrBundle.ts (offline capable).
 *     Player logic from src/lib/plyr/playerScript.ts.
 *
 * ── Watermark ────────────────────────────────────────────────────────────────
 *   EXACTLY ONE instance per active player: the in-HTML watermark injected by
 *   the player script inside the Plyr container (survives fullscreen on both
 *   web and native WebView). A former second RN overlay (VideoWatermark)
 *   rendered on top of it in normal mode — the "duplicate/broken watermark" —
 *   and was removed. The in-HTML watermark is the canonical renderer.
 *
 * ── Fullscreen (native) — IN-PLACE, single WebView ───────────────────────────
 *   The SAME WebView instance that plays inline expands to fill the screen —
 *   no Modal, no second window, no second WebView. The previous Modal
 *   architecture (a second native Dialog window + a second WebView re-creating
 *   the Plyr player) was the root cause of the rotation black screen: on
 *   rotation the Dialog surface was torn down/recreated around a running
 *   media pipeline. In-place expansion has none of that — rotation only
 *   re-measures the container; the WebView, the Plyr instance, playback
 *   position, and the in-HTML watermark all survive untouched (position is
 *   continuous by construction — nothing to seek or restore).
 *
 *     Plyr fullscreen button  ─(capture-phase intercept)→ yt:fullscreen msg
 *     RN toggles the SAME container between inline and absolute-fill.
 *     The same button toggles exit; a back-arrow control and Android
 *     hardware back also collapse it.
 *
 *   Responsive rotation (no forced orientation): entering fullscreen keeps
 *   the current orientation; the absolute-fill container re-measures to
 *   whatever window the OS gives it — portrait stays portrait, landscape
 *   stays landscape, and a physical rotation while fullscreen re-measures
 *   the SAME WebView in place.
 *
 * ── postMessage protocol (player → host) ────────────────────────────────────
 *   { type: 'yt:ready' }
 *   { type: 'yt:progress',   currentTime: number, duration: number }
 *   { type: 'yt:playing' }
 *   { type: 'yt:paused' }
 *   { type: 'yt:ended',      currentTime: number, duration: number }
 *   { type: 'yt:error',      message: string }
 *   { type: 'yt:fullscreen', active: true }      ← intercept only (entry ask)
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
import { BackHandler, Platform, Pressable, StatusBar, Text, View } from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import { ArrowLeft } from 'lucide-react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { VideoWatermarkProps } from './VideoWatermark';
import { PLAYER_SCRIPT } from '../lib/plyr/playerScript';
import { PLYR_CSS, PLYR_JS } from '../lib/plyr/plyrBundle';
import {
  enterFullscreenSystemUi,
  exitFullscreenSystemUi,
} from '../lib/fullscreenSystemUi';

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
   * SECURITY GATE (fullscreen boundary): consulted right before the in-place
   * fullscreen expansion. Resolve/return false → fullscreen is refused
   * (the request is swallowed). Resolve/return true → allowed. Throwing also
   * refuses. Fail-closed.
   */
  shouldAllowFullscreen?: () => Promise<boolean> | boolean;
  /**
   * Identity watermark rendered INSIDE the player surface — one in-HTML
   * overlay injected by the player script (exactly one instance per active
   * player). Does not modify the YouTube iframe.
   */
  watermark?: VideoWatermarkProps;
  /**
   * Called when the player enters or exits fullscreen.
   * Useful for the host screen to adjust its own layout.
   */
  onFullscreen?: (active: boolean) => void;
}

// ─── URL normalization ────────────────────────────────────────────────────────

/**
 * Extract a validated 11-character YouTube video ID from a bare ID or any
 * standard YouTube URL format (watch, youtu.be, embed, shorts, live, m./music.
 * hosts, youtube-nocookie). Returns '' when the input is not a recognizable
 * YouTube video reference — callers must not pass arbitrary strings to the
 * embed (a garbage ID only produces a YouTube "invalid parameter" error).
 */
export function extractYouTubeVideoId(input: string): string {
  if (!input) return '';
  const trimmed = input.trim();
  // Bare 11-character video ID
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const isYouTubeHost =
      host === 'youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtube-nocookie.com' ||
      host === 'youtu.be';
    if (!isYouTubeHost) return '';
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id;
    }
    const v = url.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const pathMatch = url.pathname.match(/\/(?:embed|shorts|v|live)\/([A-Za-z0-9_-]{11})/);
    if (pathMatch) return pathMatch[1];
  } catch {
    // Not a valid URL — fall through to the empty rejection below.
  }
  return '';
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
  shouldAllowFullscreen,
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
      shouldAllowFullscreen={shouldAllowFullscreen}
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
  /**
   * SECURITY GATE (fullscreen boundary): called immediately before the
   * in-place fullscreen expansion. Return true → block (no expansion, no
   * escape hatch). Fail-closed: an omitted gate blocks nothing (gateless
   * surfaces are non-protected by design, e.g. marketing embeds); the lesson
   * screen ALWAYS supplies one. An exception thrown by the gate also blocks.
   */
  shouldAllowFullscreen?: () => Promise<boolean> | boolean;
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
  resumePosition: initialResume,
  onReady,
  onProgress,
  onEnd,
  onError,
  watermark,
  onFullscreen,
}: SubProps) {
  // RESUME LATCH: the initial resume position is captured ONCE per mount —
  // the iframe src (and its key identity) must NEVER change mid-session or
  // the player fully reloads (blank surface + position reset). Parent
  // re-renders pass a moving resumePosition; only the latched value is used.
  const resumeLatched = useRef(initialResume);
  const wmParams = watermark
    ? `&wname=${encodeURIComponent(watermark.name)}&wid=${encodeURIComponent(watermark.studentId)}`
    : '';
  const src = `/player/index.html?v=${encodeURIComponent(videoId)}&t=${resumeLatched.current}${wmParams}`;

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

// ─── Native sub-component — ONE WebView for the whole session ────────────────
//
// Fullscreen architecture (in-place, root-cause fix for rotation black screen):
//   • The inline WebView is NEVER remounted. Its container toggles between a
//     16:9 block and absolute-fill of the screen root. No Modal, no second
//     window, no second WebView — rotation only re-measures the container.
//   • Entry trigger: Plyr's own fullscreen button (the player script
//     intercepts the click in the capture phase and posts yt:fullscreen).
//     The gate runs first; a refusal swallows the request.
//   • Exit paths: the same Plyr button (toggle), the app back-arrow control,
//     and Android hardware back.
//   • Playback position is continuous by construction — the WebView keeps
//     playing through every transition; nothing to seek or restore.
//
// State handling:
//   lastTimeRef tracks progress continuously (single WebView → single stream).
//   inlineHtml is memoized so the WebView's source prop NEVER changes identity
//   between renders — a new HTML string would reload the WebView and tear
//   down the Plyr instance mid-playback (must not happen on any state change).

function YouTubePlayerNative({
  videoId,
  resumePosition: initialResume,
  onReady,
  onProgress,
  onEnd,
  onError,
  watermark,
  onFullscreen,
  shouldAllowFullscreen,
}: SubProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Live gate handle: the message handler below is registered once (stable
  // deps), so it reads the CURRENT gate function through a ref instead of a
  // captured stale closure. A gate mounted after the player (e.g. the
  // SecurityGate appearing over an open lesson) is therefore honored.
  const securityGateRef = useRef<(() => Promise<boolean> | boolean) | null>(null);
  useEffect(() => {
    securityGateRef.current = shouldAllowFullscreen ?? null;
  }, [shouldAllowFullscreen]);

  // Shared playback-position tracker — updated by the single WebView.
  const lastTimeRef      = useRef(initialResume);
  const wvRef            = useRef<WebView>(null);

  // ── Player HTML (memoized for the lifetime of the WebView) ─────────────────
  // NEVER rebuild after mount: any identity change in the source prop reloads
  // the WebView (hard player teardown). Deps: video identity + watermark +
  // initial resume only.
  // resumePosition is LATCHED to its initial value so the memo can never
  // fire mid-session (an identity change reloads the WebView — the blank
  // fullscreen surface class of bug) even if a host passes a moving value.
  const resumeLatched = useRef(initialResume);
  const playerHtml = useMemo(
    () => buildNativeHtml({
      videoId,
      resumeAt:      resumeLatched.current,
      watermarkName: watermark?.name,
      watermarkId:   watermark?.studentId,
      hideFullscreen: false,
    }),
    [videoId, watermark?.name, watermark?.studentId],
  );

  // ── Progress tracking ───────────────────────────────────────────────────────
  const handleProgress = useCallback(
    (ct: number, dur: number) => {
      lastTimeRef.current = ct;
      onProgress?.(ct, dur);
    },
    [onProgress],
  );

  // ── Fullscreen enter/exit (SAME WebView instance both ways) ─────────────────
  const exitFullscreen = useCallback(() => {
    setIsFullscreen(false);
  }, []);

  const enterFullscreen = useCallback(async () => {
    // ── SECURITY GATE AT THE FULLSCREEN BOUNDARY ─────────────────────────────
    // The fullscreen container is an in-place expansion rendered by the SAME
    // screen, but it must still re-validate the authoritative security verdict
    // before expanding. Fail-closed: refused gate, gate wired-but-undefined,
    // or a thrown evaluation error all swallow the request.
    try {
      const gate = securityGateRef.current;
      if (gate) {
        const allowed = await gate();
        if (!allowed) return; // blocked → swallow fullscreen request
      } else if (shouldAllowFullscreen) {
        return; // gate supplied but not yet wired → fail-closed
      }
    } catch {
      return; // evaluation error → fail-closed, no fullscreen
    }
    setIsFullscreen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live isFullscreen mirror for the stable message handler (declared before
  // onMessage so the closure never touches an uninitialized binding).
  const isFullscreenRef = useRef(isFullscreen);
  isFullscreenRef.current = isFullscreen;

  // ── WebView message handler (single stream from the single player) ─────────
  const onMessage = useCallback(
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
          break;
        case 'yt:paused':
          break;
        case 'yt:ended':
          onEnd?.();
          break;
        case 'yt:error':
          onError?.(msg.message ?? 'Playback error');
          break;
        case 'yt:fullscreen':
          // Entry ask from the Plyr fullscreen button (capture-phase intercept
          // in the player script). The same button toggles exit while
          // fullscreen, so an active:true message inside fullscreen collapses.
          if (msg.active) {
            if (isFullscreenRef.current) {
              exitFullscreen();
            } else {
              void enterFullscreen();
            }
          }
          break;
      }
    },
    [onReady, handleProgress, onEnd, onError, enterFullscreen, exitFullscreen],
  );

  // Forward enter/exit to the host screen (host may hide non-video chrome).
  useEffect(() => {
    onFullscreen?.(isFullscreen);
  }, [isFullscreen, onFullscreen]);

  // ── Orientation: responsive on iOS, Android landscape contract preserved ──
  // iOS: NO orientation API is touched. Entering fullscreen keeps the current
  // orientation (portrait stays portrait, landscape stays landscape), the
  // system Rotation Lock is never overridden, and a physical rotation while
  // fullscreen re-measures the SAME WebView container in place (app.json
  // now declares all iPhone orientations — the OS, not this code, rotates).
  // Android: the existing landscape fullscreen contract is preserved — the
  // Android Plyr fullscreen is DESIGNED for landscape (and PORTRAIT_UP is
  // restored on exit), so removing the lock would regress Android fullscreen.
  useEffect(() => {
    if (Platform.OS !== 'android' || !isFullscreen) return;
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE)
      .catch(() => {});
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP)
        .catch(() => {});
    };
  }, [isFullscreen]);

  // ── System bars (Issue 5) ──────────────────────────────────────────────────
  // While fullscreen: hide the nav bar (expo-navigation-bar → activity window)
  // and the status bar (<StatusBar hidden> below). Every exit path runs the
  // cleanup — both restore together.
  useEffect(() => {
    if (Platform.OS === 'web' || !isFullscreen) return;
    void enterFullscreenSystemUi();
    return () => {
      void exitFullscreenSystemUi();
    };
  }, [isFullscreen]);

  // ── Android hardware back collapses fullscreen ─────────────────────────────
  useEffect(() => {
    if (Platform.OS !== 'android' || !isFullscreen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      exitFullscreen();
      return true;
    });
    return () => sub.remove();
  }, [isFullscreen, exitFullscreen]);

  return (
    // In-place fullscreen container: when fullscreen, absolute-fill of the
    // SCREEN ROOT (the lesson screen hosts this player as a direct child of
    // its root View) — same window, same WebView, same Plyr instance, same
    // in-HTML watermark. Rotation only re-measures the container.
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
      <WebView
        ref={wvRef}
        source={{ html: playerHtml, baseUrl: 'https://medacademy.app' }}
        style={{ flex: 1, backgroundColor: '#000' }}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        // No native WebView fullscreen path can engage: Plyr never calls
        // requestFullscreen (capture-phase intercept), and the WebChromeClient
        // fullscreen support is disabled outright — RN owns fullscreen.
        allowsFullscreenVideo={false}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={['*']}
        onMessage={onMessage}
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
      />

      {/* EXIT-fullscreen control — back-arrow (same language as the VdoCipher
          and offline players). The Plyr fullscreen button ALSO exits (toggle
          in the message handler); this control guarantees a visible exit on
          both platforms. ≥44 pt touch target. */}
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
