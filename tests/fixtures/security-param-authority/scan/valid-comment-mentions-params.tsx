/**
 * VALID FIXTURE — the analysis is on the AST, so prose can neither satisfy nor
 * defeat a rule. This file mentions the offending shapes in comments and in a
 * string, and reads a param only for navigation.
 *
 * EXPECTED: no violations.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';

// The pre-fix code looked like this (kept as documentation, not as a violation):
//   const riskScore   = parseInt(params.riskScore ?? '0', 10);
//   const blocksLogin = params.blocksLogin === 'true';
// ...and these comments mention params.threats on purpose.

export default function Noise() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const note = 'the old bug rendered params.riskScore and params.blocksLogin as fact';

  const go = () => router.push({ pathname: '/security-warning', params: { id } });

  return { note, go };
}
