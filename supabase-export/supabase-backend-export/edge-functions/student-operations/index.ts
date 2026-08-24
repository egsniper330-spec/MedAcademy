// supabase/functions/student-operations/index.ts
//
// Unified atomic entry point for ALL student account + activation operations.
// Self-contained — no _shared imports to avoid bundler path issues.
//
// ── Modes ────────────────────────────────────────────────────────────────────
//  A  create_only               → Auth User + Profile + Audit
//  B  create_and_enroll_credits → A + lock credits + enroll + deduct + ledger
//  C  create_and_enroll_code    → A + validate code + enroll + redeem
//  D  enroll_existing_credits   → existing student + credits path
//  E  enroll_existing_code      → existing student + code path
//
// ── Transaction safety ───────────────────────────────────────────────────────
//  Auth user creation (Admin API) is pre-DB.
//  All DB work runs in ONE atomic SECURITY DEFINER RPC (process_student_activation).
//  On any DB failure after auth creation → auth user is deleted (rollback).
//
// ── Error format ─────────────────────────────────────────────────────────────
//  { code, message, step, details }

import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Inline helpers (avoids _shared/ bundler path issues) ─────────────────────

function createServiceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );
}

async function requireAuth(req: Request): Promise<{ userId: string; role: string }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) throw new Response('Missing Authorization header', { status: 401 });
  const svc = createServiceClient();
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await svc.auth.getUser(token);
  if (error || !user) throw new Response('Invalid token', { status: 401 });
  const { data: profile } = await svc.from('profiles').select('role').eq('id', user.id).single();
  return { userId: user.id, role: profile?.role ?? 'student' };
}

