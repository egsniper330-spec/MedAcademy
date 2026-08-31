/**
 * uploadQueueStore.ts
 * Zustand store for the global video upload queue.
 * Persists to AsyncStorage via zustand/middleware so the queue survives app restarts.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { type UploadStatus, type UploadTask } from './videoUploadEngine';

// Runtime-only map: uploadId → XHR instance (not serializable)
const xhrMap = new Map<string, XMLHttpRequest>();

export function setXhr(id: string, xhr: XMLHttpRequest) { xhrMap.set(id, xhr); }
export function getXhr(id: string): XMLHttpRequest | undefined { return xhrMap.get(id); }
export function removeXhr(id: string) { xhrMap.delete(id); }

// Runtime-only map: uploadId → AbortController for chunked uploads
const abortMap = new Map<string, AbortController>();

export function setAbortController(id: string, ac: AbortController) { abortMap.set(id, ac); }
export function getAbortController(id: string): AbortController | undefined { return abortMap.get(id); }
export function removeAbortController(id: string) { abortMap.delete(id); }

interface UploadQueueState {
  tasks: UploadTask[];
  // Recovery: whether we've checked interrupted tasks on this launch
  recoveryChecked: boolean;
  setRecoveryChecked: (v: boolean) => void;
  // Queue mutation
  addTask: (task: UploadTask) => void;
  updateTask: (id: string, patch: Partial<UploadTask>) => void;
  removeTask: (id: string) => void;
  // Bulk
  clearCompleted: () => void;
  retryAllFailed: () => void;
  discardRecoverable: () => void;
  // Selectors
  getTask: (id: string) => UploadTask | undefined;
  activeTasks: () => UploadTask[];
  failedTasks: () => UploadTask[];
  pendingTasks: () => UploadTask[];
  recoverableTasks: () => UploadTask[];
  // Notification badge
  unreadCount: number;
  incrementUnread: () => void;
  clearUnread: () => void;
  // Overlay visibility
  queueVisible: boolean;
  setQueueVisible: (v: boolean) => void;
  // Recovery dialog
  showRecoveryDialog: boolean;
  setShowRecoveryDialog: (v: boolean) => void;
}

export const useUploadQueueStore = create<UploadQueueState>()(
  persist(
    (set, get) => ({
      tasks: [],
      unreadCount: 0,
      queueVisible: false,
      recoveryChecked: false,
      showRecoveryDialog: false,

      setRecoveryChecked: (v) => set({ recoveryChecked: v }),
      setShowRecoveryDialog: (v) => set({ showRecoveryDialog: v }),

      addTask: (task) =>
        set((s) => ({ tasks: [task, ...s.tasks] })),

      updateTask: (id, patch) =>
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        })),

      removeTask: (id) => {
        removeXhr(id);
        set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
      },

      clearCompleted: () =>
        set((s) => ({
          tasks: s.tasks.filter((t) => t.status !== 'ready' && t.status !== 'canceled'),
        })),

      retryAllFailed: () =>
        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.status === 'failed'
              ? { ...t, status: 'waiting' as UploadStatus, errorMessage: undefined }
              : t,
          ),
        })),

      discardRecoverable: () =>
        set((s) => ({
          tasks: s.tasks.filter(
            (t) => t.status !== 'recovering' && t.status !== 'uploading' && t.status !== 'paused',
          ),
          showRecoveryDialog: false,
        })),

      getTask: (id) => get().tasks.find((t) => t.id === id),
      activeTasks: () =>
        get().tasks.filter((t) => t.status === 'uploading' || t.status === 'paused'),
      failedTasks: () => get().tasks.filter((t) => t.status === 'failed'),
      pendingTasks: () => get().tasks.filter((t) => t.status === 'waiting'),
      recoverableTasks: () =>
        get().tasks.filter(
          (t) => t.status === 'recovering' || t.status === 'uploading' || t.status === 'paused',
        ),

      incrementUnread: () => set((s) => ({ unreadCount: s.unreadCount + 1 })),
      clearUnread: () => set({ unreadCount: 0 }),
      setQueueVisible: (v) => set({ queueVisible: v }),
    }),
    {
      name: 'medacademy-upload-queue',
      storage: createJSONStorage(() => AsyncStorage),
      // Strip runtime-only fields before persisting
      partialize: (state) => ({
        tasks: state.tasks.map(({ _xhr, _pausedAt, ...rest }) => rest),
        unreadCount: state.unreadCount,
        recoveryChecked: false, // always re-check on next launch
        showRecoveryDialog: false,
        queueVisible: false,
      }),
      // On rehydration, mark any mid-upload tasks as 'recovering'
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // The queue is for active/recoverable work only. Completed and canceled
        // records are persisted by the backend/history, never rehydrated here.
        state.tasks = state.tasks
          .filter((t) => t.status !== 'ready' && t.status !== 'canceled')
          .map((t) => {
            if (t.status === 'uploading' || t.status === 'paused' || t.status === 'waiting') {
              return { ...t, status: 'recovering' as UploadStatus };
            }
            return t;
          });
      },
    },
  ),
);
