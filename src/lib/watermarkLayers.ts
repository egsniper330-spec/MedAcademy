/**
 * watermarkLayers.ts
 *
 * ONE place that decides WHICH watermark layer is rendered for a given
 * playback session, so the two players (native SDK adapter, WebView player)
 * can never drift apart on a decision that is security-relevant.
 *
 * ── THE TWO LAYERS ───────────────────────────────────────────────────────────
 *
 *   PROVIDER  — VdoCipher's server-side `annotate` (`type: rtext`), attached to
 *               the ONLINE OTP by backend/src/Video/VdoCipherService.php
 *               (`buildAnnotate`). It is burned into the DRM-protected stream
 *               server-side: present in fullscreen, survives any React Native
 *               view re-parenting, and cannot be removed by a client-side DOM
 *               or view manipulation. This is the STRONGEST layer available
 *               and is always preferred whenever it actually renders.
 *
 *   APP       — `NativeWatermarkOverlay`, a React Native sibling view drawn
 *               over the player. It is an application-rendered overlay: a
 *               modified client can hide it. It exists as the availability
 *               layer where the provider layer cannot be relied upon, and it
 *               is the ONLY layer that can carry the requested continuous
 *               billiard motion (see watermarkMotion.ts).
 *
 * The contract with the server: the OTP response carries `annotateApplied`.
 * When it is TRUE the provider layer is present in the session, and the app
 * renders its own overlay only if this module says the provider layer does not
 * actually render on this platform/player. That "exactly one visible
 * watermark" rule is the anti-duplication contract introduced when the provider
 * annotate was (re)added — a regression back to two watermarks at once is
 * explicitly guarded by tests.
 *
 * ── WHY THIS IS PLATFORM-AWARE (THE ANDROID ABSENCE) ────────────────────────
 *
 * The OTP is byte-identical for every platform, so `annotateApplied` alone
 * cannot describe what a player will draw. The reported production state is:
 *
 *   • iOS native  — the watermark IS visible (its defects are separate:
 *                   multi-line `text` overflowing the frame, and the 2 s
 *                   `skip` gap making it vanish periodically — both defects
 *                   of the PROVIDER layer, see DEPLOYMENT NOTE below).
 *   • Android     — NO watermark at all, under those same OTP settings.
 *
 * With `annotateApplied === true` this app suppressed its own overlay on both
 * platforms, so on Android neither layer was left: exactly the reported
 * "does not appear at all". The only consistent reading is that the Android
 * native SDK path does not render the provider `rtext` annotation (the
 * WebView/iframe player does — it is the web player). Hence:
 *
 *   android + native SDK  → APP layer is rendered even when annotateApplied,
 *                           because the provider layer is not drawing.
 *
 * ⚠ LIMITATION STATED PLAINLY, NOT HIDDEN:
 *   If a future Android SDK release starts rendering the provider annotation,
 *   Android would show two watermarks. The rule is a SINGLE named constant
 *   below (flip it, one line) and a device run confirms it — the app logs
 *   which layer is active (dimensions/state only, never tokens) under VDO_WM_*.
 *   This decision was derived from the reported production behaviour; it has
 *   NOT been re-confirmed on a physical Android device in this change.
 *
 * ── DEPLOYMENT NOTE (not applied here — backend file listed in the report) ──
 * `buildAnnotate()` joins the name and `ID: MED-####` with a literal "\n"
 * (the docs say multi-line marks need one `rtext` object per line) and passes
 * `'skip' => '2000'`, which is 2000 ms HIDDEN every cycle — both explain the
 * reported iOS clipping/disappearance of the provider mark. Fixing it requires
 * a backend change, so this module deliberately does NOT depend on it.
 */

/** The platform being rendered on. */
export type WatermarkPlatform = 'android' | 'ios' | 'web';

/**
 * Which renderer draws the player.
 *  - 'native'   — vdocipher-rn-bridge VdoPlayerView (Android/iOS).
 *  - 'webview'  — WebView/iframe VdoCipher player (web always; also the
 *                 rollback path when USE_NATIVE_VDOCIPHER_PLAYER is false).
 */
