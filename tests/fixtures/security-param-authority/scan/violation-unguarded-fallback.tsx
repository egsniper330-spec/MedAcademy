/**
 * VIOLATION FIXTURE — a half-migrated screen: the authoritative context is
 * available and IS consulted elsewhere, but the risk score still comes straight
 * from the param. Availability of the verdict is what makes this wrong; the score
 * the screen shows is attacker-chosen.
 *
 * EXPECTED: PARAM_AUTHORITY_UNGUARDED_DERIVATION × 1 (riskScore)
 */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useSecurity } from '@/lib/SecurityContext';

export default function HalfMigrated() {
  const security = useSecurity();
  const params   = useLocalSearchParams<{ riskScore: string }>();

  const riskScore = parseInt(params.riskScore ?? '0', 10);

  return security.blocksLogin ? null : riskScore;
}
