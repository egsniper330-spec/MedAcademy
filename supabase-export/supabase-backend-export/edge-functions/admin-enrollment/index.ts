// supabase/functions/admin-enrollment/index.ts
//
// Admin & Super Admin enrollment management endpoint.
//
// ── Actions ──────────────────────────────────────────────────────────────────
//  enroll     → admin_enroll_student(student_id, course_id, actor_id, hidden?)
//  remove     → admin_remove_enrollment(enrollment_id, actor_id)
//  set_hidden → set_enrollment_hidden_flag(enrollment_id, hidden, actor_id)
//               *** super_admin only ***
//  search     → search users by name / email / watermark_id / user_id
//  courses    → list all courses (any doctor) for the admin picker
//  enrollments→ list enrollments for a course (with hidden flag for admins)
//
// ── Security ─────────────────────────────────────────────────────────────────
//  Every request is validated server-side:
//    1. JWT must be present and valid.
//    2. Caller's role must be 'admin' or 'super_admin' — rejected otherwise.
//    3. hidden_from_instructor flag only accepted from super_admin callers.
//    4. DB RPCs are SECURITY DEFINER and only GRANT to service_role.
//  Frontend role checks are supplementary only.

import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createServiceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, apikey, x-client-info',
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function err(code: string, message: string, status = 400): Response {
  return json({ error: true, code, message }, status);
}

async function requireAdminActor(
  req: Request,
): Promise<{ actorId: string; actorRole: string }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    throw err('UNAUTHORIZED', 'Missing Authorization header', 401);
  }

  const svc = createServiceClient();
  const token = authHeader.replace('Bearer ', '');

  const {
    data: { user },
    error: userErr,
  } = await svc.auth.getUser(token);
  if (userErr || !user) {
    throw err('UNAUTHORIZED', 'Invalid or expired token', 401);
  }

  const { data: profile, error: profErr } = await svc
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profErr || !profile) {
    throw err('UNAUTHORIZED', 'Could not verify role', 401);
  }

  const role = profile.role as string;
  if (role !== 'admin' && role !== 'super_admin') {
    throw err(
      'FORBIDDEN',
      'You do not have permission to perform this action.',
      403,
    );
  }

  return { actorId: user.id, actorRole: role };
}

// ── Action handlers ───────────────────────────────────────────────────────────

const VALID_VISIBILITY = ['all', 'admin_only', 'super_admin_only'] as const;
type VisibilityLevel = typeof VALID_VISIBILITY[number];

function resolveVisibility(actorRole: string, raw: unknown): VisibilityLevel {
  // Only super_admin may set non-default visibility
  if (actorRole !== 'super_admin') return 'all';
  if (typeof raw === 'string' && VALID_VISIBILITY.includes(raw as VisibilityLevel)) {
    return raw as VisibilityLevel;
  }
  return 'all';
}

async function handleEnroll(
  svc: ReturnType<typeof createServiceClient>,
  actorId: string,
  actorRole: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const { student_id, course_id } = body;

  if (!student_id || typeof student_id !== 'string') {
    return err('VALIDATION', 'student_id is required');
  }
  if (!course_id || typeof course_id !== 'string') {
    return err('VALIDATION', 'course_id is required');
  }

  const visibilityLevel = resolveVisibility(actorRole, body.visibility_level);

  const { data, error } = await svc.rpc('admin_enroll_student', {
    p_student_id:       student_id,
    p_course_id:        course_id,
    p_actor_id:         actorId,
    p_visibility_level: visibilityLevel,
  });

  if (error) {
    const msg = error.message ?? '';
    if (msg.includes('STUDENT_NOT_FOUND')) return err('STUDENT_NOT_FOUND', 'Student not found or is suspended', 404);
    if (msg.includes('COURSE_NOT_FOUND'))  return err('COURSE_NOT_FOUND', 'Course not found', 404);
    if (msg.includes('INVALID_VISIBILITY')) return err('VALIDATION', msg, 400);
    return err('DB_ERROR', msg, 500);
  }

  const result = data as { success: boolean; idempotent?: boolean; enrollment_id?: string; visibility_level?: string };

  if (result.idempotent) {
    return json({ success: true, already_enrolled: true, message: 'This user is already enrolled in this course.' });
  }

  return json({
    success:          true,
    already_enrolled: false,
    enrollment_id:    result.enrollment_id,
    visibility_level: visibilityLevel,
    message:          'User enrolled successfully.',
  });
}

async function handleRemove(
  svc: ReturnType<typeof createServiceClient>,
  actorId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const { enrollment_id } = body;

  if (!enrollment_id || typeof enrollment_id !== 'string') {
    return err('VALIDATION', 'enrollment_id is required');
  }

  const { data, error } = await svc.rpc('admin_remove_enrollment', {
    p_enrollment_id: enrollment_id,
    p_actor_id:      actorId,
  });

  if (error) {
    const msg = error.message ?? '';
    if (msg.includes('NOT_FOUND')) {
      return err('NOT_FOUND', 'Enrollment not found', 404);
    }
    return err('DB_ERROR', msg, 500);
  }

  return json({
    success: true,
    ...(data as object),
    message: 'Enrollment removed successfully.',
  });
}

