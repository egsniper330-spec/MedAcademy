/**
 * uploadQueueStore.ts
 * Zustand store for the global video upload queue.
 *
 * ACCOUNT ISOLATION:
 * The queue is scoped to the authenticated account. Every task carries
 * `ownerUserId` (the internal authenticated user UUID — the same identity
 * used for backend ownership checks). Persisted storage keys are per-account
 * (`medacademy-upload-queue:<ownerUserId>`), so a logout → login as another
 * account can never display, resume, or mutate a previous account's tasks.
 *
 * Legacy migration: tasks persisted under the old global key
 * `medacademy-upload-queue` (pre-ownership builds) are loaded once and
 * attributed by their OWN stored creator (doctorId). Only tasks whose creator
 * matches the currently-authenticated user are re-persisted under that user's
 * scoped key; tasks that cannot be attributed to the current session are
 * dropped — the backend recovery scan re-derives in-flight uploads for their
 * rightful owner on their next login, so they are never leaked to another
 * account. If no session is active during migration the legacy data is
 * discarded entirely.
 *
 * Runtime-only maps (XHR instances, AbortControllers) are NOT serializable and
 * stay module-level; they are keyed by uploadId which is unique per task.
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

// ── Account-scoped persistence keys ──────────────────────────────────────────
const KEY_PREFIX = 'medacademy-upload-queue';
const LEGACY_KEY = 'medacademy-upload-queue'; // pre-ownership global key

/**
 * Storage key for a given account. The legacy key IS the bare prefix, so the
 * legacy store is only read during explicit migration (never as a live key).
 */
export function queueStorageKey(ownerUserId: string): string {
  return `${KEY_PREFIX}:${ownerUserId}`;
}

/**
 * Migrate legacy (global-key) persisted tasks to the current account's scoped
 * key. Called once at sign-in, BEFORE the scoped store hydrates, so tasks
 * created by this same account on a pre-ownership build are preserved.
 *
 * Tasks that cannot be attributed (no active session) are dropped — they must
 * never surface under a different account.
 */
export async function migrateLegacyQueue(ownerUserId: string | null): Promise<void> {
  try {
    const legacyRaw = await AsyncStorage.getItem(LEGACY_KEY);
    if (legacyRaw === null) return;

    if (!ownerUserId) {
      // No session → cannot attribute ownership. Drop the legacy data rather
      // than risk leaking it into another account's queue.
      await AsyncStorage.removeItem(LEGACY_KEY);
      return;
    }

    const parsed = JSON.parse(legacyRaw);
    const legacyTasks: any[] = Array.isArray(parsed?.state?.tasks) ? parsed.state.tasks : [];
    if (legacyTasks.length === 0) {
      await AsyncStorage.removeItem(LEGACY_KEY);
      return;
    }

    // Attribute each legacy task to its OWN creator (doctorId — set from the
    // creator's profile.id at task creation), NEVER to whoever logs in first.
    // If the app updates while signed out and a different account signs in
    // first, blindly stamping the current user would re-leak the previous
    // owner's tasks. Tasks whose creator cannot be established are dropped:
    // the backend recovery scan re-derives in-flight uploads for their
    // rightful owner on their next login, so nothing is truly lost.
    const stamped = legacyTasks
      .filter(
        (t) =>
          t && t.id &&
          t.status !== 'ready' && t.status !== 'canceled' &&
          typeof t.doctorId === 'string' && t.doctorId === ownerUserId,
      )
      .map((t) => ({ ...t, ownerUserId }));

    const scopedPayload = JSON.stringify({
      state: { tasks: stamped, unreadCount: parsed?.state?.unreadCount ?? 0 },
      version: parsed?.version ?? 0,
    });
    await AsyncStorage.setItem(queueStorageKey(ownerUserId), scopedPayload);
    await AsyncStorage.removeItem(LEGACY_KEY);
  } catch (e) {
    if (__DEV__) console.warn('[uploadQueueStore] legacy migration failed (non-fatal):', e);
  }
}

