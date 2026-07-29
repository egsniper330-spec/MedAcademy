/**
 * useCreditBalance — live credit balance hook.
 *
 * Reads from creditService (single source of truth, 30-second cache).
 * Refreshes on every screen focus so the displayed balance is never stale
 * after an enrollment or admin credit allocation.
 *
 * Usage:
 *   const { balance, loading, refresh } = useCreditBalance();
 *   <Text>{balance.remaining}</Text>
 */

import { useState, useCallback } from 'react';
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

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const bal = force ? await refreshCreditBalance() : await getCreditBalance();
      setBalance(bal);
    } catch {
      // Keep last known value on error — don't zero out a valid balance
    }
    setLoading(false);
  }, []);

  // Refresh every time the screen is focused
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const refresh = useCallback(() => load(true), [load]);

  return { balance, loading, refresh };
}
