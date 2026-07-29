/**
 * videoFormats.ts
 * ═══════════════════════════════════════════════════════════════════════════
 * Single source of truth for every video format MedAcademy accepts.
 *
 * Validation is MIME-first (authoritative), with extension as a fallback
 * when the OS/picker returns an empty or incorrect MIME type.
 *
 * On error the validator returns structured diagnostics so the UI can
 * display "Expected: video/mp4  ·  Detected: application/octet-stream"
 * instead of the opaque "Unsupported video format."
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─── Accepted MIME types ──────────────────────────────────────────────────────
// Must mirror the `allowed_mime_types` array in the `lesson-materials` bucket.
// ⚠ If you add a MIME here, also add it in migration v77_storage_bucket_video_mimes.sql.

export const ACCEPTED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/quicktime',       // .mov
  'video/x-matroska',      // .mkv
  'video/webm',
  'video/x-msvideo',       // .avi
  'video/mpeg',            // .mpeg / .mpg
  'video/3gpp',            // .3gp
  'video/3gpp2',           // .3g2
  'video/mp2t',            // .ts / .m2ts
  'video/x-m4v',           // .m4v
  'video/ogg',             // .ogv
  'video/x-flv',           // .flv
  'video/x-ms-wmv',        // .wmv
  // Supabase Storage sometimes sniffs these for binary uploads:
  'application/octet-stream',
]);

// ─── Accepted file extensions → canonical MIME ────────────────────────────────
export const EXTENSION_TO_MIME: Record<string, string> = {
  mp4:  'video/mp4',
  mov:  'video/quicktime',
  m4v:  'video/x-m4v',
  mkv:  'video/x-matroska',
  avi:  'video/x-msvideo',
  webm: 'video/webm',
  mpeg: 'video/mpeg',
  mpg:  'video/mpeg',
  '3gp':  'video/3gpp',
  '3g2':  'video/3gpp2',
  ts:   'video/mp2t',
  m2ts: 'video/mp2t',
  mts:  'video/mp2t',
  ogv:  'video/ogg',
  flv:  'video/x-flv',
  wmv:  'video/x-ms-wmv',
};

export const ACCEPTED_EXTENSIONS = Object.keys(EXTENSION_TO_MIME);

// Human-readable list for error messages
export const ACCEPTED_EXTENSIONS_DISPLAY = ACCEPTED_EXTENSIONS.join(', ');

// ─── Validation result ────────────────────────────────────────────────────────

export interface VideoFileInfo {
  fileName: string;
  detectedExtension: string;   // lower-cased, without leading dot
  detectedMime: string;        // as returned by picker / OS
  resolvedMime: string;        // after extension-fallback resolution
  fileSize: number;
  isValid: boolean;
}

export interface VideoValidationError {
  code:
    | 'UNSUPPORTED_MIME'
    | 'UNSUPPORTED_EXTENSION'
    | 'EMPTY_FILE'
    | 'MISSING_EXTENSION';
  message: string;
  // Diagnostic fields for logging / detailed UI
  detectedMime: string;
  detectedExtension: string;
  resolvedMime: string;
  expectedMimes: string[];
  expectedExtensions: string[];
  fileName: string;
  fileSize: number;
}

export interface VideoValidationResult {
  ok: boolean;
  info?: VideoFileInfo;
  error?: VideoValidationError;
}

// ─── Core validator ───────────────────────────────────────────────────────────

/**
 * Validate a video file before queuing for upload.
 *
 * Strategy (MIME-first):
 *   1. Extract extension from filename.
 *   2. Determine reported MIME (from picker) and extension-derived MIME.
 *   3. Accept if EITHER the reported MIME OR the extension-derived MIME
 *      is in ACCEPTED_VIDEO_MIMES.  This handles the common Android case
 *      where `.mov` / `.mkv` files arrive with mimeType = '' or
 *      'application/octet-stream'.
 *   4. If neither matches → reject with full diagnostics.
 *
 * @param fileName  Original file name including extension.
 * @param mimeType  MIME reported by the OS/picker (may be '' or null).
 * @param fileSize  File size in bytes.
 */
