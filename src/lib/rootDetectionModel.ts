/**
 * rootDetectionModel.ts — PURE model of the Android root-detection verdicts.
 *
 * WHY THIS FILE EXISTS
 *   The reported defect was two warnings on a clean device:
 *     • "Root privileges detected"          (event: root_detected)
 *     • "A root management tool is installed" (event: magisk_detected)
 *   Both came from ONE observation, because both native detectors started with
 *   the same root-framework artifact probe and treated ANY EACCES as proof:
 *
 *       stat("/debug_ramdisk/su")  →  EACCES  (parent is 0700 root:root on
 *                                              stock Android 11+, so the lookup
 *                                              fails whether or not su exists)
 *
 *   The native module now classifies every signal into a structured check
 *   (id / category / result / evidence / confidence / contributes) and derives
 *   each verdict from its own category. This module is the dependency-free
 *   mirror of those rules, so they can be exercised with mocked native reports
 *   on a machine with no device and no Android toolchain.
 *
 * CONTRACT (kept identical to SecurityModule.kt — tests/rootFalsePositive.test.cjs
 * asserts both sides, including the check catalog):
 *   • a check CONTRIBUTES when result === 'positive' and confidence !== 'low';
 *     a low-confidence positive (a test-keys ROM, an ambiguous artifact) can
 *     never decide a verdict on its own;
 *   • 'inconclusive' (unreadable parent, restricted package lookup) is reported
 *     but NEVER evidence — "could not measure" is not "rooted" and not "clean";
 *   • root_privileges and root_management are independent verdicts; a check that
 *     feeds both (artifact_probe, mount_view) is listed in sharedObservations so
 *     one observation can never masquerade as two confirmations.
 *
 * No React Native / Expo imports: safe for node tests.
 */

export type RootCheckCategory = 'root_privileges' | 'root_management';
export type RootCheckResult = 'positive' | 'negative' | 'inconclusive';
export type RootCheckConfidence = 'high' | 'medium' | 'low';

export interface RootDiagnosticCheck {
  /** Stable check identifier, e.g. 'su_binary_paths'. */
  id: string;
  category: RootCheckCategory;
  result: RootCheckResult;
  /** Bounded, non-sensitive evidence (system artifact paths, package ids, counts). */
  evidence: string;
  confidence: RootCheckConfidence;
  /** True only when this result actually fed the final verdict. */
  contributes: boolean;
}

export interface RootDiagnosticsReport {
  checks: RootDiagnosticCheck[];
  /** Check ids whose positive result feeds BOTH verdicts. */
  sharedObservations?: string[];
  rootDetected?: boolean;
  rootManagementDetected?: boolean;
  /** True when a positive result exists that is too weak to contribute. */
  lowConfidenceOnly?: boolean;
}

export interface RootCheckDefinition {
  id: string;
  categories: readonly RootCheckCategory[];
  /** Best confidence this check can report. */
  confidence: RootCheckConfidence;
}

/**
 * The complete check catalog. Must stay in sync with rootCheckResults() in
 * plugins/withSecurityModule.js (asserted by the regression test).
 */
export const ROOT_CHECK_CATALOG: readonly RootCheckDefinition[] = [
  { id: 'artifact_probe', categories: ['root_privileges', 'root_management'], confidence: 'high' },
  { id: 'su_binary_paths', categories: ['root_privileges'], confidence: 'high' },
  { id: 'su_on_path', categories: ['root_privileges'], confidence: 'high' },
  { id: 'system_writable', categories: ['root_privileges'], confidence: 'high' },
  { id: 'build_props', categories: ['root_privileges'], confidence: 'medium' },
  { id: 'mount_view', categories: ['root_privileges', 'root_management'], confidence: 'medium' },
  { id: 'test_keys', categories: ['root_privileges'], confidence: 'low' },
  { id: 'root_manager_packages', categories: ['root_management'], confidence: 'high' },
  { id: 'magisk_packages', categories: ['root_management'], confidence: 'high' },
  { id: 'magisk_paths', categories: ['root_management'], confidence: 'high' },
  { id: 'zygisk_evidence', categories: ['root_management'], confidence: 'medium' },
  { id: 'magisk_mounts', categories: ['root_management'], confidence: 'medium' },
  { id: 'magisk_maps', categories: ['root_management'], confidence: 'medium' },
  { id: 'artifact_probe_visibility', categories: ['root_privileges', 'root_management'], confidence: 'low' },
  { id: 'package_lookup', categories: ['root_management'], confidence: 'low' },
];

const CATEGORIES: readonly RootCheckCategory[] = ['root_privileges', 'root_management'];
const RESULTS: readonly RootCheckResult[] = ['positive', 'negative', 'inconclusive'];
const CONFIDENCES: readonly RootCheckConfidence[] = ['high', 'medium', 'low'];

