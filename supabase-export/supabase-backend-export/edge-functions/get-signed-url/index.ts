// supabase/functions/get-signed-url/index.ts
//
// Generates a time-limited signed URL for a private Storage bucket object.
// Uses the service_role key server-side so the caller's RLS role does NOT
// matter — authentication and authorisation are enforced here explicitly.
//
// Supported buckets: lesson-materials, lesson-pdfs
//
// Access rules:
//   lesson-materials: doctor/admin/super_admin OR enrolled student OR preview lesson
//   lesson-pdfs:      any authenticated user (bucket policy: all authenticated)
//
// POST { bucket: string, path: string, expires_in?: number }
// → { signed_url: string }

import { createClient } from 'npm:@supabase/supabase-js@2';

const ALLOWED_BUCKETS = ['lesson-materials', 'lesson-pdfs'] as const;
type AllowedBucket = typeof ALLOWED_BUCKETS[number];

function createServiceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey, x-client-info',
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

/** Validate the caller's JWT and return their user id + role. */
async function requireAuth(req: Request, svc: ReturnType<typeof createServiceClient>) {
  const auth = req.headers.get('Authorization');
  if (!auth) throw new Response('Missing Authorization', { status: 401 });
  const token = auth.replace('Bearer ', '');
  const { data: { user }, error } = await svc.auth.getUser(token);
  if (error || !user) throw new Response('Invalid token', { status: 401 });
  const { data: profile } = await svc
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  return { userId: user.id, role: (profile?.role ?? 'student') as string };
}

/** Normalise a storage path: strip any full URL prefix down to the raw object path. */
function normalisePath(input: string): string {
  // Handle full Supabase Storage URLs:
  //   https://…/storage/v1/object/public/lesson-materials/path/to/file.pdf
  //   https://…/storage/v1/object/sign/lesson-materials/path/to/file.pdf?token=…
  return input
    .replace(/^.*\/object\/(?:public|sign)\/[^/]+\//, '')
    .replace(/\?.*$/, '');              // strip query string (signed URL tokens)
}

/**
 * Check whether the authenticated user is allowed to access the given object.
 * Mirrors the lm_storage_select RLS policy logic, but executed with the
 * service_role so the check itself cannot be blocked by RLS.
 */
async function canAccessLessonMaterial(
  userId: string,
  role: string,
  storagePath: string,
  svc: ReturnType<typeof createServiceClient>
): Promise<boolean> {
  // Doctors, admins, super_admins: full access
  if (['doctor', 'admin', 'super_admin'].includes(role)) return true;

  // Students: must be enrolled in the course, or the lesson must be a preview
  const { data, error } = await svc
    .from('lesson_materials')
    .select(`
      course_id,
      lesson:lessons!lesson_materials_lesson_id_fkey (
        is_preview,
        course_id
      )
    `)
    .eq('storage_path', storagePath)
    .maybeSingle();

  if (error || !data) return false;

  const lesson = (data as any).lesson;
  if (!lesson) return false;

  // Preview lesson → allow
  if (lesson.is_preview === true) return true;

  // Check enrollment
  const { data: enrollment } = await svc
    .from('enrollments')
    .select('id')
    .eq('course_id', data.course_id)
    .eq('student_id', userId)
    .maybeSingle();

  return enrollment !== null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const svc = createServiceClient();

  try {
    const { userId, role } = await requireAuth(req, svc);

    const body = await req.json() as {
      bucket?: string;
      path?: string;
      expires_in?: number;
    };

    const bucket = body.bucket?.trim() as AllowedBucket | undefined;
    const rawPath = body.path?.trim();
    const expiresIn = Math.min(body.expires_in ?? 3600, 43200); // max 12 hours

    if (!bucket || !ALLOWED_BUCKETS.includes(bucket)) {
      return json({ error: `bucket must be one of: ${ALLOWED_BUCKETS.join(', ')}` }, 400);
    }
    if (!rawPath) {
      return json({ error: 'path is required' }, 400);
    }

    const storagePath = normalisePath(rawPath);

    // ── Authorisation ──────────────────────────────────────────────────────────
    if (bucket === 'lesson-materials') {
      const allowed = await canAccessLessonMaterial(userId, role, storagePath, svc);
      if (!allowed) {
        console.warn('[get-signed-url] access denied', { userId, role, bucket, storagePath });
        return json({ error: 'Access denied' }, 403);
      }
    }
    // lesson-pdfs: all authenticated users allowed (matches lesson_pdfs_select policy)

    // ── Generate signed URL using service_role (bypasses Storage RLS) ──────────
    const { data, error } = await svc.storage
      .from(bucket)
      .createSignedUrl(storagePath, expiresIn);

    if (error || !data?.signedUrl) {
      console.error('[get-signed-url] createSignedUrl failed', {
        bucket, storagePath, error: error?.message,
      });
      return json({ error: `Failed to create signed URL: ${error?.message ?? 'unknown'}` }, 500);
    }

    console.log('[get-signed-url] OK', { userId, role, bucket, storagePath, expiresIn });
    return json({ signed_url: data.signedUrl });

  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[get-signed-url] unhandled error', String(e));
    return json({ error: String(e) }, 500);
  }
});
