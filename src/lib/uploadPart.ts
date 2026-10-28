/**
 * uploadPart.ts — pure helpers for React Native multipart uploads.
 *
 * ROOT CAUSE FIXED HERE (behaviorally):
 * React Native's Blob polyfill CANNOT construct a Blob from an ArrayBuffer or
 * a typed array. `BlobManager.createFromParts` throws:
 *
 *   "Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported"
 *   (react-native/Libraries/Blob/BlobManager.js)
 *
 * On Android that throw surfaces as a catchable JS error; on iOS an
 * ArrayBuffer produced by native-backed fetch (`expo/fetch` → `arrayBuffer()`)
 * can evade the polyfill's realm-sensitive `instanceof` check and reach the
 * native bridge as an invalid part, where the unhandled native exception
 * closes the app.
 *
 * The supported representation for local files in RN FormData is the file
 * descriptor `{ uri, name?, type? }` (see react-native FormData docs) — the
 * native networking layer streams the file from disk, so the image is never
 * loaded into JS memory at all.
 *
 * This module is intentionally dependency-free so the test suite can compile
 * and execute it for real (same convention as src/lib/semver.ts).
 */

/** React Native–supported FormData file part: a local file URI descriptor. */
export interface UploadFileDescriptor {
  /** Local file URI (file://, content:// on Android, or a file:// path on iOS). */
  uri: string;
  /** MIME type sent as the part's Content-Type (e.g. image/jpeg). */
  mimeType?: string;
  /** File name sent as the part's filename (Content-Disposition). */
  name?: string;
}

/** Everything the storage client accepts for a file upload. */
export type UploadFileInput = Blob | ArrayBuffer | UploadFileDescriptor;

export type PlatformId = 'ios' | 'android' | 'web' | string;

export type UploadPartDecision =
  | { kind: 'descriptor'; value: UploadFileDescriptor }
  | { kind: 'blob'; value: Blob }
  | { kind: 'error'; message: string };

function isDescriptor(file: unknown): file is UploadFileDescriptor {
  return (
    typeof file === 'object' &&
    file !== null &&
    typeof (file as UploadFileDescriptor).uri === 'string' &&
    (file as UploadFileDescriptor).uri.length > 0
  );
}

function isArrayBufferLike(file: unknown): boolean {
  if (typeof ArrayBuffer === 'function' && file instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView && ArrayBuffer.isView(file as ArrayBufferView)) return true;
  return false;
}

/**
 * Resolve an upload input into something FormData can actually carry.
 *
 * ── THE WEB BUG THIS FIXES ──────────────────────────────────────────────
 * `toUploadPart()` returns the `{ uri, name, type }` descriptor, which is the
 * supported representation ONLY on React Native: there the native networking
 * layer streams the file from that URI. On the WEB there is no such hook —
 * `FormData.append(name, {uri})` follows the HTML spec and stringifies the
 * object, so the server received a 15-byte part reading `[object Object]` and
 * answered `400 upload_missing`. The app then showed the "size" of the
 * MULTIPART BODY (679 / 777 / 790 bytes, depending on the path) next to
 * "فشل الرفع", which read like a truncated 140 KB PDF.
 *
 * On web the bytes must therefore be fetched from the picker's `blob:` (or
 * `data:`) URL and appended as a real Blob/File. `fetchBlob` is injectable so
 * the conversion is testable without a browser.
 */
export type ResolvedUploadPart =
  | { kind: 'blob'; value: Blob }
  | { kind: 'descriptor'; value: UploadFileDescriptor }
  | { kind: 'error'; message: string };

export async function resolveUploadPart(
  file: UploadFileInput,
  platform: PlatformId,
  fetchBlob?: (uri: string) => Promise<Blob>,
): Promise<ResolvedUploadPart> {
  const decision = toUploadPart(file, platform);
  if (decision.kind !== 'descriptor' || platform !== 'web') {
    return decision;
  }

  const { uri, name, mimeType } = decision.value;
  const load = fetchBlob ?? (async (u: string) => {
    const res = await globalThis.fetch(u);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  });

  let blob: Blob;
  try {
    blob = await load(uri);
  } catch (e) {
    return {
      kind: 'error',
      message:
        'The selected file could not be read from the browser. Pick it again '
        + `and retry. (${e instanceof Error ? e.message : String(e)})`,
    };
  }

  if (!(blob.size > 0)) {
    // A zero-byte part must never reach the server: it would be refused there,
    // and a 200 with 0 stored bytes is the incident this pipeline exists to stop.
    return { kind: 'error', message: 'The selected file is empty (0 bytes). Pick the file again.' };
  }

  const fileName = name ?? 'upload.bin';
  const type = mimeType ?? (blob.type || 'application/octet-stream');
  const FileCtor = (globalThis as { File?: new (parts: BlobPart[], name: string, opts?: { type?: string }) => Blob }).File;
  const asFile = typeof FileCtor === 'function' ? new FileCtor([blob], fileName, { type }) : blob;
  // Some engines produce a File whose size differs from the blob it wraps only
  // when the constructor misbehaves; guard the contract explicitly.
  if (asFile.size !== blob.size) {
    return { kind: 'blob', value: blob };
  }
  return { kind: 'blob', value: asFile };
}

