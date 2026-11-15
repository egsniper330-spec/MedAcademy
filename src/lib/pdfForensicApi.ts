/**
 * pdfForensicApi — the mobile PDF Checker's thin client.
 *
 * The checker is a STAFF tool, and it talks to exactly the same backend endpoints the web
 * portal uses:
 *
 *   GET  /courses                        → courses the signed-in staff member may see
 *   GET  /api/lesson_materials           → PDF materials of one course
 *   POST /pdf-forensic/check             → multipart { file, material_id } → verdict
 *   GET  /pdf-forensic/issuances         → issuance/audit rows for one material
 *
 * There is no second inspection engine and no client-side identity logic: the verdict, the
 * confidence numbers and the student identity are all produced by the backend, which enforces
 * authorization (doctor scope = own materials, admin = existing scope, super admin = platform).
 * Nothing here can widen that.
 */

import { Platform } from 'react-native';
import { apiFetch, backendApiBase, backendClient } from '@/client/php';
import { isSecurityLocked } from '@/lib/securityLock';
import { resolveUploadPart } from '@/lib/uploadPart';
import { uploadWithProgress, UploadTransportError } from '@/lib/uploadTransport';

export type Verdict = 'confirmed' | 'probable' | 'no_mark' | 'ambiguous' | 'unsupported';

export interface CheckIssuance {
  watermark_record: string;
  issued_at: string;
  expires_at: string;
  course_id: string;
  /** Real course name, joined server-side from courses.id (UUID is the fallback only). */
  course_title?: string | null;
  material_id: string;
  material_name?: string | null;
  student?: {
    id: string;
    name: string | null;
    public_user_id: string | null;
    avatar_url?: string | null;
    /** Courses this student is enrolled in within the caller's scope (server-computed). */
    enrolled_courses?: number;
  } | null;
  doctor?: { id: string; name: string | null } | null;
}

export interface CheckResult {
  verdict: Verdict;
  score: number;
  agreement: number;
  pages_analyzed: number;
  pages_total: number;
  matched: boolean;
  note?: string;
  issuance?: CheckIssuance;
  /**
   * Server-side stage timings for THIS check (staff-only endpoint, no identity).
   * `receive_ms` is how long PHP spent taking the body from the client, `detect_ms`
   * how long the VPS took to read the mark. They are the only way to separate
   * "the upload was slow" from "the analysis was slow".
   */
  timings?: ServerTimings;
}

export interface ServerTimings {
  bytes?: number;
  receive_ms?: number;
  detect_ms?: number;
  total_ms?: number;
  forwarded_ms?: number;
}

/** Client-side measurements for one check, in milliseconds from the call. */
export interface CheckTimings {
  /** Bytes the picked file claims (0 when unknown). */
  bytesDeclared: number;
  /** Bytes the transport confirmed it sent. */
  bytesSent: number;
  /** Building the multipart body (including the web blob → File conversion). */
  prepareMs: number;
  /** Request start → body fully sent. THIS is the upload duration. */
  uploadMs: number;
  /** Body sent → server answered. This is PHP receive-remainder + VPS analysis. */
  analysisMs: number;
  totalMs: number;
  server?: ServerTimings;
}

export interface CheckerCourse {
  id: string;
  title: string;
}

export interface CheckerMaterial {
  id: string;
  file_name: string;
  file_type: string;
}

export interface IssuanceRow {
  id: string;
  material_id: string;
  course_id: string;
  student_id: string;
  payload: number;
  issued_at: string;
  expires_at: string;
  status: string;
  purged_at: string | null;
  download_count: number;
}

function unwrapList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of ['courses', 'materials', 'data', 'items']) {
      if (Array.isArray(record[key])) return record[key] as T[];
    }
  }
  return [];
}

export async function listCheckerCourses(): Promise<CheckerCourse[]> {
  const { data, error } = await apiFetch<unknown>('/courses');
  if (error) throw new Error(error.message);
  return unwrapList<CheckerCourse>(data).map((course) => ({
    id: String(course.id),
    title: String((course as { title?: string }).title ?? ''),
  }));
}

