/**
 * VALID FIXTURE (exempted path) — the pre-login security-warning screen. Before
 * authentication there is no SecurityContext verdict to consult, so the
 * server-computed outcome can only arrive as route params. This is the one
 * legitimate case, and it is allowed ONLY because of that: the file reads no
 * authoritative context, and the exemption is void the moment it does (see
 * prelogin-root-authoritative/, which is otherwise identical).
 *
 * EXPECTED: no violations (pre-login exemption), and the guard must report the
 * exemption as an *allowed* classification rather than skipping the file.
 */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';

export default function PreloginSecurityWarning() {
  const params = useLocalSearchParams<{
    threats: string;
    riskScore: string;
    blocksLogin: string;
    redirect: string;
  }>();

  const threats     = JSON.parse(params.threats ?? '[]');
  const riskScore   = parseInt(params.riskScore ?? '0', 10);
  const blocksLogin = params.blocksLogin === 'true';

  return { threats, riskScore, blocksLogin, redirect: params.redirect };
}
