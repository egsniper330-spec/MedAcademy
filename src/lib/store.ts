import { create } from 'zustand';

// Re-export from enums.ts so the whole app uses one definition
import type { UserRole } from '@/lib/enums';
export type { UserRole };

export interface Profile {
  id: string;
  email: string;
  /** Real email shown to users. Null until the user sets one. */
  profile_email: string | null;
  full_name: string;
  phone: string | null;
  role: UserRole;
  status: 'active' | 'suspended' | 'pending' | 'trashed';
  watermark_id: string;
  /** Public human-readable ID (MED-0001) — the ONLY user-facing user identifier. */
  public_user_id?: string | null;
  avatar_url: string | null;
  created_at: string;
  university_id: string | null;
  faculty_id: string | null;
  academic_level_id: string | null;
  university?: { id: string; name: string } | null;
  faculty?: { id: string; name: string } | null;
  academic_level?: { id: string; name: string } | null;
  /** Doctor-only: whether the independent earnings system is active */
  earnings_enabled?: boolean;
  /** Doctor-only: default revenue per student enrollment (EGP) */
  doctor_global_price?: number;
}

interface ProfileStore {
  profile: Profile | null;
  isProfileLoading: boolean;
  setProfile: (profile: Profile | null) => void;
  setProfileLoading: (loading: boolean) => void;
  clearProfile: () => void;
}

export const useProfileStore = create<ProfileStore>((set) => ({
  profile: null,
  // Start as `true` so any component that reads the store before the first
  // fetch sees "loading" rather than "no profile". This prevents the role-
  // redirect guard from treating the initial empty state as "loaded/done".
  isProfileLoading: true,
  setProfile: (profile) => set({ profile, isProfileLoading: false }),
  setProfileLoading: (isProfileLoading) => set({ isProfileLoading }),
  // CRITICAL: set isProfileLoading:true (not false) so that after a logout
  // the role-redirect effect in (app)/_layout.tsx does NOT fire prematurely
  // with profile=null. The guard `if (isProfileLoading || !profile)` will
  // block until the *new* user's profile is fetched and setProfile() is called.
  clearProfile: () => set({ profile: null, isProfileLoading: true }),
}));

// ── Impersonation store ───────────────────────────────────────────────────────
export interface ImpersonationState {
  active: boolean;
  originalAccessToken: string | null;
  originalRefreshToken: string | null;
  originalEmail: string | null;
  // Actor's user id — needed so stopping impersonation can restore the ACTOR's
  // persisted identity, not the target's (the auth client persists token+user).
  originalUserId: string | null;
  originalRole: UserRole | null;
  targetName: string | null;
  targetRole: UserRole | null;
}

interface ImpersonationStore {
  impersonation: ImpersonationState;
  startImpersonation: (
    originalAccessToken: string,
    originalRefreshToken: string,
    originalEmail: string,
    originalUserId: string,
    originalRole: UserRole,
    targetName: string,
    targetRole: UserRole,
  ) => void;
  endImpersonation: () => void;
}

const IMPERSONATION_DEFAULT: ImpersonationState = {
  active: false,
  originalAccessToken: null,
  originalRefreshToken: null,
  originalEmail: null,
  originalUserId: null,
  originalRole: null,
  targetName: null,
  targetRole: null,
};

// ── Web-reload persistence (sessionStorage snapshot) ─────────────────────────
// A web page reload wipes this in-memory store while the TARGET's auth session
// survives in localStorage — without a snapshot the banner disappears and the
// restore context is lost, stranding the Super Admin inside the target
// account. The snapshot lives in sessionStorage: tab-scoped, dies with the
// tab, never written to disk, web-only (native has no reload; process death
// clears all memory and session together, so there is nothing to re-arm).
const IMPERSONATION_SNAPSHOT_KEY = 'medacademy-impersonation-snapshot';

function writeImpersonationSnapshot(state: ImpersonationState): void {
  if (process.env.EXPO_OS !== 'web') return;
  try { sessionStorage.setItem(IMPERSONATION_SNAPSHOT_KEY, JSON.stringify(state)); } catch { /* private mode */ }
}

function readImpersonationSnapshot(): ImpersonationState | null {
  if (process.env.EXPO_OS !== 'web') return null;
  try {
    const raw = sessionStorage.getItem(IMPERSONATION_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ImpersonationState;
    return parsed?.active && parsed.originalAccessToken ? parsed : null;
  } catch { return null; }
}

function clearImpersonationSnapshot(): void {
  if (process.env.EXPO_OS !== 'web') return;
  try { sessionStorage.removeItem(IMPERSONATION_SNAPSHOT_KEY); } catch { /* ignore */ }
}

/** Peek the persisted snapshot (web only) — used by the boot re-arm in impersonationService. */
export function peekImpersonationSnapshot(): ImpersonationState | null {
  return readImpersonationSnapshot();
}

/** Drop the persisted snapshot (web only) — called when the re-arm detects the impersonation is over. */
export function dropImpersonationSnapshot(): void {
  clearImpersonationSnapshot();
}

export const useImpersonationStore = create<ImpersonationStore>((set) => ({
  impersonation: IMPERSONATION_DEFAULT,
  startImpersonation: (originalAccessToken, originalRefreshToken, originalEmail, originalUserId, originalRole, targetName, targetRole) => {
    const impersonation: ImpersonationState = { active: true, originalAccessToken, originalRefreshToken, originalEmail, originalUserId, originalRole, targetName, targetRole };
    set({ impersonation });
    writeImpersonationSnapshot(impersonation);
  },
  endImpersonation: () => {
    set({ impersonation: IMPERSONATION_DEFAULT });
    clearImpersonationSnapshot();
  },
}));
