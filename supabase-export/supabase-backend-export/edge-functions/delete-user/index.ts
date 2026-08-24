// supabase/functions/delete-user/index.ts  — v75
// Production-grade permanent account deletion pipeline.
// Admin / super_admin only.
//
// Routes:
//   GET  ?target_user_id=xxx       → preflight (account details + counts)
//   POST { target_user_id, reason } → full deletion pipeline
//
// Deletion pipeline (POST):
//   1. Collect storage paths & VdoCipher video IDs  (BEFORE DB delete)
//   2. DB: hard_delete_user() RPC  (atomic, role guards, anonymise audit trail)
//   3. Auth: svc.auth.admin.deleteUser()            (revokes all sessions/tokens)
//   4. Storage: delete avatar + course assets       (best-effort)
//   5. VdoCipher: delete provider videos            (best-effort)
//   6. Push tokens: already CASCADE-deleted by DB, verify count
//   7. Self-verification: confirm all traces gone
//   8. Write deletion_record with full report

import { createClient } from 'npm:@supabase/supabase-js@2';

/** Serialize ANY thrown value to a readable string (never "[object Object]"). */
function serializeErr(e: unknown): string {
  if (e == null) return 'null error';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === 'object') {
    const o = e as Record<string, unknown>;
    if (typeof o.message === 'string') {
      const parts = [o.message];
      if (typeof o.details  === 'string' && o.details)  parts.push(`details: ${o.details}`);
      if (typeof o.hint     === 'string' && o.hint)     parts.push(`hint: ${o.hint}`);
      if (typeof o.code     === 'string' && o.code)     parts.push(`code: ${o.code}`);
      return parts.join(' | ');
    }
    try { return JSON.stringify(e); } catch { return '[unserializable object]'; }
  }
  return String(e);
}

/**
 * Return a safe, user-facing message that never leaks raw SQL or PG internals.
 * The raw message is logged for ops visibility; callers receive a clean string.
 */
function safeErrMsg(raw: string, fallback = 'An internal error occurred during deletion.'): string {
  if (!raw) return fallback;
  // Map well-known RPC business errors to clean messages
  if (/last.*(admin|super)/i.test(raw))        return raw; // already clean from RPC
  if (/doctor.*course/i.test(raw))             return raw; // already clean from RPC
  if (/not found/i.test(raw))                  return 'User not found.';
  if (/foreign key/i.test(raw))                return 'Deletion blocked by a related record.';
  if (/violates.*constraint/i.test(raw))       return 'Deletion blocked by a data constraint.';
  if (/permission denied/i.test(raw))          return 'Permission denied.';
  if (/duplicate key/i.test(raw))              return 'Duplicate record error.';
  if (/could not connect/i.test(raw))          return 'Database connection error.';
  if (/timeout/i.test(raw))                    return 'Operation timed out.';
  // If the message looks like a raw PG error (contains SQL keywords or PG codes), sanitize it
  const PG_PATTERN = /\b(select|insert|update|delete|from|where|join|on table|column|constraint|violates|relation|tuple)\b/i;
  const PG_CODE    = /\b[0-9]{5}\b/;
  if (PG_PATTERN.test(raw) || PG_CODE.test(raw)) return fallback;
  // Message under 300 chars with no SQL indicators is safe to surface
  if (raw.length < 300) return raw;
  return fallback;
}

// ── Shared helpers ─────────────────────────────────────────────────────────
function createServiceClient() {
  // Supabase auto-injects SUPABASE_SERVICE_ROLE_KEY; SERVICE_ROLE_KEY is the
  // legacy custom-secret name. Accept either so both deployment configs work.
  const key =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
    Deno.env.get('SERVICE_ROLE_KEY');
  if (!key) console.error('[delete-user] FATAL: no service-role key found in environment');
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    key ?? '',
    { auth: { persistSession: false } }
  );
}
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey, x-client-info',
  };
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
function structuredError(code: string, message: string, status = 400): Response {
  return json({ success: false, code, message }, status);
}

