import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ApiError,
  api,
  login as apiLogin,
  logout as apiLogout,
  onAuthExpired,
  restoreSession,
  type PublicUser,
} from './api';

interface AuthValue {
  user: PublicUser | null;
  loading: boolean;
  error: string | null;
  signIn: (identifier: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export const ROLE_HOME: Record<string, string> = {
  doctor: '/dashboard',
  admin: '/dashboard',
  super_admin: '/dashboard',
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const restored = await restoreSession();
      if (!cancelled) {
        setUser(restored);
        setLoading(false);
      }
    })();
    const unsubscribe = onAuthExpired(() => {
      setUser(null);
      setError('Your session expired. Please sign in again.');
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (identifier: string, password: string) => {
    setError(null);
    try {
      const next = await apiLogin(identifier, password);
      setUser(next);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : 'Sign-in failed.';
      setError(message);
      throw e;
    }
  }, []);

  const signOut = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setError(null);
  }, []);

  const refreshUser = useCallback(async () => {
    const data = await api.get<{ user: PublicUser }>('/auth/me');
    setUser(data.user);
  }, []);

  const value = useMemo<AuthValue>(() => ({
    user,
    loading,
    error,
    signIn,
    signOut,
    refreshUser,
  }), [user, loading, error, signIn, signOut, refreshUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
