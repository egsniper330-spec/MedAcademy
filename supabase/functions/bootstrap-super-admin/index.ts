// supabase/functions/bootstrap-super-admin/index.ts
//
// ONE-TIME bootstrap endpoint — creates the first Super Admin account.
//
// Security layers:
//   1. BOOTSTRAP_SECRET header must match the env secret (prevents accidental calls)
//   2. Database guard: bootstrap_super_admin() raises an exception if any
//      super_admin already exists — permanently self-locking after first use.
//
// Flow:
//   POST /bootstrap-super-admin
//   Headers: { "x-bootstrap-secret": "<BOOTSTRAP_SECRET>", "Content-Type": "application/json" }
//   Body:    { "email": "...", "password": "...", "full_name": "...", "phone": "..." }
//
// On success: returns { success: true, user_id: "..." }
// On failure: returns { error: "..." } — Auth user is deleted (compensating rollback)

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/auth.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // ── 1. Validate bootstrap secret ────────────────────────────────────────────
  const bootstrapSecret = Deno.env.get('BOOTSTRAP_SECRET');
  if (!bootstrapSecret) {
    console.error('BOOTSTRAP_SECRET is not configured');
    return json({ error: 'Bootstrap not configured' }, 500);
  }

  const providedSecret = req.headers.get('x-bootstrap-secret') ?? '';
  if (providedSecret !== bootstrapSecret) {
    console.warn('Bootstrap attempt with invalid secret');
    return json({ error: 'Unauthorized' }, 401);
  }

  // ── 2. Parse and validate input ──────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { email, password, full_name, phone } = body as {
    email?: string;
    password?: string;
    full_name?: string;
    phone?: string;
  };

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return json({ error: 'Valid email is required' }, 400);
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return json({ error: 'Password must be at least 8 characters' }, 400);
  }
  if (!full_name || typeof full_name !== 'string' || full_name.trim().length < 2) {
    return json({ error: 'full_name is required (min 2 characters)' }, 400);
  }
  if (phone !== undefined && typeof phone !== 'string') {
    return json({ error: 'phone must be a string' }, 400);
  }

  // ── 3. Build service-role Supabase client ────────────────────────────────────
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('SUPABASE_URL or SERVICE_ROLE_KEY not configured');
    return json({ error: 'Server misconfiguration' }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── 4. Pre-flight guard: check for existing super_admin ──────────────────────
  // This is a fast pre-check before creating the Auth user.
  // The database function runs the definitive check inside a transaction.
  const { count, error: countErr } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'super_admin');

  if (countErr) {
    console.error('Pre-flight guard query failed:', countErr.message);
    return json({ error: 'Database error during pre-flight check' }, 500);
  }

  if ((count ?? 0) > 0) {
    return json({
      error: 'BOOTSTRAP_LOCKED: A Super Admin already exists. This endpoint is permanently disabled.',
    }, 409);
  }

  // ── 5. Create the Auth user ──────────────────────────────────────────────────
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: email.toLowerCase().trim(),
    password,
    email_confirm: true,   // mark email as verified immediately
    phone: phone?.trim() || undefined,
    phone_confirm: phone ? true : undefined,
    user_metadata: {
      full_name: full_name.trim(),
      role: 'super_admin',
      bootstrap: true,
    },
  });

  if (authError || !authData?.user) {
    console.error('Auth user creation failed:', authError?.message);
    return json({ error: `Auth creation failed: ${authError?.message ?? 'unknown'}` }, 500);
  }

  const userId = authData.user.id;
  console.log(`Auth user created: ${userId}`);

  // ── 6. Insert profile + audit log atomically ─────────────────────────────────
  // bootstrap_super_admin() is SECURITY DEFINER and checks for existing
  // super_admin inside the transaction — permanently locks after first run.
  const { error: rpcError } = await supabase.rpc('bootstrap_super_admin', {
    p_user_id:   userId,
    p_email:     email.toLowerCase().trim(),
    p_full_name: full_name.trim(),
    p_phone:     phone?.trim() ?? null,
  });

  if (rpcError) {
    console.error('bootstrap_super_admin RPC failed:', rpcError.message);

    // ── Compensating rollback: delete the Auth user we just created ──────────
    const { error: deleteErr } = await supabase.auth.admin.deleteUser(userId);
    if (deleteErr) {
      console.error('CRITICAL: Auth user rollback failed — manual cleanup required for user_id:', userId, deleteErr.message);
    } else {
      console.log(`Auth user ${userId} rolled back successfully`);
    }

    const isLocked = rpcError.message.includes('BOOTSTRAP_LOCKED');
    return json(
      { error: isLocked ? rpcError.message : `Profile creation failed: ${rpcError.message}` },
      isLocked ? 409 : 500
    );
  }

  // ── 7. Success ───────────────────────────────────────────────────────────────
  console.log(`Super Admin bootstrap complete. user_id=${userId}, email=${email}`);

  return json({
    success: true,
    user_id: userId,
    email: email.toLowerCase().trim(),
    role: 'super_admin',
    status: 'active',
    message: 'Super Admin created. This bootstrap endpoint is now permanently locked.',
  });
});