export async function listPdfMaterials(courseId: string): Promise<CheckerMaterial[]> {
  const query = `?course_id=eq.${encodeURIComponent(courseId)}&order=order_index.asc`;
  const { data, error } = await apiFetch<unknown>(`/api/lesson_materials${query}`);
  if (error) throw new Error(error.message);
  return unwrapList<CheckerMaterial>(data)
    .filter((material) => String(material.file_type ?? '').toLowerCase().includes('pdf'))
    .map((material) => ({
      id: String(material.id),
      file_name: String(material.file_name ?? ''),
      file_type: String(material.file_type ?? ''),
    }));
}

export async function listIssuances(materialId: string): Promise<IssuanceRow[]> {
  const { data, error } = await apiFetch<{ issuances?: IssuanceRow[] }>(
    `/pdf-forensic/issuances?material_id=${encodeURIComponent(materialId)}`,
  );
  if (error) throw new Error(error.message);
  return data?.issuances ?? [];
}

/** A file chosen with expo-document-picker. */
export interface PickedPdf {
  uri: string;
  name: string;
  size: number;
  mimeType: string;
}

export interface CheckOptions {
  /** Omitted on purpose: the server resolves the issuance from the watermark payload. */
  materialId?: string;
  /** 0–100 from real transferred bytes; never called when the length is unknown. */
  onProgress?: (percent: number) => void;
  /** Stage hook so the screen can separate upload from server-side analysis. */
  onStage?: (stage: 'uploading' | 'analyzing') => void;
  /** Fired once per attempt with the measured client-side timings. */
  onTiming?: (timings: CheckTimings) => void;
  signal?: AbortSignal;
}

/**
 * Upload one PDF and read its verdict.
 *
 * A multipart body cannot go through the JSON client (`apiFetch` always sets
 * `Content-Type: application/json`), so this posts directly. It therefore has to do the two
 * things `apiFetch` normally does for us: take the session token, and refuse to start while the
 * central security lock is active.
 *
 * MATERIAL IS NOT SELECTED ANY MORE. The watermark payload identifies the issuance on its own
 * and the backend resolves student/material/course inside the caller's authorized scope; sending
 * a material id is now optional and only narrows the search.
 *
 * TRANSPORT — the SAME one the course-material upload uses.
 *
 * Both paths now go through `uploadWithProgress` + `resolveUploadPart`, so the
 * two uploads cannot drift apart again:
 *   • native  → the `{ uri, name, type }` descriptor, streamed from disk by the
 *               native networking layer (no JS buffer, no Base64);
 *   • web     → the picked File appended directly (see below).
 *
 * WHAT USED TO MAKE THIS FEEL SLOWER THAN A MATERIAL UPLOAD
 *   1. On web the file was read into JS memory (`fetch(file.uri).blob()`) before
 *      the request even started — a second full copy of an 18 MB document.
 *   2. `stage: 'analyzing'` was only entered when `xhr.onload` fired, i.e. AFTER
 *      the server had finished its forensic scan, so the screen sat on
 *      "uploading … 100 %" for the entire analysis and the whole round trip
 *      read as upload time.
 *   3. On native plain `fetch()` was used: no byte progress, no upload-complete
 *      event — an 18 MB upload and a 25 s scan were indistinguishable.
 *
 * The endpoint itself is unchanged and still synchronous: `/pdf-forensic/check`
 * receives the body, forwards the file to the VPS (`/internal/detect`, streamed
 * from disk) and returns the verdict. That analysis time is real work, not
 * upload overhead — which is why it is now measured and reported separately
 * (uploadMs vs analysisMs) instead of being disguised inside a progress bar.
 */
