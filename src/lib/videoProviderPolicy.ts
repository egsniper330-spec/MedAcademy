/**
 * VIDEO PROVIDER POLICY — the ONE authoritative client-side implementation of
 * effective provider availability. Backend remains the enforcement authority
 * (VideoProviderPolicyService — /video/otp, /video/offline-authorize,
 * /video/upload-init and the lessons write path all re-check server-side);
 * this module only mirrors the SAME decision so the UI can hide/disable
 * unavailable providers before a user ever attempts them.
 *
 * Providers are the application's REAL ones (never invented):
 *   plyr       — YouTube/Plyr playback path   (lessons.video_type = 'youtube')
 *   vdocipher  — VdoCipher DRM playback path  (lessons.video_type = 'vdocipher')
 *
 * Three-state override (identical semantics to the backend):
 *   'inherit'  → the GLOBAL default decides
 *   'enabled'  → explicitly allowed (even when globally OFF)
 *   'disabled' → explicitly blocked (even when globally ON)
 *
 *   effective = override === 'enabled'  ? true
 *             : override === 'disabled' ? false
 *             : globalEnabled
 *
 * Fail-open: a missing/unknown provider key resolves ENABLED — a broken or
 * partial policy payload can never silently take video capability away.
 */

export const VIDEO_PROVIDER_KEYS = ['plyr', 'vdocipher'] as const;
export type VideoProviderKey = (typeof VIDEO_PROVIDER_KEYS)[number];

export type ProviderOverride = 'inherit' | 'enabled' | 'disabled';

export type GlobalProviderState = {
  provider_key: string;
  display_name: string;
  is_globally_enabled: boolean;
};

export type ProviderPermission = {
  provider_key: string;
  display_name: string;
  global_enabled: boolean;
  override: ProviderOverride;
  teacher_enabled: boolean;
  final_enabled: boolean;
};

/** THE effective-state rule. Never duplicated in screens. */
export function effectiveProviderState(
  globalEnabled: boolean,
  override: ProviderOverride | null | undefined,
): boolean {
  if (override === 'enabled') return true;
  if (override === 'disabled') return false;
  return globalEnabled;
}

/** Legacy boolean teacher_enabled → three-state override (global context). */
export function overrideFromBooleans(
  globalEnabled: boolean,
  teacherEnabled: boolean | null | undefined,
): ProviderOverride {
  if (teacherEnabled === null || teacherEnabled === undefined) return 'inherit';
  if (teacherEnabled === globalEnabled) return 'inherit';
  return teacherEnabled ? 'enabled' : 'disabled';
}

/** Unknown/missing keys fail OPEN — never silently disable a provider. */
export function isProviderKey(k: string): k is VideoProviderKey {
  return (VIDEO_PROVIDER_KEYS as readonly string[]).includes(k);
}

/** lessons.video_type → provider key (mirror of the backend VIDEO_TYPE_MAP). */
export function providerForVideoType(videoType: string | null | undefined): VideoProviderKey | null {
  switch (videoType) {
    case 'vdocipher': return 'vdocipher';
    case 'youtube':   return 'plyr';
    default:          return null; // 'coming_soon' etc. — not a real provider
  }
}

/**
 * True ONLY for the structured policy refusal `video_provider_disabled`
 * (HTTP 403 from VideoProviderPolicyService::assertProviderAllowed).
 *
 * A DISABLED PROVIDER IS NOT A FAILURE — it is a deliberate administrator
 * setting. Screens must branch on this so they render an unavailable-feature
 * state instead of a generic "Save failed." error. Genuine authorization 403s
 * ("not your course") and every other error class return false and keep their
 * own messages.
 */
export function isProviderDisabledError(e: unknown): boolean {
  const err = e as { message?: string; code?: string; status?: number } | undefined;
  if (!err) return false;
  if (err.code === 'video_provider_disabled') return true;
  // Some transports surface only the status + canonical provider message.
  return err.status === 403 && typeof err.message === 'string'
    && err.message.toLowerCase().includes('video player is currently unavailable');
}

/**
 * Classify a policy refusal from the backend into a user-facing message.
 * ONLY the structured code `video_provider_disabled` maps to the friendly
 * provider notice.
 */
export function describeProviderError(e: unknown): string {
  if (isProviderDisabledError(e)) {
    return 'This video player is currently unavailable. Please choose another available player.';
  }
  const err = e as { message?: string } | undefined;
  return err?.message ?? 'Video player unavailable. Please try again later.';
}
