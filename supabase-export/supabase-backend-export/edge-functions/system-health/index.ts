// supabase/functions/system-health/index.ts
// Comprehensive system health check + self-test runner for all subsystems.
// Version: v68

import { requireAuth, requireRole, createServiceClient, json, corsHeaders } from '../_shared/auth.ts';

const VERSION = 'v68.0.0';
const DEPLOYED_AT = new Date().toISOString();

// ──────────────────────────────────────────────────────────────
// Structured error helper
// ──────────────────────────────────────────────────────────────
function structuredError(code: string, message: string, details?: unknown) {
  return {
    success: false,
    code,
    message,
    transactionId: crypto.randomUUID(),
    details: details ?? null,
    timestamp: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────
// Latency helper
// ──────────────────────────────────────────────────────────────
async function measure<T>(fn: () => Promise<T>): Promise<{ result: T | null; latencyMs: number; error: string | null }> {
  const start = Date.now();
  try {
    const result = await fn();
    return { result, latencyMs: Date.now() - start, error: null };
  } catch (e: unknown) {
    return { result: null, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
  }
}

// ──────────────────────────────────────────────────────────────
// Individual subsystem checks
// ──────────────────────────────────────────────────────────────
async function checkDatabase(supabase: ReturnType<typeof createServiceClient>) {
  const { result, latencyMs, error } = await measure(() =>
    supabase.from('profiles').select('id', { count: 'exact', head: true })
  );
  return {
    name: 'Database',
    status: error ? 'offline' : 'online',
    latencyMs,
    error,
    version: VERSION,
    deployedAt: DEPLOYED_AT,
    lastSuccess: error ? null : new Date().toISOString(),
    lastFailure: error ? new Date().toISOString() : null,
  };
}

async function checkAuth(supabase: ReturnType<typeof createServiceClient>) {
  const { latencyMs, error } = await measure(() => supabase.auth.getUser());
  return {
    name: 'Authentication',
    status: error ? 'offline' : 'online',
    latencyMs,
    error,
  };
}

async function checkStorage(supabase: ReturnType<typeof createServiceClient>) {
  const { result, latencyMs, error } = await measure(() => supabase.storage.listBuckets());
  const buckets = (result as { data?: unknown[] } | null)?.data;
  return {
    name: 'Storage',
    status: error ? 'offline' : 'online',
    latencyMs,
    error,
    bucketCount: Array.isArray(buckets) ? buckets.length : 0,
  };
}

async function checkRPCs(supabase: ReturnType<typeof createServiceClient>) {
  const rpcs = [
    'get_doctor_students',
    'process_student_activation',
    'get_course_delete_stats',
    'remove_course_enrollment',
    'run_db_audit',
    'get_system_stats',
    'lookup_user_by_identifier',
  ];
  const results = await Promise.all(
    rpcs.map(async (name) => {
      const { latencyMs, error } = await measure(() =>
        supabase.rpc(name as never, {} as never)
      );
      // RPC errors about args are expected — function EXISTS if we get a schema error vs missing
      const missing = error?.includes('does not exist') || error?.includes('Could not find');
      return {
        name,
        status: missing ? 'missing' : 'online',
        latencyMs,
      };
    })
  );
  return {
    name: 'RPCs',
    status: results.some(r => r.status === 'missing') ? 'degraded' : 'online',
    items: results,
  };
}

async function checkCredits(supabase: ReturnType<typeof createServiceClient>) {
  const { result, latencyMs, error } = await measure(() =>
    supabase.from('credits').select('remaining, consumed', { count: 'exact', head: false }).limit(1)
  );
  type CreditsRow = { remaining: number; consumed: number };
  const rows = result as { data: CreditsRow[] } | null;
  const negative = rows?.data?.some((r) => r.remaining < 0 || r.consumed < 0);
  return {
    name: 'Credits',
    status: error ? 'offline' : negative ? 'degraded' : 'online',
    latencyMs,
    error,
    hasNegativeBalances: negative ?? false,
  };
}

async function checkVideo(supabase: ReturnType<typeof createServiceClient>) {
  const { result, latencyMs, error } = await measure(() =>
    supabase.from('video_uploads').select('status', { count: 'exact', head: false }).limit(50)
  );
  type VideoRow = { status: string };
  const rows = (result as { data: VideoRow[] } | null)?.data ?? [];
  const failed = rows.filter(r => r.status === 'failed').length;
  const processing = rows.filter(r => r.status === 'processing').length;
  return {
    name: 'Video',
    status: error ? 'offline' : failed > 5 ? 'degraded' : 'online',
    latencyMs,
    error,
    failedCount: failed,
    processingCount: processing,
  };
}

async function checkProviders(supabase: ReturnType<typeof createServiceClient>) {
  const { result, latencyMs, error } = await measure(() =>
    supabase.from('video_provider_config').select('provider_key, is_active, health_status').limit(10)
  );
  type ProviderRow = { provider_key: string; is_active: boolean; health_status: string };
  const rows = (result as { data: ProviderRow[] } | null)?.data ?? [];
  const activeProvider = rows.find(p => p.is_active);
  return {
    name: 'Providers',
    status: error ? 'offline' : !activeProvider ? 'degraded' : 'online',
    latencyMs,
    error,
    activeProvider: activeProvider?.provider_key ?? null,
    totalProviders: rows.length,
  };
}

async function checkSecurity(supabase: ReturnType<typeof createServiceClient>) {
  const { result, latencyMs, error } = await measure(() =>
    supabase.from('security_events')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
  );
  type SecurityResult = { count: number };
  const count = (result as SecurityResult | null)?.count ?? 0;
  const { result: blockedResult } = await measure(() =>
    supabase.from('devices').select('id', { count: 'exact', head: true }).eq('status', 'blocked')
  );
  const blockedDevices = (blockedResult as SecurityResult | null)?.count ?? 0;
  const { result: blockedResult } = await measure(() =>
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('status', 'blocked')
  );
  const blockedAccounts = (blockedResult as SecurityResult | null)?.count ?? 0;
  return {
    name: 'Security',
    status: error ? 'offline' : 'online',
    latencyMs,
    error,
    securityEvents24h: count,
    blockedDevices,
    blockedAccounts,
  };
}

async function checkAudit(supabase: ReturnType<typeof createServiceClient>) {
  const { result, latencyMs, error } = await measure(() =>
    supabase.from('audit_logs').select('id', { count: 'exact', head: true })
  );
  type AuditResult = { count: number };
  const count = (result as AuditResult | null)?.count ?? 0;
  return {
    name: 'Audit',
    status: error ? 'offline' : 'online',
    latencyMs,
    error,
    totalLogs: count,
  };
}

async function checkNotifications(supabase: ReturnType<typeof createServiceClient>) {
  const { latencyMs, error } = await measure(() =>
    supabase.from('notifications').select('id', { count: 'exact', head: true }).limit(1)
  );
  return {
    name: 'Notifications',
    status: error ? 'offline' : 'online',
    latencyMs,
    error,
  };
}

// ──────────────────────────────────────────────────────────────
// Self-Test runner
// ──────────────────────────────────────────────────────────────
async function runSelfTests(supabase: ReturnType<typeof createServiceClient>) {
  const tests: Array<{ name: string; status: 'pass' | 'fail' | 'skip'; latencyMs: number; detail?: string }> = [];

  const run = async (name: string, fn: () => Promise<string | undefined>) => {
    const start = Date.now();
    try {
      const detail = await fn();
      tests.push({ name, status: 'pass', latencyMs: Date.now() - start, detail });
    } catch (e: unknown) {
      tests.push({ name, status: 'fail', latencyMs: Date.now() - start, detail: e instanceof Error ? e.message : String(e) });
    }
  };

  await run('DB: read profiles table', async () => {
    const { error } = await supabase.from('profiles').select('id').limit(1);
    if (error) throw new Error(error.message);
    return 'profiles readable';
  });

  await run('DB: read credit_transactions table', async () => {
    const { error } = await supabase.from('credit_transactions').select('id').limit(1);
    if (error) throw new Error(error.message);
    return 'credit_transactions readable';
  });

  await run('DB: run_db_audit RPC', async () => {
    const { data, error } = await supabase.rpc('run_db_audit');
    if (error) throw new Error(error.message);
    type AuditData = { total_issues: number };
    return `total_issues=${(data as AuditData).total_issues}`;
  });

  await run('DB: get_system_stats RPC', async () => {
    const { data, error } = await supabase.rpc('get_system_stats');
    if (error) throw new Error(error.message);
    type StatsData = { users: number };
    return `users=${(data as StatsData).users}`;
  });

  await run('Credits: credits table integrity', async () => {
    const { data, error } = await supabase.from('credits').select('remaining,consumed').limit(10);
    if (error) throw new Error(error.message);
    type CreditRow = { remaining: number; consumed: number };
    const negative = (data as CreditRow[]).filter(r => r.remaining < 0 || r.consumed < 0);
    if (negative.length > 0) throw new Error(`${negative.length} negative balances found`);
    return 'no negative balances';
  });

  await run('Devices: installation_id unique constraint', async () => {
    const { data, error } = await supabase.from('v_duplicate_devices').select('*').limit(1);
    if (error) throw new Error(error.message);
    if (Array.isArray(data) && data.length > 0) throw new Error('duplicate installation IDs found');
    return 'no duplicates';
  });

  await run('Enrollments: no duplicate active enrollments', async () => {
    const { data, error } = await supabase.from('v_duplicate_active_enrollments').select('*').limit(1);
    if (error) throw new Error(error.message);
    if (Array.isArray(data) && data.length > 0) throw new Error('duplicate active enrollments found');
    return 'no duplicates';
  });

  await run('Activation Codes: no duplicate codes', async () => {
    const { data, error } = await supabase.from('v_duplicate_activation_codes').select('*').limit(1);
    if (error) throw new Error(error.message);
    if (Array.isArray(data) && data.length > 0) throw new Error('duplicate activation codes found');
    return 'no duplicates';
  });

  await run('Storage: buckets accessible', async () => {
    const { error } = await supabase.storage.listBuckets();
    if (error) throw new Error(error.message);
    return 'buckets accessible';
  });

  await run('Video: no stuck processing uploads (>1h)', async () => {
    const cutoff = new Date(Date.now() - 3600 * 1000).toISOString();
    const { data, error } = await supabase.from('video_uploads')
      .select('id').eq('status', 'processing').lt('created_at', cutoff);
    if (error) throw new Error(error.message);
    if (Array.isArray(data) && data.length > 0) throw new Error(`${data.length} uploads stuck >1h`);
    return 'no stuck uploads';
  });

  await run('Providers: at least one active provider', async () => {
    const { data, error } = await supabase.from('video_provider_config')
      .select('provider_key').eq('is_active', true).limit(1);
    if (error) throw new Error(error.message);
    if (!Array.isArray(data) || data.length === 0) throw new Error('no active video provider');
    type ProvRow = { provider_key: string };
    return `active=${(data as ProvRow[])[0].provider_key}`;
  });

  await run('Notifications: table accessible', async () => {
    const { error } = await supabase.from('notifications').select('id').limit(1);
    if (error) throw new Error(error.message);
    return 'notifications accessible';
  });

  await run('Audit Logs: old_values/new_values columns exist', async () => {
    const { data, error } = await supabase.from('audit_logs')
      .select('old_values,new_values').limit(1);
    if (error) throw new Error(error.message);
    return 'columns present';
  });

  const passed = tests.filter(t => t.status === 'pass').length;
  const failed = tests.filter(t => t.status === 'fail').length;
  return { tests, passed, failed, total: tests.length, allPassed: failed === 0 };
}

// ──────────────────────────────────────────────────────────────
// Main handler
// ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const actor = await requireAuth(req);
    await requireRole(actor.id, ['admin', 'superadmin'], req);

    const supabase = createServiceClient();
    const url = new URL(req.url);
    const action = url.searchParams.get('action') ?? (req.method === 'POST' ? (await req.json().catch(() => ({}))).action : 'full_check');

    // ── DB Audit only ──
    if (action === 'db_audit') {
      const { data, error } = await supabase.rpc('run_db_audit');
      if (error) return json(structuredError('DB_AUDIT_FAILED', error.message), 500);
      return json({ success: true, data, timestamp: new Date().toISOString() });
    }

    // ── Self-test only ──
    if (action === 'self_test') {
      const results = await runSelfTests(supabase);
      return json({ success: true, ...results, timestamp: new Date().toISOString() });
    }

    // ── System stats only ──
    if (action === 'stats') {
      const { data, error } = await supabase.rpc('get_system_stats');
      if (error) return json(structuredError('STATS_FAILED', error.message), 500);
      return json({ success: true, data, timestamp: new Date().toISOString() });
    }

    // ── Full health check (default) ──
    const [db, auth, storage, rpcs, credits, video, providers, security, audit, notifications] =
      await Promise.all([
        checkDatabase(supabase),
        checkAuth(supabase),
        checkStorage(supabase),
        checkRPCs(supabase),
        checkCredits(supabase),
        checkVideo(supabase),
        checkProviders(supabase),
        checkSecurity(supabase),
        checkAudit(supabase),
        checkNotifications(supabase),
      ]);

    const subsystems = [db, auth, storage, rpcs, credits, video, providers, security, audit, notifications];
    const offlineCount = subsystems.filter(s => s.status === 'offline').length;
    const degradedCount = subsystems.filter(s => s.status === 'degraded').length;
    const overallStatus = offlineCount > 0 ? 'offline' : degradedCount > 0 ? 'degraded' : 'online';

    const avgLatency = Math.round(
      subsystems.reduce((sum, s) => sum + (('latencyMs' in s && typeof s.latencyMs === 'number') ? s.latencyMs : 0), 0) /
      subsystems.filter(s => 'latencyMs' in s).length
    );

    return json({
      success: true,
      transactionId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      version: VERSION,
      deployedAt: DEPLOYED_AT,
      overall: {
        status: overallStatus,
        offlineCount,
        degradedCount,
        avgLatencyMs: avgLatency,
        subsystemCount: subsystems.length,
      },
      subsystems: { db, auth, storage, rpcs, credits, video, providers, security, audit, notifications },
    });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.includes('Unauthorized') ? 'UNAUTHORIZED'
      : msg.includes('Forbidden') ? 'FORBIDDEN' : 'INTERNAL_ERROR';
    const status = code === 'UNAUTHORIZED' ? 401 : code === 'FORBIDDEN' ? 403 : 500;
    return json(structuredError(code, msg), status);
  }
});