async function handleSearch(
  svc: ReturnType<typeof createServiceClient>,
  body: Record<string, unknown>,
): Promise<Response> {
  const q = (body.query as string | undefined)?.trim() ?? '';

  if (!q) {
    return json({ users: [] });
  }

  // Search by user_id (exact UUID match)
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(q)) {
    const { data } = await svc
      .from('profiles')
      .select('id, full_name, email, profile_email, phone, phone_e164, phone_national, role, status, watermark_id, avatar_url')
      .eq('id', q)
      .limit(1);
    return json({ users: data ?? [] });
  }

  // Search by watermark_id — WM-NNNN format (sequential numeric, case-insensitive)
  // Matches exact "WM-4821" or partial "4821" or "wm-4821"
  const wmPattern = /^(WM-)?[0-9]+$/i;
  if (wmPattern.test(q)) {
    const wmQ = q.toUpperCase().startsWith('WM-') ? q.toUpperCase() : `WM-%${q}`;
    const { data } = await svc
      .from('profiles')
      .select('id, full_name, email, profile_email, phone, phone_e164, phone_national, role, status, watermark_id, avatar_url')
      .ilike('watermark_id', wmQ)
      .limit(10);
    return json({ users: data ?? [] });
  }

  // Full-text search across all identity fields including all phone representations
  const likeQ = `%${q}%`;
  const { data } = await svc
    .from('profiles')
    .select('id, full_name, email, profile_email, phone, phone_e164, phone_national, role, status, watermark_id, avatar_url')
    .or(
      `full_name.ilike.${likeQ},email.ilike.${likeQ},profile_email.ilike.${likeQ},phone.ilike.${likeQ},phone_e164.ilike.${likeQ},phone_national.ilike.${likeQ},watermark_id.ilike.${likeQ}`,
    )
    .order('full_name', { ascending: true })
    .limit(20);

  return json({ users: data ?? [] });
}

async function handleSetHidden(
  svc: ReturnType<typeof createServiceClient>,
  actorId: string,
  actorRole: string,
  body: Record<string, unknown>,
): Promise<Response> {
  // Only super_admin may change visibility
  if (actorRole !== 'super_admin') {
    return err('FORBIDDEN', 'Only Super Admins can change enrollment visibility', 403);
  }

  const { enrollment_id, visibility_level } = body;
  if (!enrollment_id || typeof enrollment_id !== 'string') {
    return err('VALIDATION', 'enrollment_id is required');
  }
  if (!visibility_level || !VALID_VISIBILITY.includes(visibility_level as VisibilityLevel)) {
    return err('VALIDATION', `visibility_level must be one of: ${VALID_VISIBILITY.join(', ')}`);
  }

  const { data, error } = await svc.rpc('set_enrollment_visibility', {
    p_enrollment_id:   enrollment_id,
    p_visibility_level: visibility_level as string,
    p_actor_id:        actorId,
  });

  if (error) {
    const msg = error.message ?? '';
    if (msg.includes('NOT_FOUND')) return err('NOT_FOUND', 'Enrollment not found', 404);
    if (msg.includes('INVALID_VISIBILITY')) return err('VALIDATION', msg, 400);
    return err('DB_ERROR', msg, 500);
  }

  return json({
    success:          true,
    enrollment_id,
    visibility_level,
    message: `Enrollment visibility set to '${visibility_level}'.`,
    ...(data as object),
  });
}

async function handleCourses(
  svc: ReturnType<typeof createServiceClient>,
): Promise<Response> {
  const { data, error } = await svc
    .from('courses')
    .select('id, title, status, doctor:profiles!courses_doctor_id_fkey(id, full_name)')
    .order('title', { ascending: true })
    .limit(500);

  if (error) return err('DB_ERROR', error.message, 500);
  return json({ courses: data ?? [] });
}

async function handleEnrollments(
  svc: ReturnType<typeof createServiceClient>,
  actorRole: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const { course_id } = body;
  if (!course_id || typeof course_id !== 'string') {
    return err('VALIDATION', 'course_id is required');
  }

  // Admins and super_admins see the visibility_level field
  const selectFields = [
    'id', 'student_id', 'course_id', 'enrolled_at', 'enrollment_method',
    'status', 'enrolled_by', 'visibility_level',
    'student:profiles!enrollments_student_id_fkey(id, full_name, email, profile_email, watermark_id, role)',
  ].join(', ');

  const { data, error } = await svc
    .from('enrollments')
    .select(selectFields)
    .eq('course_id', course_id)
    .order('enrolled_at', { ascending: false })
    .limit(200);

  if (error) return err('DB_ERROR', error.message, 500);
  return json({ enrollments: data ?? [] });
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== 'POST') {
    return err('METHOD_NOT_ALLOWED', 'Only POST is supported', 405);
  }

  let actorId: string;
  let actorRole: string;
  try {
    const result = await requireAdminActor(req);
    actorId = result.actorId;
    actorRole = result.actorRole;
  } catch (errResp) {
    if (errResp instanceof Response) return errResp;
    return err('INTERNAL', 'Authentication error', 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err('INVALID_JSON', 'Request body must be valid JSON');
  }

  const action = body.action as string | undefined;
  const svc = createServiceClient();

  switch (action) {
    case 'enroll':
      return handleEnroll(svc, actorId, actorRole, body);
    case 'remove':
      return handleRemove(svc, actorId, body);
    case 'set_hidden':
      return handleSetHidden(svc, actorId, actorRole, body);
    case 'search':
      return handleSearch(svc, body);
    case 'courses':
      return handleCourses(svc);
    case 'enrollments':
      return handleEnrollments(svc, actorRole, body);
    default:
      return err('UNKNOWN_ACTION', `Unknown action: ${action}`);
  }
});
