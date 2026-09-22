/**
 * useNotificationPermission
 * ─────────────────────────────────────────────────────────────────────────────
 * Requests notification permission ONCE after the first successful login.
 *
 * Rules:
 *  • Never request on first launch / before login.
 *  • Request exactly once — tracked by an AsyncStorage key.
 *  • If denied, app continues working normally (push token won't be registered).
 *  • If permanently blocked, silently skip (no nagging).
 *
 * ANDROID 13+ NOTE (the bug this fixes):
 *  expo-notifications maps "notifications are not enabled" to status='denied'.
 *  On a FRESH Android 13+ install the OS dialog has never been shown, so
 *  areNotificationsEnabled() is false → status reads 'denied' WITH
 *  canAskAgain=true. That state is ASKABLE, not permanently denied — the old
 *  code treated every 'denied' as final, marked the permission as asked, and
 *  the OS notification dialog never appeared on Android 13+. The askable
 *  'denied' state must fall through to the rationale modal → OS dialog.
 *  Permanent denial is 'denied' + canAskAgain=false (or 'blocked').
 *
 * Usage (call inside the dashboard/home screen after successful navigation):
 *   const { triggerNotificationPermission, showRationale,
 *           setShowRationale, isBlocked, confirmRequest } =
 *       useNotificationPermission();
 *
 *   useFocusEffect(useCallback(() => { triggerNotificationPermission(); }, []));
 *
 *   <PermissionRationaleModal
 *     type="notifications"
 *     visible={showRationale}
 *     isBlocked={isBlocked}
 *     onConfirm={confirmRequest}
 *     onDismiss={() => setShowRationale(false)}
 *   />
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { usePermission } from './usePermission';

const NOTIF_ASKED_KEY = 'medacademy:notif_permission_asked';

export function useNotificationPermission() {
  const base = usePermission('notifications');

  /**
   * Call this once per login session (e.g. in useFocusEffect on the home/dashboard screen).
   * It will request the permission only if it has never been asked before.
   */
  const triggerNotificationPermission = async () => {
    // Web: no-op
    if (Platform.OS === 'web') return;

    // Already asked once — never ask again
    const alreadyAsked = await AsyncStorage.getItem(NOTIF_ASKED_KEY);
    if (alreadyAsked) return;

    // Ask the authoritative native status.
    //   granted                          → user already allowed (e.g. re-enabled
    //                                      in Settings) — just mark asked; push
    //                                      registration happens in the login flow.
    //   denied  + canAskAgain=true       → ASKABLE (fresh Android 13+ install, or
    //                                      a previous soft denial) — show the
    //                                      rationale modal; confirming it triggers
    //                                      the real OS dialog.
    //   denied  + canAskAgain=false      → permanently denied — mark asked, no nag.
    //   blocked / undetermined-else      → treat as permanently denied.
    const { status, canAskAgain } = await Notifications.getPermissionsAsync();

    if (status === 'granted') {
      await AsyncStorage.setItem(NOTIF_ASKED_KEY, '1');
      return;
    }

    // getPermissionsAsync's non-granted union is UNDETERMINED | DENIED. In both
    // states canAskAgain is the authoritative askability signal: fresh Android
    // 13+ installs and soft denials report canAskAgain=true (ASKABLE — the old
    // code missed this and never showed the OS dialog); permanent denial
    // reports canAskAgain=false.
    const askable = canAskAgain;

    if (!askable) {
      // Permanently denied — never nag again.
      await AsyncStorage.setItem(NOTIF_ASKED_KEY, '1');
      return;
    }

    // Askable — show the rationale modal once. Confirming it calls
    // base.confirmRequest() → Notifications.requestPermissionsAsync() → the OS
    // dialog on Android 13+ / the iOS authorization prompt. If the user then
    // denies permanently, usePermission flips to the isBlocked → Settings path.
    await AsyncStorage.setItem(NOTIF_ASKED_KEY, '1');
    base.setShowRationale(true);
  };

  return {
    triggerNotificationPermission,
    showRationale: base.showRationale,
    setShowRationale: base.setShowRationale,
    isBlocked: base.isBlocked,
    confirmRequest: base.confirmRequest,
  };
}
