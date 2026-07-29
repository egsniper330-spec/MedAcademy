/**
 * ════════════════════════════════════════════════════════════════════════════
 * Enum Integrity Utility
 * ════════════════════════════════════════════════════════════════════════════
 * Fetches live PostgreSQL enum values and diffs them against the frontend
 * enum registry in src/lib/enums.ts.
 *
 * Used by the Enum Health screen (superadmin) and can be called from any
 * startup check to fail-fast on mismatch.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '@/client/supabase';
import {
  DB_ENUM_NAMES,
  FRONTEND_ENUM_REGISTRY,
  type DbEnumName,
} from '@/lib/enums';

export interface EnumValueStatus {
  value: string;
  inDb: boolean;
  inFrontend: boolean;
}

export interface EnumDiff {
  enumName: DbEnumName;
  dbValues: string[];
  frontendValues: string[];
  missingInDb: string[];       // frontend has, DB doesn't
  missingInFrontend: string[]; // DB has, frontend doesn't
  isInSync: boolean;
}

export interface EnumIntegrityReport {
  checkedAt: string;
  totalEnums: number;
  inSyncCount: number;
  mismatchCount: number;
  diffs: EnumDiff[];
  isFullyInSync: boolean;
}

/** Fetch all enum values for every DB_ENUM_NAME from PostgreSQL */
export async function fetchDbEnumValues(): Promise<Record<DbEnumName, string[]>> {
  const { data, error } = await supabase.rpc('get_enum_values_bulk', {
    p_enum_names: DB_ENUM_NAMES as unknown as string[],
  });

  if (error || !data) {
    // Fallback: query pg_enum directly via a known-safe RPC wrapper
    throw new Error(`Failed to fetch DB enums: ${error?.message ?? 'No data'}`);
  }

  const result = {} as Record<DbEnumName, string[]>;
  for (const row of data as { enum_name: string; value: string }[]) {
    const name = row.enum_name as DbEnumName;
    if (!result[name]) result[name] = [];
    result[name].push(row.value);
  }
  return result;
}

/** Diff DB enum values against frontend registry — pure, no network call */
export function diffEnums(
  dbValues: Record<DbEnumName, string[]>,
): EnumIntegrityReport {
  const diffs: EnumDiff[] = DB_ENUM_NAMES.map((name) => {
    const db = new Set(dbValues[name] ?? []);
    const fe = new Set(Object.values(FRONTEND_ENUM_REGISTRY[name] ?? {}));

    const missingInDb = [...fe].filter((v) => !db.has(v));
    const missingInFrontend = [...db].filter((v) => !fe.has(v));

    return {
      enumName: name,
      dbValues: [...db],
      frontendValues: [...fe],
      missingInDb,
      missingInFrontend,
      isInSync: missingInDb.length === 0 && missingInFrontend.length === 0,
    };
  });

  const inSyncCount = diffs.filter((d) => d.isInSync).length;

  return {
    checkedAt: new Date().toISOString(),
    totalEnums: diffs.length,
    inSyncCount,
    mismatchCount: diffs.length - inSyncCount,
    diffs,
    isFullyInSync: inSyncCount === diffs.length,
  };
}

/** Full check: fetch from DB + diff. Use in health screens. */
export async function runEnumIntegrityCheck(): Promise<EnumIntegrityReport> {
  const dbValues = await fetchDbEnumValues();
  return diffEnums(dbValues);
}