interface UploadQueueState {
  tasks: UploadTask[];
  /** Authenticated owner of the currently-loaded queue (internal user UUID). */
  ownerUserId: string | null;
  // Recovery: whether we've checked interrupted tasks on this launch
  recoveryChecked: boolean;
  setRecoveryChecked: (v: boolean) => void;
  // Queue mutation
  addTask: (task: UploadTask) => void;
  updateTask: (id: string, patch: Partial<UploadTask>) => void;
  removeTask: (id: string) => void;
  // Account switching: drop the in-memory queue entirely (persisted data for
  // the PREVIOUS account stays under its own scoped key).
  clearForAccountSwitch: () => void;
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

/**
 * Session identity provider — wired by the auth layer at startup so the store
 * can (a) stamp new tasks with the owner and (b) reject updates/events that
 * arrive for a task owned by a DIFFERENT account than the current session.
 *
 * Returns the internal user UUID of the currently-authenticated account, or
 * null when signed out.
 */
let _sessionUserProvider: (() => string | null) | null = null;

export function setUploadQueueSessionProvider(provider: () => string | null): void {
  _sessionUserProvider = provider;
}

/** Current authenticated user id, or null when signed out / not yet wired. */
export function currentQueueUserId(): string | null {
  try {
    return _sessionUserProvider ? _sessionUserProvider() : null;
  } catch {
    return null;
  }
}

export const useUploadQueueStore = create<UploadQueueState>()(
  persist(
    (set, get) => ({
      tasks: [],
      ownerUserId: null,
      unreadCount: 0,
      queueVisible: false,
      recoveryChecked: false,
      showRecoveryDialog: false,

      setRecoveryChecked: (v) => set({ recoveryChecked: v }),
      setShowRecoveryDialog: (v) => set({ showRecoveryDialog: v }),

      addTask: (task) => {
        // The live session is the ONLY authoritative owner. A caller-supplied
        // ownerUserId (e.g. from a profile captured before an account switch)
        // is never trusted — and a task created with no authenticated session
        // is rejected outright because it could not be attributed safely.
        const owner = currentQueueUserId();
        if (!owner) {
          if (__DEV__) console.warn('[uploadQueueStore] addTask without an authenticated owner — rejected');
          return;
        }
        set((s) => ({ tasks: [{ ...task, ownerUserId: owner }, ...s.tasks] }));
      },

      updateTask: (id, patch) =>
        set((s) => {
          const existing = s.tasks.find((t) => t.id === id);
          if (!existing) return s;
          // Cross-account guard: a stale callback (native event, async response,
          // recovery scan) from a PREVIOUS account must never mutate the
          // currently-loaded queue.
          const sessionUser = currentQueueUserId();
          if (sessionUser && existing.ownerUserId && existing.ownerUserId !== sessionUser) {
            if (__DEV__) console.warn('[uploadQueueStore] blocked cross-account updateTask', { id });
            return s;
          }
          // ── State precedence: terminal states never move backward. ──────────
          // 'ready' means the lesson + upload record are durably finalized; a
          // stale poll response, native progress event, or recovery scan must
          // never drag a finalized task back to encoding/uploading. 'canceled'
          // is equally terminal (re-entry goes through a NEW task).
          if (
            (existing.status === 'ready' || existing.status === 'canceled') &&
            patch.status !== undefined && patch.status !== existing.status
          ) {
            if (__DEV__) console.warn('[uploadQueueStore] blocked backward transition', {
              id, from: existing.status, to: patch.status,
            });
            return s;
          }
          // ── Stale-progress guard for post-upload stages. ───────────────────
          // Once bytes are fully transferred, a late chunk-progress event must
          // not drag an encoding/processing task back toward 0%. Error/cancel
          // transitions are exempt (their progress reset is intentional and
          // user-visible).
          const POST_UPLOAD: ReadonlySet<string> = new Set([
            'processing', 'encoding', 'generating_streams', 'verifying',
          ]);
          const isErrorOrCancel = patch.status === 'failed' || patch.status === 'canceled' || patch.status === 'timeout';
          let filtered = patch;
          if (POST_UPLOAD.has(existing.status) && !isErrorOrCancel) {
            const next = { ...patch };
            if (
              typeof next.progress === 'number' &&
              typeof existing.progress === 'number' &&
              next.progress < existing.progress
            ) {
              delete next.progress;
            }
            if (
              typeof next.bytesUploaded === 'number' &&
              typeof existing.bytesUploaded === 'number' &&
              next.bytesUploaded < existing.bytesUploaded
            ) {
              next.bytesUploaded = existing.bytesUploaded;
            }
            filtered = next;
          }
          return {
            tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...filtered } : t)),
          };
        }),

      removeTask: (id) => {
        removeXhr(id);
        removeAbortController(id);
        set((s) => {
          const existing = s.tasks.find((t) => t.id === id);
          if (!existing) return s;
          const sessionUser = currentQueueUserId();
          if (sessionUser && existing.ownerUserId && existing.ownerUserId !== sessionUser) {
            if (__DEV__) console.warn('[uploadQueueStore] blocked cross-account removeTask', { id });
            return s;
          }
          return { tasks: s.tasks.filter((t) => t.id !== id) };
        });
      },

      // Account switch: wipe in-memory state. The previous account's tasks
      // remain persisted under their own scoped key and are reloaded only if
      // that account signs back in.
      clearForAccountSwitch: () =>
        set((s) => ({
          ...s,
          tasks: [],
          ownerUserId: null,
          unreadCount: 0,
          queueVisible: false,
          showRecoveryDialog: false,
          recoveryChecked: false,
        })),

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

      getTask: (id) => {
        const t = get().tasks.find((task) => task.id === id);
        if (!t) return undefined;
        // Cross-account read guard: another account's task must never be
        // visible through the store, even transiently.
        const sessionUser = currentQueueUserId();
        if (sessionUser && t.ownerUserId && t.ownerUserId !== sessionUser) return undefined;
        return t;
      },
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
      // Per-account storage key. `name` is fixed at creation, so we bind it to
      // the CURRENT session user at call time via a custom storage adapter —
      // the key switches automatically when the account switches.
      name: KEY_PREFIX,
      storage: {
        getItem: async (name) => {
          const owner = currentQueueUserId();
          if (!owner) return null; // signed out → no queue state at all
          const raw = await AsyncStorage.getItem(queueStorageKey(owner));
          return raw ? JSON.parse(raw) : null;
        },
        setItem: async (name, state) => {
          const owner = currentQueueUserId() ?? (state as any)?.state?.ownerUserId;
          if (!owner) return; // never persist without an attributable owner
          await AsyncStorage.setItem(queueStorageKey(owner), JSON.stringify(state));
        },
        removeItem: async (name) => {
          const owner = currentQueueUserId();
          if (!owner) return;
          await AsyncStorage.removeItem(queueStorageKey(owner));
        },
      },
      // Strip runtime-only fields before persisting. The persist middleware
      // merges this partial back over the full state, so omitting the action
      // functions here is safe.
      partialize: (state) =>
        ({
          tasks: state.tasks.map(({ _xhr, _pausedAt, _abortController, ...rest }) => rest),
          ownerUserId: state.ownerUserId,
          unreadCount: state.unreadCount,
          recoveryChecked: false, // always re-check on next launch
          showRecoveryDialog: false,
          queueVisible: false,
        }) as any,
      // On rehydration, mark any mid-upload tasks as 'recovering' and verify
      // the persisted owner still matches the current session (defense in
      // depth — the storage key already scopes it).
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const sessionUser = currentQueueUserId();
        if (sessionUser && state.ownerUserId && state.ownerUserId !== sessionUser) {
          // Wrong account's data — hard-clear instead of displaying it.
          state.tasks = [];
          state.ownerUserId = null;
          return;
        }
        // The queue is for active/recoverable work only. Completed and canceled
        // records are persisted by the backend/history, never rehydrated here.
        state.tasks = state.tasks
          .filter((t) => t.status !== 'ready' && t.status !== 'canceled')
          .map((t) => {
            // Mid-flight statuses (including post-upload processing/encoding)
            // become 'recovering' so the owner's next login surfaces them in
            // the recovery dialog instead of leaving them stuck.
            if (
              t.status === 'uploading' || t.status === 'paused' ||
              t.status === 'waiting' || t.status === 'processing' ||
              t.status === 'encoding'
            ) {
              return { ...t, status: 'recovering' as UploadStatus };
            }
            return t;
          });
      },
    },
  ),
);
