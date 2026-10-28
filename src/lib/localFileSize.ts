/**
 * localFileSize.ts — how many bytes does the file the doctor SELECTED actually
 * have, and how do we know?
 *
 * WHY THIS EXISTS
 * ──────────────
 * `declared_size` exists so the SERVER can tell whether the bytes it received
 * belong to the document the picker returned. But expo-document-picker reports
 * `size` from the platform provider's metadata (`OpenableColumns.SIZE` on
 * Android), and that column is a HINT, not a measurement:
 *
 *   • cloud providers (Drive, OneDrive, some file managers) return a placeholder,
 *     a pre-conversion length, or a value from the wrong cursor column;
 *   • `content://` URIs may stream a different length than they advertise.
 *
 * Two production refusals carry that shape. A doctor selected a PDF under 200 KB
 * and the server logged `pdf_invalid bytes=9563250`; another selected a ~140 KB
 * PDF and the refusal quoted 679 bytes. Neither number can come from PHP
 * (`$_FILES['size']` is filled from the bytes PHP received, so it always agrees
 * with itself), and neither is possible for the file the doctor says they chose.
 * In both cases the *hint* was wrong — and the previous check treated a wrong
 * hint as proof of a wrong file, refusing genuine documents.
 *
 * THE FIX
 * ───────
 * Stat the file we are actually about to stream, and say which number we sent:
 *
 *   'stat'   — measured from the file itself (browser `File.size`, or a native
 *              filesystem stat). AUTHORITATIVE: a divergence is a real problem.
 *   'picker' — the provider's metadata, used only because no stat was possible.
 *              A hint; it must never on its own fail an upload.
 *   'none'   — unknown; send nothing.
 *
 * Deliberately dependency-free: the native stat is injected, so this module runs
 * unchanged in the test suite (Node) and in the app (expo-file-system).
 */

export type DeclaredSizeSource = 'stat' | 'picker' | 'none';

export interface DeclaredFileSize {
  /** Bytes, 0 when unknown. */
  size: number;
  source: DeclaredSizeSource;
}

export type PlatformId = 'ios' | 'android' | 'web' | string;

export const UNKNOWN_FILE_SIZE: DeclaredFileSize = { size: 0, source: 'none' };

function positiveInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(n);
}

/**
 * Choose which byte count to declare, given what we measured and what the picker
 * claimed.
 *
 * A real measurement always wins. On WEB the picker's number IS a measurement
 * (the browser builds it from the actual `File`), so it counts as 'stat' there;
 * on native the same field comes from provider metadata and counts as 'picker'.
 */
export function chooseDeclaredSize(
  platform: PlatformId,
  pickerSize: unknown,
  statSize: unknown,
): DeclaredFileSize {
  const measured = positiveInt(statSize);
  if (measured > 0) return { size: measured, source: 'stat' };

  const claimed = positiveInt(pickerSize);
  if (claimed <= 0) return UNKNOWN_FILE_SIZE;

  return { size: claimed, source: platform === 'web' ? 'stat' : 'picker' };
}

/**
 * Resolve the declared size for a picked file, statting it first when the
 * platform can.
 *
 * `statFile` is injected (the app passes `expo-file-system`'s `getInfoAsync`)
 * so this file has no native import and stays unit-testable. It must return the
 * file's size in bytes, or null/0 when it cannot tell — a throw is treated the
 * same way, because failing to stat must never fail the upload.
 */
export async function resolveDeclaredFileSize(
  input: {
    uri: string;
    pickerSize?: number | null;
    platform?: PlatformId;
  },
  statFile?: (uri: string) => Promise<number | null | undefined>,
): Promise<DeclaredFileSize> {
  const platform = input.platform ?? 'web';
  const claimed = positiveInt(input.pickerSize);
  // On web the picker already measured the real File; statting a blob: URL is
  // pointless. On native, only stat a local path: a content:// URI cannot be
  // statted reliably and a remote URL is not a file at all.
  const canStat =
    platform !== 'web' &&
    typeof statFile === 'function' &&
    /^(file|content):\/\//i.test(input.uri);

  if (!canStat) return chooseDeclaredSize(platform, claimed, 0);

  try {
    const measured = await statFile!(input.uri);
    return chooseDeclaredSize(platform, claimed, measured);
  } catch {
    // A stat failure is not an upload failure: fall back to the hint, tagged so
    // the server knows it is only a hint.
    return chooseDeclaredSize(platform, claimed, 0);
  }
}

/**
 * Is the received byte count SHORT of what was declared?
 *
 * This is the dangerous direction — a multipart body that stopped early — and it
 * is refused regardless of where the declared number came from: a truncated
 * transfer cannot produce the document either way.
 */
export function declaresTruncatedTransfer(declared: number, received: number, tolerance?: (declared: number, actual: number) => boolean): boolean {
  const d = positiveInt(declared);
  const r = positiveInt(received);
  if (d <= 0 || r <= 0) return false;
  return r < d && (tolerance ? tolerance(d, r) : true);
}

/**
 * Is the received byte count LONGER than a declared size we TRUST?
 *
 * Only a measured ('stat') declared size can prove the request carried a
 * different, larger file (a stale cache URI, a substituted asset, a duplicated
 * transfer). A picker hint that turned out to be too small proves nothing, and
 * previously turned real documents into "Upload failed".
 */
export function declaresDifferentFile(
  declared: number,
  received: number,
  source: DeclaredSizeSource,
  diverges: (declared: number, actual: number) => boolean,
): boolean {
  if (source !== 'stat') return false;
  const d = positiveInt(declared);
  const r = positiveInt(received);
  if (d <= 0 || r <= 0) return false;
  return r > d && diverges(d, r);
}