export type WatermarkPlayerKind = 'native' | 'webview';

export interface WatermarkLayersInput {
  /** Platform of the running app. */
  platform: WatermarkPlatform;
  /** Renderer the session is using. */
  playerKind: WatermarkPlayerKind;
  /** True when the OTP carried the provider's `annotate` payload. */
  annotateApplied: boolean;
  /**
   * True when a renderable identity (public MED-#### id) resolved for this
   * session. Without one the app overlay has nothing to print, so it is never
   * rendered speculatively.
   */
  hasIdentity: boolean;
}

export interface WatermarkLayers {
  /**
   * True when the provider's burned-in annotation is EXPECTED to be visible
   * in this session. This app does not draw its own mark on top of it.
   */
  providerAnnotationVisible: boolean;
  /**
   * True when the app overlay must be rendered. It is the only watermark the
   * viewer will see.
   */
  appOverlay: boolean;
  /**
   * Why this combination was chosen — surfaced in diagnostics so a device run
   * can be read without re-deriving the policy. Never contains identity data.
   */
  reason: WatermarkLayerReason;
}

export type WatermarkLayerReason =
  | 'provider_only'        // provider layer renders → app overlay suppressed
  | 'app_only_annotate_off' // server did not attach annotate → app overlay
  | 'app_only_android_native' // Android native SDK does not draw provider annotate
  | 'none_no_identity';     // no identity and no provider mark (can't print)

/**
 * THE single switch for the Android native rule above.
 *
 * true  → Android native draws the provider annotation (future SDK) and the
 *         app overlay stays suppressed.
 * false → Android native does not draw it, so the app overlay is rendered.
 *
 * Flip after verifying on a physical Android device that the provider `rtext`
 * annotation is visible under a session with annotateApplied === true.
 */
export const ANDROID_NATIVE_RENDERS_PROVIDER_ANNOTATE = false;

/**
 * Whether the provider `rtext` annotation can be relied upon to render.
 *
 *  - webview/iframe → yes: this IS the VdoCipher web player, whose renderer
 *    draws `rtext` (per VdoCipher's own watermark documentation the moving
 *    watermark works on web and on mobile apps; static `text` is web-only).
 *  - iOS native     → yes: reported as visibly rendered in production.
 *  - Android native → gated by ANDROID_NATIVE_RENDERS_PROVIDER_ANNOTATE.
 */
export function providerAnnotationRenders(
  platform: WatermarkPlatform,
  playerKind: WatermarkPlayerKind,
): boolean {
  if (playerKind === 'webview') return true;
  if (platform === 'android') return ANDROID_NATIVE_RENDERS_PROVIDER_ANNOTATE;
  // ios native
  return true;
}

/** Decide which watermark layers this session renders. Pure and total. */
export function resolveWatermarkLayers(input: WatermarkLayersInput): WatermarkLayers {
  const providerPossible = input.annotateApplied;
  const providerVisible = providerPossible
    && providerAnnotationRenders(input.platform, input.playerKind);

  if (providerVisible) {
    // Anti-duplication: exactly one visible watermark.
    return {
      providerAnnotationVisible: true,
      appOverlay: false,
      reason: 'provider_only',
    };
  }

  if (!input.hasIdentity) {
    // No provider mark and nothing printable — the OTP response itself still
    // carries the provider layer only when the server had an identity, so this
    // combination means genuinely no watermark. Never fabricate one.
    return {
      providerAnnotationVisible: false,
      appOverlay: false,
      reason: 'none_no_identity',
    };
  }

  if (providerPossible) {
    // The provider attached annotate but this platform/player will not draw
    // it — Android native. The app overlay must cover, or the viewer sees
    // nothing at all.
    return {
      providerAnnotationVisible: false,
      appOverlay: true,
      reason: 'app_only_android_native',
    };
  }

  return {
    providerAnnotationVisible: false,
    appOverlay: true,
    reason: 'app_only_annotate_off',
  };
}
