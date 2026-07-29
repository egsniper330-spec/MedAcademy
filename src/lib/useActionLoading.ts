/**
 * useActionLoading — per-action independent loading states.
 * Replaces the anti-pattern of a single `saving` boolean that lights up
 * ALL buttons at once when any one action runs.
 *
 * Usage:
 *   const { isLoading, run } = useActionLoading();
 *   <NeuButton loading={isLoading('suspend')} onPress={() => run('suspend', () => suspendUser(id))} />
 *   <NeuButton loading={isLoading('delete')}  onPress={() => run('delete',  () => deleteUser(id))} />
 */
import { useState, useCallback } from 'react';

export function useActionLoading() {
  const [loadingSet, setLoadingSet] = useState<Set<string>>(new Set());

  const isLoading = useCallback((key: string) => loadingSet.has(key), [loadingSet]);

  const run = useCallback(async <T>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setLoadingSet(prev => new Set([...prev, key]));
    try {
      return await fn();
    } finally {
      setLoadingSet(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const anyLoading = useCallback(() => loadingSet.size > 0, [loadingSet]);

  return { isLoading, run, anyLoading };
}
