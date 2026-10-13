/**
 * VIOLATION FIXTURE — the same defect reached through computed access. Renaming
 * the local variable or writing `params['riskScore']` instead of
 * `params.riskScore` must not launder a param-derived security value; the guard
 * resolves the accessed field either way.
 *
 * EXPECTED: PARAM_AUTHORITY_UNEXEMPTED_DERIVATION × 1 (riskScore)
 */
import { useLocalSearchParams } from 'expo-router';

export default function ComputedAccess() {
  const p = useLocalSearchParams<{ riskScore: string }>();

  const deviceScore = parseInt(p['riskScore'] ?? '0', 10);

  return deviceScore;
}
