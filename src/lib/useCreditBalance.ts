/**
 * useCreditBalance — live credit balance hook.
 *
 * Reads from creditService (single source of truth, 30-second cache).
 * Refreshes on every screen focus so the displayed balance is never stale
 * after an enrollment or admin credit allocation.
 *
 * LOADING SEMANTICS
 * `loading` is raised only when there is nothing to show yet. Consumers gate
 * their ENTIRE screen on this flag (`if (loading) return <ActivityIndicator/>`),
 * so raising it on every focus blanked the dashboard each time the user
 * returned to it. Focus refreshes now run in the background with the last
 * known balance still on screen — which is exactly why the flag existed:
 * consumers want "no balance yet", not "a request is in flight".
 *
 * Usage:
 *   const { balance, loading, refresh } = useCreditBalance();
 *   <Text>{balance.remaining}</Text>
 */

import { useState, useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import { getCreditBalance, refreshCreditBalance, type CreditBalance } from './creditService';

const EMPTY_BALANCE: CreditBalance = {
  allocated: 0,
  consumed: 0,
  remaining: 0,
  total_allocated: 0,
  used: 0,
};

interface UseCreditBalanceResult {
  balance: CreditBalance;
  loading: boolean;
  /** Force a fresh fetch (bypasses cache). */
  refresh: () => Promise<void>;
}

export function useCreditBalance(): UseCreditBalanceResult {
  const [balance, setBalance] = useState<CreditBalance>(EMPTY_BALANCE);
  const [loading, setLoading] = useState(true);
  // True once a fetch has actually delivered a balance. While false we keep
  // the spinner up (nothing to show); afterwards focus refreshes are silent.
  const hasBalanceRef = useRef(false);

  const load = useCallback(async (force = false) => {
    // Cold load only — never blank an already-populated consumer on refocus.
    if (!hasBalanceRef.current) setLoading(true);
    try {
      const bal = force ? await refreshCreditBalance() : await getCreditBalance();
      setBalance(bal);
      hasBalanceRef.current = true;
    } catch {
      // Keep last known value on error — don't zero out a valid balance.
      // hasBalanceRef stays false, so the next focus shows the loading state
      // again rather than a permanently empty, indicator-free screen.
    }
    setLoading(false);
  }, []);

  // Refresh every time the screen is focused
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const refresh = useCallback(() => load(true), [load]);

  return { balance, loading, refresh };
}
