/**
 * permissions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Central permission management for MedAcademy.
 *
 * Design principles (WhatsApp / Telegram / Google Classroom UX):
 *  1. Request only when the user triggers an action that actually needs it.
 *  2. Show a custom rationale BEFORE the OS dialog (explain WHY).
 *  3. Never repeatedly ask — if denied, offer Settings link only.
 *  4. Permanent denial ("Don't ask again") → open Settings, never re-prompt.
 *  5. App continues working normally if any permission is denied.
 *
 * Platform notes:
 *  - Android 13+: READ_MEDIA_IMAGES / READ_MEDIA_VIDEO (not READ_EXTERNAL_STORAGE)
 *  - iOS: shows NSPhoto/Camera/Microphone/Notification usage descriptions from app.json
 *  - Web: all requests are no-ops (return 'granted' where possible)
 */

import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PermissionType =
  | 'camera'
  | 'mediaLibrary'
  | 'notifications'
  | 'microphone';

export type PermissionStatus = 'granted' | 'denied' | 'blocked' | 'unavailable';

export interface PermissionResult {
  status: PermissionStatus;
  /** true when the OS will no longer show the system dialog (permanent denial) */
  canAskAgain: boolean;
}

export interface RationaleConfig {
  title: string;
  message: string;
  /** Label for the confirm button (default "Allow") */
  confirmLabel?: string;
  /** Label for the deny button (default "Not Now") */
  denyLabel?: string;
}

/** Configs keyed by PermissionType — used by usePermission / PermissionRationaleModal */
export const PERMISSION_RATIONALES: Record<PermissionType, RationaleConfig> = {
  notifications: {
    title: '🔔 Stay Up to Date',
    message:
      'MedAcademy will notify you about new lectures, assignments, exams, course updates, and messages — so you never miss important content.',
    confirmLabel: 'Allow Notifications',
    denyLabel: 'Not Now',
  },
  mediaLibrary: {
    title: '🖼️ Access Your Photos',
    message:
      'To upload a profile picture or course image, MedAcademy needs access to your photo library.',
    confirmLabel: 'Allow Access',
    denyLabel: 'Not Now',
  },
  camera: {
    title: '📷 Camera Access',
    message:
      'To take a profile photo or capture a course image, MedAcademy needs access to your camera.',
    confirmLabel: 'Allow Camera',
    denyLabel: 'Not Now',
  },
  microphone: {
    title: '🎙️ Microphone Access',
    message:
      'To record audio messages or voice lectures, MedAcademy needs access to your microphone.',
    confirmLabel: 'Allow Microphone',
    denyLabel: 'Not Now',
  },
};

// ─── Core permission checkers (no UI, no rationale) ──────────────────────────

/** Check current status without requesting. Web always returns 'granted'. */
export async function checkPermission(type: PermissionType): Promise<PermissionResult> {
  if (Platform.OS === 'web') return { status: 'granted', canAskAgain: false };

  switch (type) {
    case 'camera': {
      const { status, canAskAgain } = await ImagePicker.getCameraPermissionsAsync();
      return { status: normalise(status), canAskAgain };
    }
    case 'mediaLibrary': {
      const { status, canAskAgain } = await ImagePicker.getMediaLibraryPermissionsAsync();
      return { status: normalise(status), canAskAgain };
    }
    case 'notifications': {
      const { status, canAskAgain } = await Notifications.getPermissionsAsync();
      return { status: normalise(status), canAskAgain };
    }
    case 'microphone': {
      // expo-av / expo-audio not installed yet — microphone permission
      // will be wired when audio recording screens are added.
      // The try/catch safely no-ops when the module is absent.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { Audio } = require('expo-av') as any;
        const { status, canAskAgain } = await Audio.getPermissionsAsync();
        return { status: normalise(status as string), canAskAgain: canAskAgain as boolean };
      } catch {
        return { status: 'unavailable', canAskAgain: false };
      }
    }
  }
}

/**
 * Request permission directly (no rationale UI).
 * Call this ONLY after the user has already seen the rationale modal.
 */
export async function requestPermission(type: PermissionType): Promise<PermissionResult> {
  if (Platform.OS === 'web') return { status: 'granted', canAskAgain: false };

  switch (type) {
    case 'camera': {
      const { status, canAskAgain } = await ImagePicker.requestCameraPermissionsAsync();
      return { status: normalise(status), canAskAgain };
    }
    case 'mediaLibrary': {
      const { status, canAskAgain } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      return { status: normalise(status), canAskAgain };
    }
    case 'notifications': {
      const { status, canAskAgain } = await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true,
          allowCriticalAlerts: false,
          provideAppNotificationSettings: false,
        },
      });
      return { status: normalise(status), canAskAgain };
    }
    case 'microphone': {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { Audio } = require('expo-av') as any;
        const { status, canAskAgain } = await Audio.requestPermissionsAsync();
        return { status: normalise(status as string), canAskAgain: canAskAgain as boolean };
      } catch {
        return { status: 'unavailable', canAskAgain: false };
      }
    }
  }
}

// ─── Settings redirect ────────────────────────────────────────────────────────

/** Open the OS Settings page for this app (works on iOS + Android). */
export async function openAppSettings(): Promise<void> {
  if (Platform.OS === 'web') return;
  await Linking.openSettings();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalise(status: string): PermissionStatus {
  if (status === 'granted') return 'granted';
  if (status === 'denied') return 'denied';
  // expo-image-picker uses "limited" on iOS 14+ (partial access) — treat as granted
  if (status === 'limited') return 'granted';
  if (status === 'blocked' || status === 'restricted') return 'blocked';
  return 'unavailable';
}
