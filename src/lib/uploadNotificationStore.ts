/**
 * uploadNotificationStore.ts
 *
 * Persistent Zustand store for in-app upload event notifications.
 * Separate from the upload queue store — this is the notification HISTORY
 * (bell icon center), not the live upload queue (FAB).
 *
 * Lifecycle:
 *  - addNotification(n)  — upserts by (uploadId, type); updates existing entry
 *                          so progress toasts replace each other instead of stacking
 *  - markAllRead()       — sets unreadCount = 0, stamps all as read
 *  - clearAll()          — wipes entire history
 *
 * Max 100 notifications kept (oldest pruned on overflow).
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type NotificationType =
  | 'upload_started'
  | 'upload_progress'
  | 'upload_paused'
  | 'upload_resumed'
  | 'upload_completed'   // all chunks uploaded — now processing
  | 'processing'
  | 'video_ready'
  | 'upload_failed'
  | 'processing_timeout';

export interface UploadNotification {
  id: string;           // unique notification id (uploadId + type)
  uploadId: string;
  type: NotificationType;
  fileName: string;
  message: string;       // user-visible text
  progress?: number;     // 0-100, only for upload_progress
  errorMessage?: string; // sanitized error for failed
  timestamp: number;     // Date.now()
  read: boolean;
}

interface UploadNotificationState {
  notifications: UploadNotification[];
  unreadCount: number;
  addNotification: (n: Omit<UploadNotification, 'id' | 'read' | 'timestamp'>) => void;
  markAllRead: () => void;
  clearAll: () => void;
}

const MAX_NOTIFICATIONS = 100;

export const useUploadNotificationStore = create<UploadNotificationState>()(
  persist(
    (set) => ({
      notifications: [],
      unreadCount: 0,

      addNotification: (n) =>
        set((s) => {
          const id = `${n.uploadId}__${n.type}`;
          const existing = s.notifications.findIndex((x) => x.id === id);
          const entry: UploadNotification = {
            ...n,
            id,
            read: false,
            timestamp: Date.now(),
          };

          let next: UploadNotification[];
          if (existing !== -1) {
            // Replace in-place so order is stable; bump timestamp
            next = s.notifications.map((x) => (x.id === id ? entry : x));
          } else {
            next = [entry, ...s.notifications];
          }
          // Prune oldest beyond cap
          if (next.length > MAX_NOTIFICATIONS) {
            next = next.slice(0, MAX_NOTIFICATIONS);
          }
          const unreadCount = next.filter((x) => !x.read).length;
          return { notifications: next, unreadCount };
        }),

      markAllRead: () =>
        set((s) => ({
          notifications: s.notifications.map((x) => ({ ...x, read: true })),
          unreadCount: 0,
        })),

      clearAll: () => set({ notifications: [], unreadCount: 0 }),
    }),
    {
      name: 'medacademy-upload-notifications',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

// ─── Convenience helper callable outside React (from useVideoUploader.ts) ────
export function pushNotification(
  n: Omit<UploadNotification, 'id' | 'read' | 'timestamp'>,
): void {
  useUploadNotificationStore.getState().addNotification(n);
}
