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
  type UpdateState,
} from '@/lib/updateConfigService';

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