function requireRole(role: string, allowed: string[]): void {
  if (!allowed.includes(role)) {
    throw new Response(`Forbidden: requires ${allowed.join(' or ')}`, { status: 403 });
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-idempotency-key, apikey, x-client-info',
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function normalizePhoneE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.replace(/\s|-/g, '').trim();
  if (!raw) return null;
  if (/^\+[1-9]\d{6,14}$/.test(raw)) return raw;
  if (/^00[1-9]\d{6,14}$/.test(raw)) return '+' + raw.slice(2);
  if (/^0[1-9]\d{9}$/.test(raw)) return '+20' + raw.slice(1);
  if (/^20[1-9]\d{9}$/.test(raw)) return '+' + raw;
  if (/^[1-9]\d{8,9}$/.test(raw)) return '+20' + raw;
  return null;
}

function structuredError(code: string, message: string, step: string, details?: unknown, status = 400): Response {
  return json({ code, message, step, details: details ?? null }, status);
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Mode =
  | 'create_only'
  | 'create_and_enroll_credits'
  | 'create_and_enroll_code'
  | 'enroll_existing_credits'
  | 'enroll_existing_code';

interface RequestBody {
  mode: Mode;
  full_name?: string;
  email?: string;
  phone?: string;
  password?: string;
  university_id?: string;
  faculty_id?: string;
  academic_level_id?: string;
  student_id?: string;
  course_id?: string;
  activation_code?: string;
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let newUserId: string | null = null;
  const svc = createServiceClient();

  try {
    const { userId: actorId, role: actorRole } = await requireAuth(req);
    requireRole(actorRole, ['doctor', 'admin', 'super_admin']);

    const body = (await req.json()) as RequestBody;
    const { mode } = body;

    if (!mode) return structuredError('MISSING_MODE', 'mode is required', 'validation');

    const needsNewStudent = mode === 'create_only' ||
      mode === 'create_and_enroll_credits' ||
      mode === 'create_and_enroll_code';
    const needsActivation = mode !== 'create_only';

    // ── Validation ──────────────────────────────────────────────────────────────
    if (needsNewStudent) {
      if (!body.full_name?.trim())
        return structuredError('MISSING_FIELD', 'full_name is required', 'validation');
      if (!body.password || body.password.length < 6)
        return structuredError('WEAK_PASSWORD', 'Password must be at least 6 characters', 'validation');
      if (!body.email?.trim() && !body.phone?.trim())
        return structuredError('MISSING_CONTACT', 'At least one of email or phone is required', 'validation');
    }
    if (!needsNewStudent && !body.student_id)
      return structuredError('MISSING_STUDENT', 'student_id is required', 'validation');
    if (needsActivation && !body.course_id)
      return structuredError('MISSING_COURSE', 'course_id is required', 'validation');
    if ((mode === 'create_and_enroll_code' || mode === 'enroll_existing_code') && !body.activation_code?.trim())
      return structuredError('MISSING_CODE', 'activation_code is required', 'validation');

    // ── Step 1: Create Auth User + Profile (modes A/B/C) ───────────────────────
    let studentId = body.student_id ?? '';

    if (needsNewStudent) {
      const phoneE164 = body.phone ? normalizePhoneE164(body.phone.trim()) : null;
      const authEmail = body.email?.trim().toLowerCase() ||
        `phone_${(phoneE164 ?? body.phone?.trim() ?? '').replace(/\D/g, '')}@medacademy.internal`;

      // 1a. Create auth user (Admin API — must happen before DB transaction).
      //     Pass phone so auth.users.phone is populated and phone-based login works.
      //     Also include phone in user_metadata so the handle_new_user trigger
      //     creates the profile row with phone set immediately.
      const { data: authData, error: authError } = await svc.auth.admin.createUser({
        email:         authEmail,
        phone:         phoneE164 ?? undefined,  // enables signInWithPassword({ phone, password })
        phone_confirm: true,                    // skip OTP — doctor pre-confirms for the student
        password:      body.password!,
        email_confirm: true,
        user_metadata: {
          full_name: body.full_name!.trim(),
          phone:     body.phone?.trim() ?? '',   // captured by handle_new_user trigger
        },
      });

      if (authError || !authData?.user) {
        return structuredError(
          'AUTH_CREATE_FAILED',
          authError?.message ?? 'Failed to create auth user',
          'auth_user_creation',
          authError
        );
      }

      newUserId = authData.user.id;
      studentId = newUserId;

      // 1b. Upsert profile
      const { error: profileError } = await svc.from('profiles').upsert({
        id:                   newUserId,
        email:                authEmail,
        full_name:            body.full_name!.trim(),
        phone:                phoneE164 ?? body.phone?.trim() ?? null,
        phone_e164:           phoneE164,
        role:                 'student',
        status:               'active',
        university_id:        body.university_id ?? null,
        faculty_id:           body.faculty_id ?? null,
        academic_level_id:    body.academic_level_id ?? null,
        force_password_change: true,
        created_by_doctor_id: actorRole === 'doctor' ? actorId : null,
      }, { onConflict: 'id' });

      if (profileError) {
        // Rollback auth user
        await svc.auth.admin.deleteUser(newUserId);
        newUserId = null;
        return structuredError('PROFILE_CREATE_FAILED', profileError.message, 'profile_upsert', profileError);
      }
    }

    // ── Step 2: Atomic DB activation via SECURITY DEFINER RPC (modes B/C/D/E) ──
    //    process_student_activation runs ONE PG transaction:
    //      enroll_credits → lock credits → deduct → enroll → ledger → audit
    //      enroll_code    → validate code → redeem → enroll → audit
    if (needsActivation) {
      const dbMode = (mode === 'create_and_enroll_credits' || mode === 'enroll_existing_credits')
        ? 'enroll_credits'
        : 'enroll_code';

      const { data: activationResult, error: activationError } = await svc.rpc(
        'process_student_activation',
        {
          p_mode:       dbMode,
          p_doctor_id:  actorId,
          p_student_id: studentId,
          p_course_id:  body.course_id,
          p_code:       body.activation_code?.trim().toUpperCase() ?? null,
        }
      );

      if (activationError) {
        // Rollback: delete newly-created auth user if applicable
        if (newUserId) {
          await svc.auth.admin.deleteUser(newUserId);
          newUserId = null;
        }
        const pgMsg = activationError.message ?? '';
        const errCode = pgMsg.split(':')[0].trim() || 'ACTIVATION_FAILED';
        return structuredError(errCode, pgMsg, 'db_activation', activationError);
      }

      const result = activationResult as { success?: boolean; idempotent?: boolean; error?: string } | null;
      if (result?.success === false) {
        if (newUserId) await svc.auth.admin.deleteUser(newUserId);
        return structuredError('ACTIVATION_FAILED', result.error ?? 'Activation failed', 'db_activation', result);
      }

      // Idempotent means the student already has an ACTIVE enrollment for this course.
      // No credit was deducted and no duplicate was created.
      // For new-student modes (B/C), roll back the just-created auth user since
      // no enrollment was made — the caller must be informed to avoid orphan accounts.
      if (result?.idempotent === true) {
        if (newUserId) {
          await svc.auth.admin.deleteUser(newUserId);
          newUserId = null;
        }
        return structuredError(
          'ALREADY_ENROLLED',
          'This student is already subscribed to this course.',
          'db_activation',
          null,
          409
        );
      }

      // Non-blocking audit for new student creation
      if (needsNewStudent) {
        svc.from('audit_logs').insert({
          actor_id: actorId, action: 'student_created_by_doctor',
          resource_type: 'profile', resource_id: studentId,
          details: { mode, course_id: body.course_id, created_by_role: actorRole },
        }).then(() => {}).catch(() => {});
      }

      // ── Build response payload — never expose internal email ─────────────────
      // login_type drives the success screen: 'email' | 'phone' | 'both'
      const realEmail   = body.email?.trim().toLowerCase() || null;
      const phoneE164Out = body.phone ? normalizePhoneE164(body.phone.trim()) : null;
      const phoneDisplay = phoneE164Out
        ? phoneE164Out.replace(/^\+20/, '0')  // Egypt local display
        : body.phone?.trim().replace(/\D/g, '') || null;
      const loginType  = realEmail && phoneDisplay ? 'both'
                       : realEmail                 ? 'email'
                       : 'phone';

      return json({
        success: true,
        mode,
        student_id:    studentId,
        email:         realEmail,       // null for phone-only — never send internal addr
        phone:         phoneDisplay,
        phone_e164:    phoneE164Out,
        login_type:    loginType,
        activation:    activationResult,
      });
    }

    // ── Mode A: create_only ────────────────────────────────────────────────────
    svc.from('audit_logs').insert({
      actor_id: actorId, action: 'student_created_by_doctor',
      resource_type: 'profile', resource_id: studentId,
      details: { mode, created_by_role: actorRole, force_password_change: true },
    }).then(() => {}).catch(() => {});

    const realEmail   = body.email?.trim().toLowerCase() || null;
    const phoneE164Out = body.phone ? normalizePhoneE164(body.phone.trim()) : null;
    const phoneDisplay = phoneE164Out
      ? phoneE164Out.replace(/^\+20/, '0')
      : body.phone?.trim().replace(/\D/g, '') || null;
    const loginType  = realEmail && phoneDisplay ? 'both'
                     : realEmail                 ? 'email'
                     : 'phone';

    return json({
      success: true, mode, student_id: studentId,
      email:      realEmail,
      phone:      phoneDisplay,
      phone_e164: phoneE164Out,
      login_type: loginType,
    });

  } catch (err) {
    if (newUserId) { try { await svc.auth.admin.deleteUser(newUserId); } catch (_) {} }
    if (err instanceof Response) return err;
    return structuredError('INTERNAL_ERROR', String(err), 'unexpected', null, 500);
  }
});
