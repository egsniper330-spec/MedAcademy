/**
 * vdocipher-rn-bridge.d.ts
 *
 * Ambient module declaration for vdocipher-rn-bridge.
 *
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * vdocipher-rn-bridge v2.0.0 ships TypeScript source files (.tsx) instead of
 * pre-compiled declaration files (.d.ts).  When TypeScript follows our import
 * into the package it encounters two genuine type errors in VdoPlayerView.tsx
 * (lines 46-47: `style?.resizeMode` on a StyleProp<ViewStyle> union) that
 * cause the build to fail even though they have no runtime effect.
 *
 * This ambient declaration overrides the package's source types, giving
 * TypeScript a clean, minimal surface to check against.  The module still
 * resolves to the real package at runtime — only static type-checking is
 * redirected here.
 *
 * WHAT IS DECLARED
 * ─────────────────────────────────────────────────────────────────────────────
 * Only the types used by VdoCipherPlayerNativeAdapter.native.tsx are declared.
 * The full VdoPlayerView public API (seek, quality, captions, downloads) is
 * omitted because this project does not use those features in Phase 1.
 * If additional API surface is needed in later phases, extend this file.
 */

declare module 'vdocipher-rn-bridge' {
  import React from 'react';
  import { StyleProp, ViewStyle } from 'react-native';

  // ── EmbedInfo ────────────────────────────────────────────────────────────

  export interface OtpEmbedInfo {
    otp: string;
    playbackInfo: string;
    enableAutoResume?: boolean | null;
    resumeTimeMs?: number | null;
    preferredCaptionsLanguage?: string | null;
    customPlayerId?: string | null;
    forceLowestBitrate?: boolean | null;
    forceHighestSupportedBitrate?: boolean | null;
    maxVideoBitrateKbps?: number | null;
    clipStartInMs?: number | null;
    clipEndInMs?: number | null;
    clipped?: boolean | null;
    clipMarkerColor?: string | null;
    allowAdbDebugging?: boolean;
  }

  export interface TokenEmbedInfo {
    token: string;
    mediaId: string;
    enableAutoResume?: boolean | null;
    resumeTimeMs?: number | null;
  }

  export type EmbedInfo = OtpEmbedInfo | TokenEmbedInfo;

  export interface OfflineEmbedInfo {
    offline: boolean;
    mediaId: string;
    enableAutoResume?: boolean | null;
    resumeTimeMs?: number | null;
  }

  // ── MediaInfo ─────────────────────────────────────────────────────────────

  export interface MediaInfo {
    mediaId: string;
    type: string;
    title: string;
    description: string;
    /** Duration in milliseconds */
    duration: number;
  }

  // ── ErrorDescription ──────────────────────────────────────────────────────

  export interface ErrorDescription {
    errorCode: number;
    errorMsg: string;
    httpStatusCode: number;
  }

  // ── VdoPlayerView props ───────────────────────────────────────────────────

  export interface VdoPlayerViewProps {
    embedInfo: EmbedInfo | OfflineEmbedInfo;
    showNativeControls?: boolean;
    autoPlay?: boolean;
    style?: StyleProp<ViewStyle>;
    onInitializationSuccess?: (event: { restored: boolean }) => void;
    onInitializationFailure?: (event: { errorDescription: ErrorDescription }) => void;
    onLoading?: (event: { embedInfo: EmbedInfo | OfflineEmbedInfo }) => void;
    onLoaded?: (event: { embedInfo: EmbedInfo | OfflineEmbedInfo; mediaInfo: MediaInfo }) => void;
    onLoadError?: (event: { embedInfo: EmbedInfo | OfflineEmbedInfo; errorDescription: ErrorDescription }) => void;
    onPlayerStateChanged?: (event: { playWhenReady: boolean; playerState: string }) => void;
    /** currentTime is in milliseconds */
    onProgress?: (event: { currentTime: number }) => void;
    onBufferUpdate?: (event: { bufferTime: number }) => void;
    onPlaybackSpeedChanged?: (playbackSpeed: number) => void;
    onMediaEnded?: (event: { embedInfo: EmbedInfo | OfflineEmbedInfo }) => void;
    onError?: (event: { embedInfo: EmbedInfo | OfflineEmbedInfo; errorDescription: ErrorDescription }) => void;
    onEnterFullscreen?: () => void;
    onExitFullscreen?: () => void;
    onPictureInPictureModeChanged?: (event: { isInPictureInPictureMode: boolean }) => void;
  }

  // ── Component export ──────────────────────────────────────────────────────

  export class VdoPlayerView extends React.Component<VdoPlayerViewProps> {}
  export default VdoPlayerView;
}