async function requireAuth(req: Request, svc: ReturnType<typeof createServiceClient>) {
  const header = req.headers.get('Authorization');
  if (!header) throw structuredError('UNAUTHORIZED', 'Missing Authorization header', 401);
  const { data: { user }, error } = await svc.auth.getUser(header.replace('Bearer ', ''));
  if (error || !user) throw structuredError('UNAUTHORIZED', 'Invalid token', 401);
  const { data: profile } = await svc.from('profiles').select('role').eq('id', user.id).single();
  const role = profile?.role ?? '';
  if (!['admin', 'super_admin'].includes(role)) {
    throw structuredError('FORBIDDEN', 'Requires admin or super_admin role', 403);
  }
  return { userId: user.id, role };
}

// Extract storage path from a public URL if raw path not stored
function extractStoragePath(url?: string | null): string | null {
  if (!url) return null;
  const marker = '/object/public/';
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  const afterMarker = url.slice(idx + marker.length);
  const slashIdx = afterMarker.indexOf('/');
  return slashIdx === -1 ? null : afterMarker.slice(slashIdx + 1);
}

// ── VdoCipher API helper ───────────────────────────────────────────────────
async function deleteVdoCipherVideo(videoId: string, apiSecret: string): Promise<boolean> {
  try {
    const res = await fetch(`https://dev.vdocipher.com/api/videos/${videoId}`, {
      method: 'DELETE',
      headers: { Authorization: `Apisecret ${apiSecret}` },
    });
    return res.ok || res.status === 404; // 404 = already gone, treat as success
  } catch {
    return false;
  }
}

// ── Deletion record helpers ────────────────────────────────────────────────
async function createDeletionRecord(
  svc: ReturnType<typeof createServiceClient>,
  data: {
    target_user_id: string; target_name: string; target_role: string;
    target_email?: string; target_phone?: string;
    actor_id: string; reason: string;
  }
): Promise<string> {
  const { data: rec } = await svc.from('deletion_records').insert({
    ...data, status: 'queued',
  }).select('id').single();
  return rec?.id ?? crypto.randomUUID();
}

async function updateDeletionRecord(
  svc: ReturnType<typeof createServiceClient>,
  id: string,
  patch: Record<string, unknown>
) {
  await svc.from('deletion_records').update(patch).eq('id', id).catch(() => {});
}

