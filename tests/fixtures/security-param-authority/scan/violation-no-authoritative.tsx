/**
 * VIOLATION FIXTURE — the pre-fix shape of src/app/(app)/security-warning.tsx,
 * reduced to its essentials. Every security value comes from route params and the
 * authoritative verdict is never consulted, so a deep link such as
 *   /(app)/security-warning?riskScore=0&blocksLogin=false&threats=[]
 * renders "no issues, risk 0" on a device the server just flagged.
 *
 * EXPECTED: PARAM_AUTHORITY_UNEXEMPTED_DERIVATION × 3 (threats, riskScore, blocksLogin)
 */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';

export default function BrokenWarning() {
  const params = useLocalSearchParams<{
    threats: string;
    riskScore: string;
    blocksLogin: string;
  }>();

  const threats     = JSON.parse(params.threats ?? '[]');
  const riskScore   = parseInt(params.riskScore ?? '0', 10);
  const blocksLogin = params.blocksLogin === 'true';

  return threats.length + riskScore + (blocksLogin ? 1 : 0);
}
