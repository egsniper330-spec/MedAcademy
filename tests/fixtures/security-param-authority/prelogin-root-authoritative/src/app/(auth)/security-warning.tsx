/**
 * VIOLATION FIXTURE — identical to prelogin-root/ except that the screen can now
 * consult the authoritative verdict. The pre-login exemption is therefore VOID:
 * once the verdict is available, the params must not be the source of the finding,
 * the score or the blocking decision — otherwise a deep link still overrides the
 * real security state.
 *
 * EXPECTED: PARAM_AUTHORITY_UNGUARDED_DERIVATION × 3 (threats, riskScore, blocksLogin)
 */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useSecurity } from '@/lib/SecurityContext';

export default function PreloginSecurityWarning() {
  const security = useSecurity();
  const params   = useLocalSearchParams<{
    threats: string;
    riskScore: string;
    blocksLogin: string;
    redirect: string;
  }>();

  const threats     = JSON.parse(params.threats ?? '[]');
  const riskScore   = parseInt(params.riskScore ?? '0', 10);
  const blocksLogin = params.blocksLogin === 'true';

  return { threats, riskScore, blocksLogin, evaluating: security.evaluating, redirect: params.redirect };
}
