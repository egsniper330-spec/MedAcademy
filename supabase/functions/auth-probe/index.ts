// supabase/functions/auth-probe/index.ts
// DIAGNOSTIC ONLY — isolates Supabase Auth from all application logic.
// Tests listUsers() and createUser() with no triggers, no profile inserts,
// no RPC, no audit logs, no application code.
// DELETE this function once the root cause of the HTTP 500 is confirmed.

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey, x-client-info',
};

function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  // ── 1. Environment ────────────────────────────────────────────────────────
  const supabaseUrl     = Deno.env.get('SUPABASE_URL')              ?? null;
  const serviceKey      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? null;
  const hasUrl          = !!supabaseUrl;
  const hasKey          = !!serviceKey;
  const projectRef      = supabaseUrl?.replace('https://', '').split('.')[0] ?? '(not set)';

  console.log('[probe] env:', { supabaseUrl, hasKey, projectRef });

  if (!hasUrl || !hasKey) {
    return respond({
      env:   { hasUrl, hasKey, projectRef },
      error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — cannot proceed',
    }, 500);
  }

  // ── 2. Build admin client ─────────────────────────────────────────────────
  const supabase = createClient(supabaseUrl!, serviceKey!, {
    auth: { persistSession: false },
  });

  // ── 3. listUsers ──────────────────────────────────────────────────────────
  console.log('[probe] calling listUsers...');
  const listResult  = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
  const listError   = listResult.error as unknown as Record<string, unknown> | null;
  const listOutcome = {
    success:      !listResult.error,
    userCount:    listResult.data?.users?.length ?? null,
    error:        listResult.error ?? null,
    errorMessage: listError?.message ?? null,
    errorStatus:  listError?.status  ?? null,
    errorCode:    listError?.code    ?? null,
    rawJson:      (() => { try { return JSON.stringify(listResult.error); } catch { return '(unserializable)'; } })(),
  };
  console.log('[probe] listUsers result:', listOutcome);

  // ── 4. createUser with hardcoded test email ───────────────────────────────
  const testEmail = `probe-${Date.now()}@medacademy-probe.internal`;
  console.log('[probe] calling createUser with:', testEmail);

  let createOutcome: Record<string, unknown>;
  try {
    const createResult = await supabase.auth.admin.createUser({
      email:         testEmail,
      password:      'ProbePass123!',
      email_confirm: true,
      user_metadata: { full_name: 'Probe Test User' },
    });

    const ce = createResult.error as unknown as Record<string, unknown> | null;
    createOutcome = {
      success:      !createResult.error && !!createResult.data?.user,
      userId:       createResult.data?.user?.id    ?? null,
      userEmail:    createResult.data?.user?.email ?? null,
      error:        createResult.error ?? null,
      errorMessage: ce?.message ?? null,
      errorName:    (createResult.error as unknown as Record<string,unknown>)?.name ?? null,
      errorStatus:  ce?.status  ?? null,
      errorCode:    ce?.code    ?? null,
      errorDetails: ce?.details ?? null,
      rawJson:      (() => { try { return JSON.stringify(createResult.error); } catch { return '(unserializable)'; } })(),
    };
    console.log('[probe] createUser result:', createOutcome);

    // ── 5. Cleanup: delete the test user if created ───────────────────────
    if (createResult.data?.user?.id) {
      const { error: delErr } = await supabase.auth.admin.deleteUser(createResult.data.user.id);
      console.log('[probe] cleanup deleteUser:', delErr ? `FAILED: ${delErr.message}` : 'OK');
      createOutcome['cleanupError'] = delErr?.message ?? null;
    }

  } catch (threw: unknown) {
    const te = threw as Record<string, unknown>;
    createOutcome = {
      success:    false,
      threw:      true,
      message:    te?.message    ?? String(threw),
      name:       te?.name       ?? null,
      status:     te?.status     ?? null,
      code:       te?.code       ?? null,
      stack:      (threw instanceof Error) ? threw.stack : null,
      isResponse: threw instanceof Response,
      responseBody: threw instanceof Response ? await (threw as Response).text() : null,
    };
    console.error('[probe] createUser THREW:', createOutcome);
  }

  // ── 6. signInWithPassword — uses the freshly created user's known credentials ─
  let signInOutcome: Record<string, unknown> = { skipped: true };

  const createdUserId = createOutcome['userId'] as string | null;
  if (createdUserId) {
    const testSignInEmail    = createOutcome['userEmail'] as string;
    const testSignInPassword = 'ProbePass123!';
    console.log('[probe] calling signInWithPassword for:', testSignInEmail);

    try {
      // Call GoTrue token endpoint directly so we get the raw HTTP response
      const tokenRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey':        serviceKey!,          // use service key to bypass anon restrictions
          'Authorization': `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({
          email:    testSignInEmail,
          password: testSignInPassword,
        }),
      });

      const tokenStatus = tokenRes.status;
      let tokenBody: unknown;
      try { tokenBody = await tokenRes.json(); } catch { tokenBody = await tokenRes.text(); }

      signInOutcome = {
        http_status:        tokenStatus,
        success:            tokenStatus === 200,
        response_body:      tokenBody,
        has_access_token:   typeof tokenBody === 'object' && tokenBody !== null && 'access_token' in tokenBody,
      };
      console.log('[probe] signInWithPassword result:', signInOutcome);

    } catch (signInErr: unknown) {
      const e = signInErr as Record<string, unknown>;
      signInOutcome = {
        success: false,
        threw:   true,
        message: e?.message ?? String(signInErr),
        stack:   (signInErr instanceof Error) ? signInErr.stack : null,
      };
      console.error('[probe] signInWithPassword THREW:', signInOutcome);
    }
  }

  // ── 7. Return everything ──────────────────────────────────────────────────
  return respond({
    build:        '2026-07-22 PROBE-002',
    env:          { hasUrl, hasKey, projectRef },
    listUsers:    listOutcome,
    createUser:   createOutcome,
    signInWithPassword: signInOutcome,
  });
});
