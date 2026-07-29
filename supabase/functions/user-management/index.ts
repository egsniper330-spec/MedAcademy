// supabase/functions/user-management/index.ts
// Create users (student | doctor | assistant | admin | super_admin) — role-gated.

import { requireAuth, requireRole, createServiceClient, json, corsHeaders } from '../_shared/auth.ts';
import { normalizePhoneE164 } from '../_shared/phone.ts';

/** Strings that supabase-js / GoTrue emit when the real error body is absent. */
const EMPTY_MSG = new Set(['{}', 'null', '[object Object]', 'undefined', '']);

/** Extract a readable string from ANY thrown value — never returns "[object Object]" or "{}". */
function extractErrMsg(e: unknown, fallback = 'An unexpected error occurred.'): string {
  if (e == null) return fallback;
  if (typeof e === 'string') return EMPTY_MSG.has(e) ? fallback : e || fallback;
  if (e instanceof Error) {
    // supabase-js AuthApiError.message is set to JSON.stringify(body) when GoTrue
    // returns an empty error body — guard against that here.
    const msg = e.message;
    if (msg && !EMPTY_MSG.has(msg)) return msg;
    // Fall through to field inspection for AuthApiError subclasses
  }
  if (typeof e === 'object') {
    const o = e as Record<string, unknown>;
    // Check status/code first so we emit something meaningful even when message is "{}"
    const statusCode = typeof o.status === 'number' ? o.status : null;
    const rawMsg =
      (typeof o.message === 'string' && o.message && !EMPTY_MSG.has(o.message) && o.message) ||
      (typeof o.msg     === 'string' && o.msg     && !EMPTY_MSG.has(o.msg)     && o.msg)     ||
      (typeof o.error   === 'string' && o.error   && !EMPTY_MSG.has(o.error)   && o.error)   ||
      (typeof o.details === 'string' && o.details && !EMPTY_MSG.has(o.details) && o.details);
    if (rawMsg) return rawMsg;
    if (statusCode) return `${fallback} (HTTP ${statusCode})`;
    try {
      const s = JSON.stringify(e);
      if (s && !EMPTY_MSG.has(s)) return s;
    } catch { /* unserializable */ }
  }
  return fallback;
}

const ACTION_ROLE_MAP: Record<string, string> = {
  create_user:              'student',
  create_student_by_doctor: 'student',
  create_doctor:            'doctor',
  create_admin:             'admin',
  create_super_admin:       'super_admin',
};

const ACTOR_CAN_CREATE: Record<string, string[]> = {
  doctor:      ['student'],
  admin:       ['student', 'doctor'],
  super_admin: ['student', 'doctor', 'admin', 'super_admin'],
};

