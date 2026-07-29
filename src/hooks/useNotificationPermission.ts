/**
 * useNotificationPermission
 * ─────────────────────────────────────────────────────────────────────────────
 * Requests notification permission ONCE after the first successful login.
 *
 * Rules:
 *  • Never request on first launch / before login.
 *  • Request exactly once — tracked by AsyncStorage key.
 *  • If denied, app continues working normally (push token won't be registered).
 *  • If permanently blocked, silently skip (no nagging).
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

    // Already granted (user may have enabled it in Settings) — just register token
    const { status } = await Notifications.getPermissionsAsync();
    if (status === 'granted') {
      await AsyncStorage.setItem(NOTIF_ASKED_KEY, '1');
      return;
    }

    // Permanently denied — don't nag
    if (status === 'denied') {
      await AsyncStorage.setItem(NOTIF_ASKED_KEY, '1');
      return;
    }

    // Show rationale modal (will trigger OS dialog when user confirms)
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