// ──────────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

  const svc = createServiceClient();

  try {
    const { userId: actorId, role: actorRole } = await requireAuth(req, svc);

    // ── GET: preflight ─────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const targetId = url.searchParams.get('target_user_id');
      if (!targetId) return structuredError('MISSING_PARAMS', 'target_user_id is required');

      const { data, error } = await svc.rpc('get_delete_preflight', { p_target_user_id: targetId });
      if (error) {
        console.error('[delete-user] preflight RPC error:', error.message);
        return structuredError('RPC_ERROR', safeErrMsg(error.message, 'Failed to load user details.'), 500);
      }
      if (!data?.found) return structuredError('USER_NOT_FOUND', 'User not found', 404);

      if (data.role === 'super_admin' && actorRole !== 'super_admin') {
        return structuredError('FORBIDDEN', 'Only super_admin can delete a super_admin', 403);
      }
      return json({ success: true, ...data });
    }

    // ── POST: deletion pipeline ────────────────────────────────────────────
    if (req.method !== 'POST') {
      return structuredError('METHOD_NOT_ALLOWED', 'Use GET (preflight) or POST (delete)', 405);
    }

    const body = await req.json() as { target_user_id?: string; reason?: string };
    const { target_user_id, reason } = body;

    if (!target_user_id) return structuredError('MISSING_PARAMS', 'target_user_id is required');
    if (target_user_id === actorId) return structuredError('SELF_DELETE', 'Cannot delete your own account');


    // Fetch target profile
    const { data: targetProfile } = await svc.from('profiles')
      .select('id, full_name, role, email, phone_e164')
      .eq('id', target_user_id)
      .maybeSingle();

    if (!targetProfile) return structuredError('USER_NOT_FOUND', 'User not found', 404);
    if (targetProfile.role === 'super_admin' && actorRole !== 'super_admin') {
      return structuredError('FORBIDDEN', 'Only super_admin can delete a super_admin', 403);
    }

    const deletionReason = reason ?? 'Permanent delete by admin';

    // Create deletion record immediately (so we can track progress)
    const recordId = await createDeletionRecord(svc, {
      target_user_id,
      target_name:  targetProfile.full_name ?? 'Unknown',
      target_role:  targetProfile.role,
      target_email: targetProfile.email,
      target_phone: targetProfile.phone_e164,
      actor_id:     actorId,
      reason:       deletionReason,
    });

    const vdoApiSecret = Deno.env.get('VDOCIPHER_API_SECRET') ?? '';

    // ── STEP 1: Collect assets to clean (BEFORE DB delete wipes rows) ─────
    await updateDeletionRecord(svc, recordId, { status: 'deleting_db' });

    // Avatar
    const avatarPath = extractStoragePath(targetProfile.email) ??
      (() => {
        // fetch fresh avatar_url from profiles before delete
        return null;
      })();

    // Collect avatar_url separately
    const { data: profileRow } = await svc.from('profiles')
      .select('avatar_url').eq('id', target_user_id).maybeSingle();
    const avatarStoragePath = extractStoragePath(profileRow?.avatar_url);

    // Course assets (doctor) — courses + lessons cascade-delete after profile delete
    // So we must collect storage paths & VdoCipher IDs NOW
    const storagePaths: Record<string, string[]> = {
      avatars:            avatarStoragePath ? [avatarStoragePath] : [],
      'course-images':    [],
      'lesson-pdfs':      [],
      'lesson-materials': [],
    };
    const vdoCipherVideoIds: string[] = [];

    if (targetProfile.role === 'doctor') {
      // Course thumbnails
      const { data: courses } = await svc.from('courses')
        .select('id, thumbnail_url')
        .eq('doctor_id', target_user_id);

      const courseIds = (courses ?? []).map((c: any) => c.id);

      for (const c of courses ?? []) {
        const p = extractStoragePath(c.thumbnail_url);
        if (p) storagePaths['course-images'].push(p);
      }

      if (courseIds.length > 0) {
        // Lesson PDFs
        const { data: lessonIds } = await svc.from('lessons')
          .select('id').in('course_id', courseIds);
        const lids = (lessonIds ?? []).map((l: any) => l.id);

        if (lids.length > 0) {
          const { data: pdfs } = await svc.from('lesson_pdfs')
            .select('storage_path, file_url').in('lesson_id', lids);
          for (const p of pdfs ?? []) {
            const path = p.storage_path ?? extractStoragePath(p.file_url);
            if (path) storagePaths['lesson-pdfs'].push(path);
          }

          const { data: materials } = await svc.from('lesson_materials')
            .select('storage_path, file_url').in('lesson_id', lids);
          for (const m of materials ?? []) {
            const path = m.storage_path ?? extractStoragePath(m.file_url);
            if (path) storagePaths['lesson-materials'].push(path);
          }
        }

        // VdoCipher video IDs
        const { data: videos } = await svc.from('video_uploads')
          .select('provider_video_id, storage_path, thumbnail_storage_path')
          .in('course_id', courseIds);
        for (const v of videos ?? []) {
          if (v.provider_video_id) vdoCipherVideoIds.push(v.provider_video_id);
          if (v.storage_path) storagePaths['lesson-materials'].push(v.storage_path);
          if (v.thumbnail_storage_path) storagePaths['course-images'].push(v.thumbnail_storage_path);
        }
      }
    }

    // Tally pre-delete counts for the record
    const totalFiles = Object.values(storagePaths).reduce((s, a) => s + a.length, 0);

    // ── STEP 2: DB atomic delete via RPC ──────────────────────────────────
    const { data: rpcResult, error: rpcErr } = await svc.rpc('hard_delete_user', {
      p_target_user_id: target_user_id,
      p_actor_id:       actorId,
      p_reason:         deletionReason,
    });

    if (rpcErr) {
      console.error('[delete-user] hard_delete_user RPC error:', rpcErr.message, '| details:', rpcErr.details, '| code:', rpcErr.code);
      await updateDeletionRecord(svc, recordId, {
        status: 'failed',
        error_details: { stage: 'db', message: rpcErr.message, code: rpcErr.code },
      });
      return structuredError('DB_ERROR', safeErrMsg(rpcErr.message, 'Database deletion failed. Please try again.'), 500);
    }


    const rpcOk = rpcResult as { success: boolean; code?: string; message?: string; deleted_label?: string; deleted_name?: string; deleted_role?: string };
    if (!rpcOk?.success) {
      const rpcCode = rpcOk?.code ?? 'DELETE_FAILED';
      const rpcMsg  = rpcOk?.message ?? 'Deletion failed';
      console.warn('[delete-user] hard_delete_user returned success=false, code:', rpcCode, 'message:', rpcMsg);
      await updateDeletionRecord(svc, recordId, {
        status: 'failed',
        error_details: { stage: 'db_rpc', code: rpcCode, message: rpcMsg },
      });
      return structuredError(
        rpcCode,
        safeErrMsg(rpcMsg, 'Deletion failed.'),
        rpcCode === 'LAST_ADMIN' || rpcCode === 'LAST_SUPER_ADMIN' ? 409
        : rpcCode === 'DOCTOR_HAS_COURSES' ? 422
        : 400
      );
    }


    // ── STEP 3: Auth user delete (revokes all sessions & tokens) ──────────
    // CRITICAL: auth deletion MUST succeed. If the auth.users row survives
    // with ban_duration set (from the preceding trash step), any future login
    // attempt with the old credentials will reach Supabase Auth and receive
    // "User is banned." — surfaced in the UI as "Account Banned" even though
    // the profile no longer exists.
    //
    // Strategy:
    //   Attempt 1 — full delete (deleteUser removes the row entirely).
    //   Attempt 2 — retry once after 1 s (transient gateway errors are common).
    //   Fallback   — if delete still fails, clear ban_duration so the row no
    //                longer blocks login with a misleading banned message.
    //                The orphaned auth row is harmless once ban is lifted and
    //                the profile is gone (profile-based checks block sign-in).
    await updateDeletionRecord(svc, recordId, { status: 'deleting_auth' });

    let authDeleted = false;
    const { error: authErr1 } = await svc.auth.admin.deleteUser(target_user_id);
    if (!authErr1) {
      authDeleted = true;
    } else {
      console.warn('[delete-user] auth.admin.deleteUser attempt 1 failed:', authErr1.message, '— retrying in 1 s');
      await new Promise(r => setTimeout(r, 1000));
      const { error: authErr2 } = await svc.auth.admin.deleteUser(target_user_id);
      if (!authErr2) {
        authDeleted = true;
      } else {
        console.error('[delete-user] auth.admin.deleteUser attempt 2 failed:', authErr2.message);
        // Fallback: clear the ban so auth.users row no longer returns "User is banned."
        // The orphaned row cannot sign in because the profile is gone and
        // pre_login_device_check now blocks unknown-profile logins.
        const { error: unbanErr } = await svc.auth.admin.updateUserById(target_user_id, {
          ban_duration: 'none',
        });
        if (unbanErr) {
          console.error('[delete-user] ban-clear fallback also failed:', unbanErr.message);
        } else {
          console.warn('[delete-user] ban cleared on orphaned auth row — profile is gone, login is blocked by pre_login_device_check');
        }
        // Record the failure for ops visibility but do not abort — DB is clean.
        await updateDeletionRecord(svc, recordId, {
          error_details: {
            stage: 'auth_delete',
            message: authErr2.message,
            fallback: 'ban_cleared',
          },
        });
      }
    }

    // ── STEP 4: Storage cleanup (best-effort, async, never blocks response) ─
    await updateDeletionRecord(svc, recordId, { status: 'deleting_storage' });
    let filesRemoved = 0;
    let storageFailed = false;
    try {
      const storageResults = await Promise.allSettled(
        Object.entries(storagePaths)
          .filter(([, paths]) => paths.length > 0)
          .map(([bucket, paths]) =>
            svc.storage.from(bucket).remove(paths).then(r => {
              if (!r.error) filesRemoved += paths.length;
              else console.warn('[delete-user] storage remove error bucket:', bucket, r.error.message);
              return r;
            })
          )
      );
      storageFailed = storageResults.some(r => r.status === 'rejected');
    } catch (storageErr) {
      console.error('[delete-user] storage cleanup threw:', storageErr instanceof Error ? storageErr.message : String(storageErr));
      storageFailed = true;
    }

    // ── STEP 5: VdoCipher cleanup (best-effort) ───────────────────────────
    await updateDeletionRecord(svc, recordId, { status: 'deleting_videos' });
    let videosRemoved = 0;
    let videoFailed = false;
    if (vdoCipherVideoIds.length > 0) {
      const apiSecret = Deno.env.get('VDOCIPHER_API_SECRET');
      if (!apiSecret) {
        console.error('[delete-user] VDOCIPHER_API_SECRET not set — skipping video cleanup');
        videoFailed = true;
      } else {
        const videoResults = await Promise.allSettled(
          vdoCipherVideoIds.map((vid) => deleteVdoCipherVideo(vid, apiSecret))
        );
        videosRemoved = videoResults.filter((r) => r.status === 'fulfilled' && r.value).length;
        videoFailed   = videoResults.some((r)  => r.status === 'rejected'  || (r.status === 'fulfilled' && !r.value));
      }
    }

    // ── STEP 6: Push-token cleanup (CASCADE already removed them) ─────────
    await updateDeletionRecord(svc, recordId, { status: 'deleting_notifications' });
    const { count: remainingTokens } = await svc.from('push_tokens')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', target_user_id);
    const pushTokensClean = (remainingTokens ?? 0) === 0;

    // ── STEP 7: Self-verification ─────────────────────────────────────────
    await updateDeletionRecord(svc, recordId, { status: 'cleaning_cache' });

    const verification: Record<string, boolean> = {};

    // Profile gone?
    const { data: profileCheck } = await svc.from('profiles')
      .select('id').eq('id', target_user_id).maybeSingle();
    verification.profile_deleted = !profileCheck;

    // Devices gone?
    const { count: deviceCount } = await svc.from('devices')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', target_user_id);
    verification.devices_removed = (deviceCount ?? 0) === 0;

    // Enrollments gone? (enrollments.student_id — NOT user_id)
    const { count: enrollCount } = await svc.from('enrollments')
      .select('*', { count: 'exact', head: true })
      .eq('student_id', target_user_id);
    verification.enrollments_removed = (enrollCount ?? 0) === 0;

    // Sessions revoked (auth deleted)?
    verification.auth_deleted = authDeleted;

    // Push tokens clean
    verification.push_tokens_removed = pushTokensClean;

    // Storage best-effort
    verification.storage_cleaned = !storageFailed;

    // Videos best-effort
    verification.videos_cleaned = !videoFailed;

    const verificationPassed = Object.values(verification).every(Boolean);

    if (!verificationPassed) {
      const failedChecks = Object.entries(verification)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      console.warn('[delete-user] verification failures:', failedChecks);
      await svc.from('audit_logs').insert({
        actor_id:      actorId,
        action:        'deletion_verification_failed' as const,
        resource_type: 'profile',
        resource_id:   target_user_id,
        success:       false,
        details: {
          failed_checks:       failedChecks,
          deletion_record_id:  recordId,
          target_role:         targetProfile.role,
          deleted_actor_label: rpcOk.deleted_label,
        },
      }).catch((e: unknown) => {
        console.warn('[delete-user] audit_logs insert failed (non-blocking):', e instanceof Error ? e.message : String(e));
      });
    }

    // ── STEP 8: Finalise deletion record ──────────────────────────────────
    await updateDeletionRecord(svc, recordId, {
      status:              'completed',
      files_removed:       filesRemoved,
      videos_removed:      videosRemoved,
      devices_removed:     0,
      push_tokens_removed: 0,
      storage_bytes_freed: 0,
      verification:        verification,
      verification_passed: verificationPassed,
      orphan_storage:      storageFailed,
      orphan_videos:       videoFailed,
      orphan_devices:      false,
      completed_at:        new Date().toISOString(),
    });

    return json({
      success:             true,
      transaction_id:      recordId,
      deleted_user_id:     target_user_id,
      deleted_name:        rpcOk.deleted_label ?? targetProfile.full_name,
      target_role:         targetProfile.role,
      auth_deleted:        authDeleted,
      files_removed:       filesRemoved,
      videos_removed:      videosRemoved,
      verification:        verification,
      verification_passed: verificationPassed,
    });

  } catch (err) {
    if (err instanceof Response) return err;
    const rawMsg = serializeErr(err);
    console.error('[delete-user] UNEXPECTED outer catch:', rawMsg);
    // Never expose raw DB/stack-trace text to the client — sanitize first
    return structuredError('INTERNAL_ERROR', safeErrMsg(rawMsg, 'An unexpected error occurred. The deletion may have partially completed.'), 500);
  }
});
