// supabase/functions/vdocipher-otp/index.ts
// Generates VdoCipher OTP playback tokens server-side with dynamic watermarks.
// VDOCIPHER_API_SECRET never leaves this function.
//
// Routes:
//   POST /vdocipher-otp          — generate OTP for a lesson video
//   POST /vdocipher-otp/webhook  — receive VdoCipher webhook events (optional)
//
// ── Dynamic Watermark strategy ────────────────────────────────────────────────
//
//   Watermark type: rtext (moving watermark — VdoCipher annotate API)
//
//   For students:
//     Line 1: full_name
//     Line 2: phone (phone_national preferred, falls back to phone)
//     Line 3: ID: WM-NNNN  (sequential numeric format, e.g. ID: WM-4821)
//
//   For privileged roles (doctor / admin / super_admin):
//     No VdoCipher annotate watermark — they preview draft content without
//     an identity annotation baked into the DRM token.
//     (The application-level overlay — Plyr / NativeWatermarkOverlay —
//     remains active for all roles regardless.)
//
//   Settings (per requirement):
//     color   : #FFFFFF (white — high contrast on dark video content with text-shadow)
//     alpha   : 0.45  (45% opacity — subtle but readable)
//     size    : 18  (px — slightly larger than doc default for readability on small screens)
//     interval: 4000 ms visible + 2000 ms hidden (cycle = 6 s)
//     type    : "rtext" — moves to random positions automatically
//
// ── Plyr / application-level watermarks are NOT touched here ─────────────────
//   This function only controls the VdoCipher server-side annotate parameter.
//   The ForensicWatermarkOverlay / NativeWatermarkOverlay / DOM-injected overlay
//   continue to work exactly as before — they are application-layer concerns.

import { requireAuth, json, corsHeaders, createServiceClient } from '../_shared/auth.ts';

const VDOCIPHER_API = 'https://dev.vdocipher.com/api';

// ── VdoCipher annotate watermark parameter builder ────────────────────────────
//
// IMPORTANT — VdoCipher annotate serialization rules (official API):
//
//   1. The `annotate` key in the OTP request body MUST be a JSON-stringified
//      STRING, not a raw array.  VdoCipher performs a second JSON.parse()
//      on the value server-side.  Sending a raw array causes a 400/silent
//      failure and the OTP request returns an error.
//
//      ✅ correct:  { "annotate": "[{\"type\":\"rtext\",...}]" }
//      ❌ wrong:    { "annotate": [{"type":"rtext",...}] }
//
//   2. All numeric fields (alpha, size, interval, skip) must be sent as
//      STRINGS, not numbers.
//
//      alpha    : string float "0.0"–"1.0"  (0.45 = 45% opacity — subtle, readable)
//      size     : string integer "18"        (≈ 18 px font size — readable on small screens)
//      interval : string ms    "4000"        (visible for 4 s)
//      skip     : string ms    "2000"        (hidden 2 s between moves)
//
//   3. color MUST use "0xRRGGBB" hex notation — "#RRGGBB" is NOT accepted.
//
//   Reference: https://www.vdocipher.com/docs/player/watermark

interface VdoAnnotation {
  type:     string;
  text:     string;
  color:    string;  // "0xRRGGBB" format
  alpha:    string;  // float string "0.0"–"1.0"
  size:     string;  // px string e.g. "18"
  interval: string;  // ms string e.g. "4000"
  skip:     string;  // ms string e.g. "2000"
}

