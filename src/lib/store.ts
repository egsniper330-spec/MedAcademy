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
  originalRole: null,
  targetName: null,
  targetRole: null,
};

export const useImpersonationStore = create<ImpersonationStore>((set) => ({
  impersonation: IMPERSONATION_DEFAULT,
  startImpersonation: (originalAccessToken, originalRefreshToken, originalEmail, originalRole, targetName, targetRole) =>
    set({ impersonation: { active: true, originalAccessToken, originalRefreshToken, originalEmail, originalRole, targetName, targetRole } }),
  endImpersonation: () => set({ impersonation: IMPERSONATION_DEFAULT }),
}));
