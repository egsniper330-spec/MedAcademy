/**
 * useForceUpdate — React binding for the authoritative update state.
 *
 * The single source of truth is src/lib/updateConfigService.ts (fetches the
 * remote config, evaluates versionCode, intercepts server-side HTTP 426).
 * This hook only mirrors that state into React and exposes actions.
 */

import { useSyncExternalStore } from 'react';

import {
  getUpdateState,
  subscribeUpdateState,
  checkAppUpdate,
  openUpdateUrl,
  getInstalledVersionName,
  getInstalledVersionCode,
  getUpdateGateDecision,
  type UpdateState,
} from '@/lib/updateConfigService';
import type { UpdateGateDecision } from '@/lib/securityStateModel';

export interface UseUpdateResult {
  verdict: UpdateState['verdict'];
  mode: UpdateState['mode'];
  evaluating: boolean;
  usingCachedVerdict: boolean;
  installedVersionName: string;
  installedVersionCode: number;
  latestVersionName: string;
  latestVersionCode: number;
  minimumVersionCode: number;
  updateUrl: string;
  releaseNotes: string | null;
  /** Convenience: forced gate active (no app access). */
  blocked: boolean;
  /**
   * The authoritative gate decision for the PROTECTED (authenticated) shell.
   * 'pending'/'required' mean protected content must not render; the startup and
   * sign-in surfaces are never gated (see resolveUpdateGateDecision).
   */
  protectedDecision: UpdateGateDecision;
  /** True when the version check has not produced a verdict yet. */
  pendingVerdict: boolean;
  /** Re-run the remote check now. */
  recheck: () => Promise<void>;
  /** Open the configured update destination externally. */
  openUpdateUrl: () => Promise<{ ok: boolean; error?: string }>;
  /** OPTIONAL mode: dismiss the banner for this foreground session. */
  dismissOptional: () => void;
}

let dismissedThisSession = false;

export function useUpdate(): UseUpdateResult {
  const state = useSyncExternalStore(subscribeUpdateState, getUpdateState, getUpdateState);

  // Derived from the SAME store read this render is based on, so the decision
  // can never lag the state it describes (no effect, no extra render).
  const protectedDecision = getUpdateGateDecision(true);
  const pendingVerdict = state.verdict === 'UNKNOWN' && state.evaluating;

  const optionalDismissed =
    state.verdict === 'UPDATE_REQUIRED' &&
    state.mode === 'OPTIONAL' &&
    dismissedThisSession;

  return {
    verdict: state.verdict,
    mode: state.mode,
    evaluating: state.evaluating,
    usingCachedVerdict: state.usingCachedVerdict,
    installedVersionName: state.installedVersionName || getInstalledVersionName(),
    installedVersionCode: state.installedVersionCode || getInstalledVersionCode(),
    latestVersionName: state.latestVersionName,
    latestVersionCode: state.latestVersionCode,
    minimumVersionCode: state.minimumVersionCode,
    updateUrl: state.updateUrl,
    releaseNotes: state.releaseNotes,
    blocked: state.verdict === 'UPDATE_REQUIRED' && !optionalDismissed,
    protectedDecision,
    pendingVerdict,
    recheck: async () => {
      void (await checkAppUpdate());
    },
    openUpdateUrl: () => openUpdateUrl(state.updateUrl),
    dismissOptional: () => {
      dismissedThisSession = true;
      // No state change needed; consumers re-render on their own trigger.
      // Force a notification so gates re-evaluate immediately.
      subscribeEmit();
    },
  };
}

// Tiny internal nudge so dismissOptional re-renders consumers.
const extraListeners = new Set<() => void>();
function subscribeEmit(): void {
  extraListeners.forEach((l) => l());
}
