/**
 * VALID FIXTURE — the approved shape, mirroring the real
 * src/app/(app)/security-warning.tsx: the authoritative verdict is primary and
 * route params are only a fallback for callers outside the authenticated shell.
 *
 * EXPECTED: no violations.
 */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useSecurity } from '@/lib/SecurityContext';

export default function AuthoritativeFirst() {
  const security = useSecurity();
  const params   = useLocalSearchParams<{
    threats: string;
    riskScore: string;
    blocksLogin: string;
  }>();

  const threats     = security.hasVerdict ? security.threats     : JSON.parse(params.threats ?? '[]');
  const riskScore   = security.hasVerdict ? security.riskScore   : parseInt(params.riskScore ?? '0', 10);
  const blocksLogin = security.hasVerdict ? security.blocksLogin : params.blocksLogin === 'true';

  return threats.length + riskScore + (blocksLogin ? 1 : 0);
}