Deno.serve(async (req: Request) => {
  // Outermost CORS safety net: even if the handler itself crashes, always return
  // CORS headers so the client gets a readable error instead of HTTP 0 / FunctionsFetchError.
  const safeCors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-idempotency-key, apikey, x-client-info',
  };

  if (req.method === 'OPTIONS') return new Response(null, { headers: safeCors });
  if (req.method !== 'POST') return new Response(
    JSON.stringify({ error: 'Method not allowed' }),
    { status: 405, headers: { 'Content-Type': 'application/json', ...safeCors } },
  );

  try {
    const { userId: actorId, role: actorRole } = await requireAuth(req);
    requireRole(actorRole, ['doctor', 'admin', 'super_admin']);

    const body = await req.json();
    const {
      action,
      full_name,
      email,
      phone,
      phone_country_code,
      phone_national,
      password,
      university_id,
      faculty_id,
      academic_level_id,
      status = 'active',
    } = body as Record<string, string>;

    if (!action) return json({ error: 'action is required' }, 400);
    if (!full_name?.trim()) return json({ error: 'full_name is required' }, 400);
    if (!password || password.length < 6) return json({ error: 'password must be at least 6 characters' }, 400);

    const isDoctorAction = action === 'create_student_by_doctor';

    if (isDoctorAction) {
      if (!email?.trim() && !phone?.trim()) {
        return json({ error: 'At least one of email or phone is required' }, 400);
      }
    } else {
      if (!email?.trim()) return json({ error: 'email is required' }, 400);
    }

    const targetRole = ACTION_ROLE_MAP[action];
    if (!targetRole) return json({ error: `Unknown action: ${action}` }, 400);

    const allowedTargetRoles = ACTOR_CAN_CREATE[actorRole] ?? [];
    if (!allowedTargetRoles.includes(targetRole)) {
      return json({ error: `${actorRole} cannot create accounts with role: ${targetRole}` }, 403);
    }

    const supabase = createServiceClient();
    const phoneE164 = phone ? normalizePhoneE164(phone.trim()) : null;
    const authEmail = email?.trim().toLowerCase() ||
      `phone_${(phoneE164 ?? phone?.trim() ?? '').replace(/\D/g, '')}@medacademy.internal`;

    // ── Create auth user ─────────────────────────────────────────────────────
    let authData: Awaited<ReturnType<typeof supabase.auth.admin.createUser>>['data'];
    let authError: Awaited<ReturnType<typeof supabase.auth.admin.createUser>>['error'];
    try {
      const createPayload: Parameters<typeof supabase.auth.admin.createUser>[0] = {
        email:         authEmail,
        password,
        email_confirm: true,
        user_metadata: {
          full_name:          full_name.trim(),
          phone:              phoneE164 ?? phone?.trim() ?? null,
          phone_country_code: phone_country_code?.trim() ?? null,
          phone_national:     phone_national?.trim() ?? null,
        },
      };
      const resolvedPhone = phoneE164 ?? phone?.trim() ?? null;
      if (resolvedPhone) {
        (createPayload as Record<string, unknown>).phone         = resolvedPhone;
        (createPayload as Record<string, unknown>).phone_confirm = true;
      }
      const result = await supabase.auth.admin.createUser(createPayload);
      authData  = result.data;
      authError = result.error;
    } catch (createErr: unknown) {
      console.error('[user-management] auth.admin.createUser threw:', extractErrMsg(createErr));
      throw createErr;
    }

    if (authError || !authData?.user) {
      const ae = authError as unknown as Record<string, unknown> | null;
      const rawBody = (() => { try { return JSON.stringify(authError); } catch { return '(unserializable)'; } })();
      console.error('[user-management] auth.admin.createUser error:', {
        message: authError?.message,
        status:  ae?.status,
        code:    ae?.code,
        rawBody,
      });
      const status2 = typeof ae?.status === 'number' ? (ae.status as number) : 500;
      const errMsg  = extractErrMsg(authError, `Failed to create auth user (HTTP ${status2})`);
      return json({ error: errMsg }, 400);
    }

    const newUserId = authData.user.id;

    // ── Create profile ───────────────────────────────────────────────────────
    const profilePayload: Record<string, unknown> = {
      id:                newUserId,
      email:             authEmail,
      profile_email:     email?.trim().toLowerCase() || null,
      full_name:         full_name.trim(),
      phone:             phoneE164 ?? phone?.trim() ?? null,
      phone_e164:        phoneE164,
      phone_country_code: phone_country_code?.trim() ?? null,
      phone_national:    phone_national?.trim() ?? null,
      role:              targetRole,
      status,
      university_id:     university_id     ?? null,
      faculty_id:        faculty_id        ?? null,
      academic_level_id: academic_level_id ?? null,
    };

    if (isDoctorAction) {
      profilePayload.force_password_change = true;
      profilePayload.created_by_doctor_id  = actorId;
    }

    const { error: profileError } = await supabase
      .from('profiles')
      .upsert(profilePayload, { onConflict: 'id' });

    if (profileError) {
      console.error('[user-management] profile upsert failed:', {
        message: profileError.message,
        code:    profileError.code,
      });
      await supabase.auth.admin.deleteUser(newUserId).catch((delErr: unknown) => {
        console.error('[user-management] rollback auth delete failed:', extractErrMsg(delErr));
      });
      return json({ error: extractErrMsg(profileError, 'Failed to create user profile.') }, 500);
    }

    // ── Audit log ────────────────────────────────────────────────────────────
    let actorName = 'Unknown';
    try {
      const { data: actorProfile } = await supabase
        .from('profiles').select('full_name').eq('id', actorId).single();
      actorName = actorProfile?.full_name ?? 'Unknown';
    } catch (_) {}

    const roleLabel = targetRole.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const auditDescription = isDoctorAction
      ? `${actorName} created a new student account for ${full_name.trim()}`
      : `${actorName} created a new ${roleLabel} account for ${full_name.trim()} (${email?.trim() ?? phone?.trim() ?? 'no contact'})`;

    try {
      await supabase.from('audit_logs').insert({
        actor_id:      actorId,
        actor_name:    actorName,
        action: isDoctorAction ? 'student_created_by_doctor'
          : targetRole === 'doctor'      ? 'doctor_created'
          : targetRole === 'admin'       ? 'admin_created'
          : targetRole === 'super_admin' ? 'super_admin_created'
          : 'user_created',
        resource_type: 'profile',
        resource_id:   newUserId,
        target_user_id: newUserId,
        target_name:   full_name.trim(),
        description:   auditDescription,
        new_values: {
          full_name: full_name.trim(),
          email:     email?.trim().toLowerCase() ?? null,
          phone:     phoneE164 ?? phone?.trim() ?? null,
          role:      targetRole,
          status,
        },
        details: {
          created_by_role:       actorRole,
          force_password_change: isDoctorAction,
          temp_password_set:     isDoctorAction,
        },
        log_status: 'success',
      });
    } catch (auditErr: unknown) {
      console.warn('[user-management] audit log failed (non-blocking):', extractErrMsg(auditErr));
    }

    return json({ success: true, user_id: newUserId, role: targetRole, email: email?.trim().toLowerCase() || null });

  } catch (err) {
    if (err instanceof Response) return err;
    const errMsg = extractErrMsg(err, 'An unexpected error occurred during user creation.');
    console.error('[user-management] outer catch:', errMsg);
    return new Response(
      JSON.stringify({ error: errMsg }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...safeCors } },
    );
  }
});
