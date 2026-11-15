/**
 * useAdminPermissions — RBAC permission state for admin / Super Admin screens.
 *
 * Source of truth is the backend (`GET /admin/permissions/me`). The client uses
 * this only to hide or disable controls and to guard direct navigation; every
 * protected API call is re-checked on the server (HTTP 403).
 *
 * NOTE: `usePermission.ts` is for device permissions (camera, etc.) and is a
 * different concern — do not merge the two.
 */
import { useCallback, useEffect, useState } from 'react';
import { getMyAdminPermissions, type MyAdminPermissions } from '@/lib/api';

export interface UseAdminPermissionsResult {
  loading: boolean;
  /** True when the backend could not be reached or returned an error. */
  error: boolean;
  isSuperAdmin: boolean;
  permissions: string[];
  /** Super Admin always passes. Otherwise the key must be granted. */
  has: (key: string) => boolean;
  refresh: () => Promise<void>;
}

export function useAdminPermissions(enabled = true): UseAdminPermissionsResult {
  const [state, setState] = useState<MyAdminPermissions | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getMyAdminPermissions();
      setState(next);
      setError(false);
    } catch {
      setState(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  const isSuperAdmin = state?.is_super_admin === true;
  const permissions = state?.permissions ?? [];

  const has = useCallback(
    (key: string) => isSuperAdmin || permissions.includes(key),
    [isSuperAdmin, permissions],
  );

  return { loading, error, isSuperAdmin, permissions, has, refresh };
}