export async function runForensicCheck(file: PickedPdf, options: CheckOptions | string = {}): Promise<CheckResult> {
  const opts: CheckOptions = typeof options === 'string' ? { materialId: options } : options;
  const startedAt = Date.now();

  // Same central lock the storage client honours: the checker is a write path.
  if (isSecurityLocked()) throw new Error('security_lock');

  const { data: sessionResult } = await backendClient.auth.getSession();
  const token = sessionResult?.session?.access_token ?? null;

  const form = new FormData();
  if (opts.materialId) form.append('material_id', opts.materialId);
  // One shared part builder: native keeps the file-URI descriptor (streamed from
  // disk), web turns the picker's blob: URL into a real File exactly once — the
  // same rule the material upload follows.
  const part = await resolveUploadPart(
    { uri: file.uri, name: file.name, mimeType: file.mimeType || 'application/pdf' },
    Platform.OS,
  );
  if (part.kind === 'error') throw new Error(`file_unreadable: ${part.message}`);
  if (part.kind === 'descriptor') {
    form.append('file', {
      uri: part.value.uri,
      name: part.value.name ?? file.name,
      type: part.value.mimeType ?? file.mimeType ?? 'application/pdf',
    } as unknown as Blob);
  } else {
    form.append('file', part.value, file.name);
  }
  const preparedAt = Date.now();

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const url = `${backendApiBase}/pdf-forensic/check`;
  let sentBytes = 0;
  let bodySentAt = 0;
  const requestStartedAt = Date.now();

  opts.onStage?.('uploading');
  let status: number;
  let text: string;
  try {
    const res = await uploadWithProgress({
      url,
      formData: form,
      headers,
      signal: opts.signal as { aborted: boolean; addEventListener?: (t: 'abort', l: () => void) => void; removeEventListener?: (t: 'abort', l: () => void) => void } | null,
      // No artificial client timeout: the endpoint legitimately answers only
      // after the VPS scan, and a browser-side abort would be indistinguishable
      // from a real failure. The user can always cancel.
      timeoutMs: 0,
      onProgress: (p) => {
        if (!(p.totalBytes > 0)) return; // unknown length: no invented percentage
        sentBytes = p.bytesSent;
        opts.onProgress?.(Math.min(100, Math.round((p.bytesSent / p.totalBytes) * 100)));
      },
      // The true end of the upload: the body is on the wire, the verdict is not
      // ready yet. This is what switches the screen to "analysing".
      onUploadComplete: () => {
        bodySentAt = Date.now();
        opts.onStage?.('analyzing');
      },
    });
    status = res.status;
    text = res.bodyText;
  } catch (e) {
    if (e instanceof UploadTransportError) {
      throw new Error(e.code === 'TIMEOUT' ? 'timeout' : 'network_error');
    }
    if ((e as { name?: string })?.name === 'AbortError') throw new Error('aborted');
    throw new Error('network_error');
  }
  const respondedAt = Date.now();
  if (bodySentAt === 0) bodySentAt = respondedAt; // engines without upload events

  let payload: Record<string, unknown> | null = null;
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    payload = null;
  }

  const timings: CheckTimings = {
    bytesDeclared: Number(file.size) > 0 ? Number(file.size) : 0,
    bytesSent: sentBytes > 0 ? sentBytes : Number(file.size) > 0 ? Number(file.size) : 0,
    prepareMs: preparedAt - startedAt,
    uploadMs: bodySentAt - requestStartedAt,
    analysisMs: respondedAt - bodySentAt,
    totalMs: respondedAt - startedAt,
    server: (payload?.timings as ServerTimings | undefined) ?? undefined,
  };
  opts.onTiming?.(timings);

  const ok = status >= 200 && status < 300;
  if (!ok) {
    const message = typeof payload?.message === 'string' ? payload.message : null;
    if (status === 413) throw new Error('too_large');
    if (status === 422) throw new Error('not_inspectable');
    if (status === 403) throw new Error('forbidden');
    throw new Error(message ?? `http_${status}`);
  }
  if (!payload) throw new Error('invalid_response');
  return payload as unknown as CheckResult;
}