function buildAnnotate(
  fullName:    string,
  watermarkId: string,
): string {
  // Compose two lines: student name + ID label.
  // Phone number is NOT included per privacy/UX requirement.
  // Filter out blank lines so a missing name never produces a bare newline.
  const idLine = watermarkId.trim() ? `ID: ${watermarkId.trim()}` : '';
  const lines = [fullName.trim(), idLine].filter(Boolean);
  const text  = lines.join('\n');

  const annotations: VdoAnnotation[] = [
    {
      type:     'rtext',
      text,
      color:    '0xFFFFFF', // white — "0xRRGGBB" format required by VdoCipher
      alpha:    '0.45',     // 45% opacity — string float required by API
      size:     '18',       // ≈ 18 px font — string required by API
      interval: '25000',    // visible for 25 s — reduced distraction, string ms required by API
      skip:     '2000',     // hidden 2 s between moves — string ms required by API
    },
  ];

  // CRITICAL: annotate must be a JSON-stringified string — not a raw array.
  // VdoCipher performs JSON.parse() on the value server-side.
  return JSON.stringify(annotations);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  const url = new URL(req.url);

  // ── Webhook handler (optional) ────────────────────────────────────────────
  if (url.pathname.endsWith('/webhook')) {
    return handleWebhook(req);
  }

  // ── OTP generation ────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    // Require authenticated user (any role may request OTP for a lesson they can access)
    const { userId } = await requireAuth(req);

    const body = await req.json();
    const { video_id, lesson_id } = body;

    if (!video_id || typeof video_id !== 'string') {
      return json({ error: 'video_id is required' }, 400);
    }

    const apiSecret = Deno.env.get('VDOCIPHER_API_SECRET');
    if (!apiSecret) {
      console.error('VDOCIPHER_API_SECRET not configured');
      return json({ error: 'Video service not configured' }, 500);
    }

    const supabase = createServiceClient();

    // Fetch role + watermark identity fields in one query.
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, full_name, watermark_id')
      .eq('id', userId)
      .single();

    const isPrivileged = ['doctor', 'admin', 'super_admin'].includes(profile?.role ?? '');

    if (lesson_id) {
      // Fetch the lesson — for students, additionally enforce status = 'published'.
      // Privileged roles (doctor/admin/super_admin) may request OTP for draft lessons
      // (e.g. previewing before publishing). Students must never receive an OTP
      // for a draft lesson even if they know the lesson_id and video_id.
      const lessonQuery = supabase
        .from('lessons')
        .select('course_id, video_id, status')
        .eq('id', lesson_id)
        .eq('video_id', video_id);

      if (!isPrivileged) {
        lessonQuery.eq('status', 'published');
      }

      const { data: lesson } = await lessonQuery.single();

      if (!lesson) {
        // Return 403 (not 404) for students so they don't know whether the
        // lesson exists at all — avoids information leakage about draft IDs.
        return json({ error: isPrivileged ? 'Lesson not found' : 'This lesson is not available' }, isPrivileged ? 404 : 403);
      }

      // Check enrollment for students; privileged roles may preview freely
      const { data: enrollment } = await supabase
        .from('enrollments')
        .select('id')
        .eq('student_id', userId)
        .eq('course_id', lesson.course_id)
        .maybeSingle();

      if (!enrollment && !isPrivileged) {
        return json({ error: 'Not enrolled in this course' }, 403);
      }
    }

    // ── Build OTP payload ─────────────────────────────────────────────────
    const otpPayload: Record<string, unknown> = {};

    // Optional: restrict playback to the configured app domain.
    const appDomain = Deno.env.get('APP_DOMAIN');
    if (appDomain) {
      otpPayload.whitelisthref = appDomain;
    }

    // ── Attach dynamic watermark for student role only ────────────────────
    //
    // Privileged roles (doctor/admin/super_admin) watch content without an
    // identity annotation baked into the DRM token — they use the app-level
    // overlay only.
    //
    // Students always receive the annotate watermark regardless of which
    // lesson or video is being played — no per-video configuration needed.
    if (!isPrivileged && profile) {
      const displayName   = (profile.full_name ?? '').trim();
      const displayWmId   = (profile.watermark_id ?? '').trim();

      if (displayName && displayWmId) {
        otpPayload.annotate = buildAnnotate(displayName, displayWmId);
        console.log('[vdocipher-otp] dynamic watermark attached — wmId:', displayWmId);
      } else {
        // Profile missing identity data — generate OTP without annotation
        // rather than blocking playback.
        console.warn('[vdocipher-otp] missing identity fields; skipping annotate — hasName:', !!displayName, 'hasWmId:', !!displayWmId);
      }
    } else {
      console.log('[vdocipher-otp] privileged role; no annotate — role:', profile?.role ?? 'null');
    }

    // ── DIAGNOSTIC: log exact body that will be sent to VdoCipher ────────
    // API secret is in the Authorization header — never in the body.
    // annotate is a JSON-stringified string per VdoCipher spec.
    const requestBodyStr = JSON.stringify(otpPayload);
    console.log('[vdocipher-otp][DIAG] === OTP REQUEST ===');
    console.log('[vdocipher-otp][DIAG] video_id      :', video_id);
    console.log('[vdocipher-otp][DIAG] userId        :', userId);
    console.log('[vdocipher-otp][DIAG] role          :', profile?.role ?? 'null');
    console.log('[vdocipher-otp][DIAG] annotate field present:', 'annotate' in otpPayload);
    console.log('[vdocipher-otp][DIAG] annotate value:', otpPayload.annotate ?? 'NOT SET');
    console.log('[vdocipher-otp][DIAG] full request body (sent to VdoCipher):', requestBodyStr);
    console.log('[vdocipher-otp][DIAG] request timestamp (no caching):', new Date().toISOString());

    const otpRes = await fetch(`${VDOCIPHER_API}/videos/${encodeURIComponent(video_id)}/otp`, {
      method: 'POST',
      headers: {
        'Authorization': `Apisecret ${apiSecret}`,
        'Content-Type': 'application/json',
      },
      body: requestBodyStr,
    });

    // Always read full body — log verbatim for diagnosis.
    const rawBody = await otpRes.text();

    console.log('[vdocipher-otp][DIAG] === OTP RESPONSE ===');
    console.log('[vdocipher-otp][DIAG] HTTP status   :', otpRes.status, otpRes.statusText);
    console.log('[vdocipher-otp][DIAG] raw response  :', rawBody);

    if (!otpRes.ok) {
      console.error('[vdocipher-otp] VdoCipher error — status:', otpRes.status, '— body:', rawBody);
      return json({ error: 'Failed to generate playback token' }, 502);
    }

    let otpData: { otp?: string; playbackInfo?: string };
    try {
      otpData = JSON.parse(rawBody);
    } catch (e) {
      console.error('[vdocipher-otp] Failed to parse VdoCipher response — body:', rawBody);
      return json({ error: 'Invalid response from video service' }, 502);
    }

    console.log('[vdocipher-otp][DIAG] otp prefix    :', otpData.otp?.slice(0, 20) ?? 'MISSING');
    console.log('[vdocipher-otp][DIAG] playbackInfo  :', otpData.playbackInfo?.slice(0, 40) ?? 'MISSING');
    console.log('[vdocipher-otp][DIAG] annotateActive:', !!otpPayload.annotate);
    console.log('[vdocipher-otp][DIAG] === END ===');

    // Audit log: video access (non-blocking)
    try {
      await supabase.rpc('write_audit_log', {
        p_actor_id: userId,
        p_action: 'video_play' as const,  // audit_action enum — v76
        p_details: { video_id, lesson_id: lesson_id ?? null },
        p_resource_type: 'lesson',
        p_resource_id: lesson_id ?? null,
      });
    } catch (e) { console.error('audit log failed:', e); }

    return json({
      otp: otpData.otp,
      playbackInfo: otpData.playbackInfo,
    });
  } catch (err) {
    if (err instanceof Response) return err;
    console.error('vdocipher-otp error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});

// ── Webhook handler ───────────────────────────────────────────────────────────
// VdoCipher sends signed POST requests to this endpoint for events such as
// video encoding completion, upload success, etc.
// Enable by setting VDOCIPHER_WEBHOOK_SECRET in Supabase secrets.
async function handleWebhook(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const webhookSecret = Deno.env.get('VDOCIPHER_WEBHOOK_SECRET');

  // If secret is not configured, webhook endpoint is disabled
  if (!webhookSecret) {
    console.warn('VDOCIPHER_WEBHOOK_SECRET not configured — webhook endpoint disabled');
    return json({ error: 'Webhook not configured' }, 501);
  }

  // Verify HMAC-SHA256 signature
  const signature = req.headers.get('x-vdocipher-signature') ?? '';
  const rawBody = await req.text();

  const encoder = new TextEncoder();
  const keyData = encoder.encode(webhookSecret);
  const msgData = encoder.encode(rawBody);

  const key = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );

  const sigBytes = hexToUint8Array(signature);
  const valid = sigBytes.length > 0 && await crypto.subtle.verify('HMAC', key, sigBytes, msgData);

  if (!valid) {
    console.error('VdoCipher webhook: invalid signature');
    return json({ error: 'Invalid signature' }, 401);
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  console.log('VdoCipher webhook event:', event?.event ?? 'unknown');

  // Handle specific event types here as needed
  // e.g. encoding completion, upload success
  // const supabase = createServiceClient();
  // if (event.event === 'VIDEO_ENCODED') { ... }

  return json({ received: true });
}

function hexToUint8Array(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) return new Uint8Array(0);
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return arr;
}