const CATALOG_IDS = new Set(ROOT_CHECK_CATALOG.map((c) => c.id));

/** True when a check's result is allowed to feed its category's verdict. */
export function checkContributes(check: RootDiagnosticCheck): boolean {
  return check.result === 'positive' && check.confidence !== 'low';
}

export interface RootDiagnosticsVerdict {
  rootDetected: boolean;
  rootManagementDetected: boolean;
  /** Positive checks that fed each verdict (ids only). */
  contributingChecks: { root_privileges: string[]; root_management: string[] };
  /** Checks that could not measure — reported, never evidence. */
  inconclusiveChecks: string[];
  /** Ids whose positive result feeds both verdicts (shared source). */
  sharedObservations: string[];
  /**
   * True when the ONLY positive results are low-confidence ones: the device is
   * NOT classified, but the weak signal stays visible for support.
   */
  lowConfidenceOnly: boolean;
}

/**
 * Recomputes both verdicts from the check list, applying the confidence rules.
 * Native already applies these rules; this is the auditable mirror, used by the
 * regression tests and to sanity-check a native report at runtime.
 */
export function evaluateRootDiagnostics(
  report: RootDiagnosticsReport | null | undefined,
): RootDiagnosticsVerdict {
  const checks = Array.isArray(report?.checks) ? report!.checks : [];
  const contributing = (category: RootCheckCategory) =>
    checks.filter((c) => c.category === category && checkContributes(c)).map((c) => c.id);

  const rootPrivileges = contributing('root_privileges');
  const rootManagement = contributing('root_management');
  const sharedObservations = rootPrivileges.filter((id) => rootManagement.includes(id));
  const positives = checks.filter((c) => c.result === 'positive');
  const inconclusiveChecks = [...new Set(
    checks.filter((c) => c.result === 'inconclusive').map((c) => c.id),
  )];

  return {
    rootDetected: rootPrivileges.length > 0,
    rootManagementDetected: rootManagement.length > 0,
    contributingChecks: { root_privileges: rootPrivileges, root_management: rootManagement },
    inconclusiveChecks,
    sharedObservations,
    lowConfidenceOnly: positives.length > 0
      && positives.every((c) => !checkContributes(c)),
  };
}

/**
 * Parses/normalizes a native diagnostics payload.
 *
 * Returns null — never a partial object — when the payload is unusable, because
 * an empty-but-valid report would read as "nothing found" (measured clean). A
 * malformed payload means UNKNOWN, exactly like the artifact-evidence accessor.
 *
 * Unknown check ids are dropped (the catalog is the contract); their absence can
 * only make the diagnostic quieter, never invent a finding.
 */
export function parseRootDiagnostics(raw: unknown): RootDiagnosticsReport | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.trim().length === 0) return null;
    try { value = JSON.parse(raw); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.checks)) return null;

  const checks: RootDiagnosticCheck[] = [];
  for (const entry of obj.checks) {
    if (!entry || typeof entry !== 'object') continue;
    const c = entry as Record<string, unknown>;
    if (typeof c.id !== 'string' || !CATALOG_IDS.has(c.id)) continue;
    if (typeof c.category !== 'string' || !CATEGORIES.includes(c.category as RootCheckCategory)) continue;
    if (typeof c.result !== 'string' || !RESULTS.includes(c.result as RootCheckResult)) continue;
    if (typeof c.confidence !== 'string' || !CONFIDENCES.includes(c.confidence as RootCheckConfidence)) continue;
    checks.push({
      id: c.id,
      category: c.category as RootCheckCategory,
      result: c.result as RootCheckResult,
      evidence: typeof c.evidence === 'string' ? c.evidence.slice(0, 300) : '',
      confidence: c.confidence as RootCheckConfidence,
      // Recomputed rather than trusted: a contradictory payload cannot claim a
      // weak result "contributes", and a positive high-confidence check always
      // does.
      contributes: checkContributes({
        id: c.id,
        category: c.category as RootCheckCategory,
        result: c.result as RootCheckResult,
        evidence: '',
        confidence: c.confidence as RootCheckConfidence,
        contributes: false,
      }),
    });
  }
  if (checks.length === 0) return null;

  return { checks, sharedObservations: evaluateRootDiagnostics({ checks }).sharedObservations };
}

/** One bounded log line for support/diagnostics — ids and results only. */
export function describeRootDiagnostics(report: RootDiagnosticsReport | null | undefined): string {
  if (!report) return 'root_diagnostics=unavailable';
  const verdict = evaluateRootDiagnostics(report);
  const ids = (list: string[]) => (list.length ? list.join(',') : 'none');
  return 'root=' + ids(verdict.contributingChecks.root_privileges)
    + ' management=' + ids(verdict.contributingChecks.root_management)
    + ' inconclusive=' + ids(verdict.inconclusiveChecks)
    + ' shared=' + ids(verdict.sharedObservations);
}