export function validateVideoFile(
  fileName: string,
  mimeType: string | null | undefined,
  fileSize: number,
): VideoValidationResult {
  const name = fileName.trim();
  const reported = (mimeType ?? '').trim().toLowerCase();
  const dotIdx = name.lastIndexOf('.');
  const ext = dotIdx >= 0 ? name.slice(dotIdx + 1).toLowerCase() : '';
  const extMime = EXTENSION_TO_MIME[ext] ?? '';

  // Empty file guard
  if (fileSize === 0) {
    return {
      ok: false,
      error: {
        code: 'EMPTY_FILE',
        message: 'The selected file is empty.',
        detectedMime: reported,
        detectedExtension: ext,
        resolvedMime: extMime || reported,
        expectedMimes: [...ACCEPTED_VIDEO_MIMES].filter(m => !m.startsWith('application/')),
        expectedExtensions: ACCEPTED_EXTENSIONS,
        fileName: name,
        fileSize,
      },
    };
  }

  // No extension at all
  if (!ext) {
    return {
      ok: false,
      error: {
        code: 'MISSING_EXTENSION',
        message: `File "${name}" has no extension. Please rename the file with one of: ${ACCEPTED_EXTENSIONS_DISPLAY}.`,
        detectedMime: reported,
        detectedExtension: '',
        resolvedMime: reported,
        expectedMimes: [...ACCEPTED_VIDEO_MIMES].filter(m => !m.startsWith('application/')),
        expectedExtensions: ACCEPTED_EXTENSIONS,
        fileName: name,
        fileSize,
      },
    };
  }

  // Accept if MIME is valid (MIME-first)
  const mimeValid = reported.length > 0 && ACCEPTED_VIDEO_MIMES.has(reported);
  // Accept if extension maps to a valid MIME (extension fallback)
  const extValid = extMime.length > 0;
  // Resolved MIME: prefer reported if valid, else use extension-derived
  const resolvedMime = mimeValid ? reported : (extMime || reported);

  if (mimeValid || extValid) {
    return {
      ok: true,
      info: {
        fileName: name,
        detectedExtension: ext,
        detectedMime: reported,
        resolvedMime,
        fileSize,
        isValid: true,
      },
    };
  }

  // Both failed — extension is unrecognised
  const extKnown = !!extMime;
  return {
    ok: false,
    error: {
      code: extKnown ? 'UNSUPPORTED_MIME' : 'UNSUPPORTED_EXTENSION',
      message: extKnown
        ? `Unsupported format.\n\nDetected MIME: ${reported || '(none)'}\nExpected: ${extMime}\nExtension: .${ext}`
        : `Unsupported file extension ".${ext}".\n\nAccepted formats: ${ACCEPTED_EXTENSIONS_DISPLAY}\nDetected MIME: ${reported || '(none)'}`,
      detectedMime: reported,
      detectedExtension: ext,
      resolvedMime,
      expectedMimes: [...ACCEPTED_VIDEO_MIMES].filter(m => !m.startsWith('application/')),
      expectedExtensions: ACCEPTED_EXTENSIONS,
      fileName: name,
      fileSize,
    },
  };
}

/**
 * Given a reported MIME and file name, return the best MIME to use when
 * uploading to Supabase Storage.  Prefers the reported MIME when valid,
 * falls back to the extension-derived MIME, and finally to 'video/mp4'.
 */
export function resolveUploadMime(
  fileName: string,
  reportedMime: string | null | undefined,
): string {
  const reported = (reportedMime ?? '').trim().toLowerCase();
  if (reported.length > 0 && ACCEPTED_VIDEO_MIMES.has(reported)) return reported;
  const dotIdx = fileName.lastIndexOf('.');
  const ext = dotIdx >= 0 ? fileName.slice(dotIdx + 1).toLowerCase() : '';
  return EXTENSION_TO_MIME[ext] ?? 'video/mp4';
}
