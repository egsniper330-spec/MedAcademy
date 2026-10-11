/**
 * lessonMaterials.ts — one place that decides what a STUDENT may do with a
 * lesson attachment.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The lesson editor lets a doctor set a per-material permission
 * (`allow` / `preview_only` / `hidden` / `disabled`, see DownloadPermission) and
 * a `download_enabled` switch. The student lesson screen used to ignore both:
 * it rendered every row and offered a Download button gated only by
 * `download_enabled`, so a material the doctor explicitly HIDDEN was still
 * listed — and a `preview_only` material was still downloadable.
 *
 * The rules here are the client half of the contract. The server enforces the
 * same policy when it mints the signed URL (StorageService::canAccess), so this
 * is presentation + intent, never the only barrier.
 */

/** What the student may do with one attachment. */
export type MaterialAccess = 'download' | 'view' | 'none';

/**
 * `download_enabled` arrives as 1/0 (MySQL TINYINT), '1'/'0', or true/false
 * depending on the transport. `Number()` normalises all of them, so a legacy
 * row that predates the column (undefined) still counts as enabled.
 */
export function isMaterialDownloadEnabled(mat: any): boolean {
  if (mat?.download_enabled === undefined || mat?.download_enabled === null) return true;
  return Number(mat.download_enabled) !== 0;
}

/**
 * Effective access for one material:
 *   hidden / disabled       → 'none'  (never listed to a student)
 *   preview_only            → 'view'  (readable in the app, no download offer)
 *   allow, download off     → 'view'
 *   allow, download on      → 'download'
 *
 * `permission` is absent on pre-migration rows → treated as 'allow'.
 */
export function materialAccess(mat: any): MaterialAccess {
  const permission = String(mat?.permission ?? 'allow');
  if (permission === 'hidden' || permission === 'disabled') return 'none';
  if (permission === 'preview_only') return 'view';
  return isMaterialDownloadEnabled(mat) ? 'download' : 'view';
}

/**
 * The teacher's "Personalized Student Watermark" switch for one material.
 *
 * INDEPENDENT of `materialAccess`: all four combinations are legal — a
 * Preview-Only material may be watermarked, and a Preview+Download material may
 * be left unmarked. Like `download_enabled`, a pre-migration row has no value;
 * `undefined` means OFF (the server column defaults to 0), so nothing starts
 * watermarking by accident.
 */
export function isMaterialWatermarkEnabled(mat: any): boolean {
  if (mat?.watermark_enabled === undefined || mat?.watermark_enabled === null) return false;
  return Number(mat.watermark_enabled) === 1;
}

/** Materials a student may see at all (permission 'none' ones are dropped). */
export function visibleMaterials(materials: any[] | null | undefined): any[] {
  return (materials ?? []).filter((m) => materialAccess(m) !== 'none');
}

/** Human label for the action offered on a row. */
export function materialActionLabel(access: MaterialAccess): string {
  return access === 'download' ? 'Download' : 'View';
}

/**
 * Upload policy for lesson attachments — the CLIENT half of the contract.
 *
 * The server enforces the same size cap and the same type denylist
 * (StorageController::assertUploadAllowed). Keeping the values in sync here
 * lets the doctor see an immediate, specific reason instead of a generic
 * "Upload failed" after the bytes have already been sent.
 *
 * Size cap matches the figure the upload UI already advertises.
 */
export const LESSON_MATERIAL_MAX_BYTES = 100 * 1024 * 1024;

/** Executable / script / server-side types — never valid lesson attachments. */
export const BLOCKED_UPLOAD_EXTENSIONS = [
  'php', 'php3', 'php4', 'php5', 'php7', 'php8', 'phtml', 'phar', 'pht',
  'cgi', 'pl', 'py', 'rb', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'com', 'ps1', 'psm1',
  'exe', 'msi', 'dll', 'so', 'dylib', 'jar', 'war', 'scr', 'vbs', 'vbe', 'wsf', 'hta',
  'jsp', 'jspx', 'asp', 'aspx', 'ashx', 'htaccess', 'htpasswd', 'pem', 'key',
];

/**
 * Validate a picked file before uploading. Returns null when acceptable,
 * otherwise a message safe to show the doctor.
 */
export function validateMaterialFile(file: { name?: string | null; size?: number | null }): string | null {
  const name = String(file?.name ?? '');
  const size = Number(file?.size ?? 0);
  if (size > LESSON_MATERIAL_MAX_BYTES) {
    return `That file is ${(size / 1048576).toFixed(1)} MB. The maximum is 100 MB.`;
  }
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (ext && BLOCKED_UPLOAD_EXTENSIONS.includes(ext)) {
    return `.${ext} files cannot be attached to a lesson.`;
  }
  return null;
}
