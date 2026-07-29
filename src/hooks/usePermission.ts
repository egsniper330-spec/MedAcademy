/**
 * usePermission
 * ─────────────────────────────────────────────────────────────────────────────
 * Hook that manages the full permission lifecycle for a single permission type:
 *
 *   1. Check current status (no prompt).
 *   2. If not granted → signal the caller to show the rationale modal
 *      (PermissionRationaleModal).
 *   3. After user confirms → call requestPermission().
 *   4. If permanently blocked → offer "Open Settings".
 *   5. Never repeatedly prompt on denial.
 *
 * Usage:
 *   const { ensurePermission, showRationale, setShowRationale,
 *           isBlocked, confirmRequest } = usePermission('mediaLibrary');
 *
 *   // In your action handler:
 *   const granted = await ensurePermission();
 *   if (!granted) return;  // rationale modal will show automatically
 *
 *   // In JSX:
 *   <PermissionRationaleModal
 *     type="mediaLibrary"
 *     visible={showRationale}
 *     isBlocked={isBlocked}
 *     onConfirm={confirmRequest}
 *     onDismiss={() => setShowRationale(false)}
 *   />
 */

import { useCallback, useState } from 'react';
import {
  checkPermission,
  openAppSettings,
  requestPermission,
  type PermissionType,
} from '@/lib/permissions';

export interface UsePermissionReturn {
  /** Call this when an action needs the permission. Returns true if granted. */
  ensurePermission: () => Promise<boolean>;
  /** Whether the rationale/settings modal should be shown */
  showRationale: boolean;
  setShowRationale: (v: boolean) => void;
  /** True when permission is permanently blocked (must go to Settings) */
  isBlocked: boolean;
  /**
   * Call this after the user taps "Allow" in the rationale modal.
   * Triggers the OS dialog (or opens Settings if blocked).
   * Returns true if ultimately granted.
   */
  confirmRequest: () => Promise<boolean>;
}

export function usePermission(type: PermissionType): UsePermissionReturn {
  const [showRationale, setShowRationale] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);

  const ensurePermission = useCallback(async (): Promise<boolean> => {
    const current = await checkPermission(type);

    if (current.status === 'granted') return true;

    // Permanently blocked — show settings prompt, not OS dialog
    if (current.status === 'blocked' || !current.canAskAgain) {
      setIsBlocked(true);
      setShowRationale(true);
      return false;
    }

    // Can still ask — show rationale first
    setIsBlocked(false);
    setShowRationale(true);
    return false;
  }, [type]);

  const confirmRequest = useCallback(async (): Promise<boolean> => {
    setShowRationale(false);

    if (isBlocked) {
      await openAppSettings();
      return false;
    }

    const result = await requestPermission(type);

    if (result.status === 'granted') return true;

    // Became permanently blocked after this request
    if (!result.canAskAgain) {
      setIsBlocked(true);
      setShowRationale(true);
    }

    return false;
  }, [type, isBlocked]);

  return { ensurePermission, showRationale, setShowRationale, isBlocked, confirmRequest };
}