/**
 * Decide how a file input must be appended to FormData on the given platform.
 *
 * - `{ uri }` descriptor → passed straight through (Android + iOS): the native
 *   layer streams the file; no JS memory copy, no Blob construction.
 * - `Blob` → passed straight through (web, or native Blobs already built by
 *   RN's fetch from responses).
 * - `ArrayBuffer`/typed array → allowed ONLY on web (the browser Blob
 *   constructor supports it natively). On Android/iOS this is the exact
 *   operation RN forbids, so it is rejected with a clear, actionable error
 *   instead of producing the runtime error or the iOS crash.
 */
export function toUploadPart(file: UploadFileInput, platform: PlatformId): UploadPartDecision {
  if (isDescriptor(file)) {
    return {
      kind: 'descriptor',
      value: {
        uri: file.uri,
        mimeType: file.mimeType,
        name: file.name,
      },
    };
  }
  if (typeof Blob === 'function' && file instanceof Blob) {
    return { kind: 'blob', value: file };
  }
  if (isArrayBufferLike(file)) {
    if (platform === 'web') {
      // Real browser Blob constructor — supported on web only.
      return { kind: 'blob', value: new Blob([file as ArrayBuffer]) };
    }
    return {
      kind: 'error',
      message:
        "Uploading an ArrayBuffer/typed array is not supported on native. " +
        'Pass the local file URI descriptor { uri, mimeType, name } instead — ' +
        "React Native cannot create Blobs from 'ArrayBuffer' or 'ArrayBufferView'.",
    };
  }
  return {
    kind: 'error',
    message: `Unsupported upload payload: ${typeof file}`,
  };
}

// ── Avatar-specific pure helpers ────────────────────────────────────────────

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

export function isSupportedImageMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXT_BY_MIME, mime.toLowerCase());
}

/** Prefer the asset's MIME type; fall back to the URI extension; then jpeg. */
export function resolveImageMime(mimeType: string | null | undefined, uri: string): string {
  const fromAsset = (mimeType ?? '').toLowerCase().split(';')[0].trim();
  if (isSupportedImageMime(fromAsset)) return fromAsset;
  const ext = uri.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() ?? '';
  if (Object.prototype.hasOwnProperty.call(IMAGE_MIME_BY_EXT, ext)) return IMAGE_MIME_BY_EXT[ext];
  return 'image/jpeg';
}

export function extFromMime(mime: string): string {
  return EXT_BY_MIME[mime.toLowerCase()] ?? 'jpg';
}

/**
 * Avatars live under a user-owned prefix. The backend authorizes avatar
 * writes when the FIRST OR SECOND path segment equals the authenticated
 * user's id (StorageController::canWritePath) — both shapes below satisfy
 * ownership. The timestamp segment makes every upload a fresh object so
 * CDNs/browsers never serve a stale avatar after re-upload.
 */
export function buildAvatarStoragePath(userId: string, ext: string, timestamp: number): string {
  const safeExt = EXT_BY_MIME['image/' + ext] ? ext : extFromMime(`image/${ext}`);
  return `avatars/${userId}/${timestamp}-avatar.${safeExt}`;
}

export function avatarFileName(ext: string): string {
  return `avatar.${ext}`;
}

/**
 * Extract the storage path from a previous avatar public URL so a
 * best-effort cleanup can remove the replaced object. Returns null for
 * foreign/other-bucket URLs or anything that doesn't look like a path.
 */
export function previousAvatarStoragePath(publicUrl: string | null | undefined, bucket: string): string | null {
  if (!publicUrl) return null;
  const marker = `/storage/public/${bucket}/`;
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) return null;
  let p = publicUrl.slice(idx + marker.length).split('?')[0];
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  return p.length > 0 ? p : null;
}

/**
 * HEIC/HEIF guard. The avatar picker runs with allowsEditing, and iOS's crop
 * controller re-encodes the result to JPEG/PNG, so HEIC essentially never
 * reaches upload. If a HEIC/HEIF asset still slips through, we keep the
 * original bytes and label them accurately (the backend detects the real
 * MIME with fileinfo and has no extension allowlist) — converting pixels
 * purely to satisfy an extension is not worth a hard dependency.
 */
export function needsHeicTranscode(mime: string): boolean {
  const m = mime.toLowerCase();
  return m === 'image/heic' || m === 'image/heif';
}
