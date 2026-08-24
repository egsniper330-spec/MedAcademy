import { fetch as expoFetch } from 'expo/fetch';
import { supabase } from '@/client/supabase';
import { normalizePhoneE164 } from '@/lib/identifier';

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY BOUNDARY
// ─────────────────────────────────────────────────────────────────────────────
// READ operations  → direct Supabase queries (anon key, RLS enforced)
// WRITE operations → SECURITY DEFINER DB functions via .rpc()
// PRIVILEGED ops   → Edge Functions (service role, server-side only)
//
// NEVER call Edge Functions directly — always via invokeEdgeFunction() below.
// NEVER put SERVICE_ROLE_KEY, DB_PASSWORD, or VDOCIPHER_API_SECRET in this file.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DebugError — carries the full backend context so the UI can display it directly.
 * Thrown by invokeEdgeFunction when the EF returns an error.
 */
export class DebugError extends Error {
  httpStatus: number;
  rawBody: string;
  errorCode: string;
  errorDetails: string;
  functionName: string;
  constructor(opts: {
    message: string;
    httpStatus: number;
    rawBody: string;
    errorCode: string;
    errorDetails: string;
    functionName: string;
  }) {
    super(opts.message);
    this.name = 'DebugError';
    this.httpStatus   = opts.httpStatus;
    this.rawBody      = opts.rawBody;
    this.errorCode    = opts.errorCode;
    this.errorDetails = opts.errorDetails;
    this.functionName = opts.functionName;
  }
}

// Edge Function invocation helper — always surfaces the real error body for debugging
export async function invokeEdgeFunction<T = unknown>(
  name: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
  method: 'POST' | 'GET' = 'POST'
): Promise<T> {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers['x-idempotency-key'] = idempotencyKey;

  // Route ALL requests through the PHP backend client (POST and GET)
  if (method === 'GET') {
    const { data, error } = await supabase.functions.invoke<T>(name, { body, method: 'GET', headers });
    if (error) throw new Error(error.message);
    return data as T;
  }

  // ── POST path ─────────────────────────────────────────────────────────────
  const { data, error } = await supabase.functions.invoke(name, {
    body,
    method: 'POST',
    headers,
  });

  if (error) {
    let msg       = error.message;
    let rawBody   = '';
    let httpStatus = 0;
    let errCode   = '';
    let errDetails = '';

    const ctx = error as unknown as Record<string, unknown>;
    if (ctx.context && typeof (ctx.context as Record<string, unknown>).text === 'function') {
      try {
        rawBody = await (ctx.context as { text: () => Promise<string> }).text();
        if (rawBody) {
          try {
            const parsed = JSON.parse(rawBody) as Record<string, unknown>;
            if (typeof parsed.message === 'string' && parsed.message) msg = parsed.message;
            else if (typeof parsed.error === 'string' && parsed.error) msg = parsed.error;
            else msg = rawBody;
            if (typeof parsed.code    === 'string') errCode    = parsed.code;
            if (typeof parsed.details === 'string') errDetails = parsed.details;
          } catch {
            msg = rawBody;
          }
        }
      } catch { /* context.text() unavailable */ }
    }
    if (ctx.context && typeof (ctx.context as Record<string, unknown>).status === 'number') {
      httpStatus = (ctx.context as { status: number }).status;
    }

    throw new DebugError({ message: msg, httpStatus, rawBody, errorCode: errCode, errorDetails: errDetails, functionName: name });
  }

  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if ('error' in d && typeof d.error === 'string' && d.error) {
      throw new DebugError({ message: d.error, httpStatus: 200, rawBody: JSON.stringify(data), errorCode: '', errorDetails: '', functionName: name });
    }
    if (d.success === false) {
      const msg = (typeof d.message === 'string' && d.message)
        || (typeof d.code === 'string' && d.code)
        || 'Operation failed';
      throw new DebugError({ message: msg, httpStatus: 200, rawBody: JSON.stringify(data), errorCode: '', errorDetails: '', functionName: name });
    }
  }

  return data as T;
}

// ── Profiles ──────────────────────────────────────────────────────────────────
// phone_e164 and phone_national are included so every profile object carries
// all three phone representations — required for search, display, and uniqueness checks.
const PROFILE_SELECT = 'id, email, profile_email, full_name, phone, phone_e164, phone_national, phone_country_code, role, status, watermark_id, avatar_url, created_at, updated_at, university_id, faculty_id, academic_level_id, contact_whatsapp, contact_telegram, contact_phone, earnings_enabled, doctor_global_price, university:universities(id,name), faculty:faculties(id,name), academic_level:academic_levels(id,name)';

// ── Email helpers ─────────────────────────────────────────────────────────────

/** True when the email is a synthetic internal placeholder, never shown to users. */
export function isInternalEmail(email: string | null | undefined): boolean {
  return !!email?.endsWith('@medacademy.internal');
}

/**
 * Return the public-facing email for any profile-like object.
 * Priority: profile_email → email (only if NOT internal) → null
 */
export function getPublicEmail(
  profile: { email?: string | null; profile_email?: string | null } | null | undefined,
): string | null {
  if (!profile) return null;
  if (profile.profile_email?.trim()) return profile.profile_email.trim();
  if (!isInternalEmail(profile.email)) return profile.email ?? null;
  return null;
}

/**
 * Return the best contact string to display for any profile-like object.
 * Implements the phone-first display spec:
 *   profile_email → phone (national format) → "Not Set"
 * NEVER returns a phone_xxx@medacademy.internal address.
 */
export function getContactDisplay(
  profile: {
    email?: string | null;
    profile_email?: string | null;
    phone?: string | null;
    phone_e164?: string | null;
    phone_national?: string | null;
  } | null | undefined,
): string {
  if (!profile) return 'Not Set';
  // 1. Real email the user explicitly set
  if (profile.profile_email?.trim()) return profile.profile_email.trim();
  // 2. Auth email only if it is a genuine address (not internal placeholder)
  if (!isInternalEmail(profile.email) && profile.email?.trim()) return profile.email.trim();
  // 3. Phone — prefer national format, fall back to raw
  const phone = profile.phone_national ?? profile.phone_e164 ?? profile.phone;
  if (phone?.trim()) return phone.trim();
  return 'Not Set';
}

export async function getProfile(userId: string) {
  const { data, error } = await supabase
    .from('profiles')
    .select(PROFILE_SELECT)
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;

  // Auto-create a skeleton profile if the DB trigger hasn't fired yet
  if (!data) {
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr) throw userErr;
    if (!user) return null;
    const meta = user.user_metadata ?? {};
    // Normalize phone to E.164 — mirrors what the handle_new_user DB trigger does,
    // so profiles created via this fallback path also get phone_e164 populated.
    const rawPhone: string | null = (meta.phone as string | null) ?? null;
    const phoneE164 = rawPhone ? (normalizePhoneE164(rawPhone) ?? rawPhone) : null;
    const { data: created, error: createErr } = await supabase
      .from('profiles')
      .insert({
        id: user.id,
        email: user.email ?? '',
        full_name: meta.full_name ?? '',
        phone: rawPhone,
        phone_e164: phoneE164,
        phone_country_code: meta.phone_country_code ?? null,
        phone_national: meta.phone_national ?? null,
        role: meta.role ?? 'student',
        status: 'active',
        // Persist academic selections captured at sign-up
        university_id: meta.university_id ?? null,
        faculty_id: meta.faculty_id ?? null,
        academic_level_id: meta.academic_level_id ?? null,
      })
      .select(PROFILE_SELECT)
      .single();
    if (createErr) throw createErr;
    return created;
  }
  return data;
}

export async function updateProfile(
  userId: string,
  updates: Partial<{
    full_name: string; phone: string; avatar_url: string;
    profile_email: string | null;
    university_id: string; faculty_id: string; academic_level_id: string;
    /** Doctor default contact information */
    contact_whatsapp: string | null;
    contact_telegram: string | null;
    contact_phone:    string | null;
    /** Doctor earnings system toggle */
    earnings_enabled: boolean;
  }>
) {
  // Fetch current profile for old-values comparison before applying update
  const { data: oldProfile } = await supabase
    .from('profiles')
    .select('full_name, avatar_url, profile_email, phone')
    .eq('id', userId)
    .single();

  const { data, error } = await supabase
    .from('profiles')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', userId)
    // Always return full profile with nested relations so callers can
    // set the store directly without losing university/faculty/level objects
    .select(PROFILE_SELECT)
    .single();
  if (error) throw error;

  // Build per-field audit entries for each meaningful changed field
  // Actions MUST be valid audit_action enum values (added in migration add_missing_audit_action_enum_values)
  const AUDITABLE: Array<{
    key: keyof typeof updates;
    action: string;
    label: string;
  }> = [
    { key: 'full_name',     action: 'profile_name_changed',    label: 'full name' },
    { key: 'avatar_url',    action: 'profile_avatar_changed',  label: 'avatar' },
    { key: 'profile_email', action: 'profile_email_changed',   label: 'email' },
    { key: 'phone',         action: 'profile_phone_changed',   label: 'phone' },
  ];

  const actorName = data?.full_name ?? 'Unknown';

  for (const { key, action, label } of AUDITABLE) {
    if (!(key in updates)) continue;
    const oldVal = oldProfile ? oldProfile[key as keyof typeof oldProfile] : undefined;
    const newVal = updates[key];
    // Skip if nothing actually changed
    if (String(oldVal ?? '') === String(newVal ?? '')) continue;

    // Non-blocking: fire-and-forget. Use the (p_actor_id, p_action, p_details) overload.
    void (async () => {
      try {
        await supabase.rpc('write_audit_log', {
          p_actor_id:      userId,
          p_action:        action as Parameters<typeof supabase.rpc>[1] extends { p_action: infer A } ? A : string,
          p_resource_type: 'profile',
          p_resource_id:   userId,
          p_details: {
            description: key === 'avatar_url'
              ? `${actorName} updated their profile picture`
              : `${actorName} changed their ${label} from "${oldVal ?? ''}" to "${newVal ?? ''}"`,
            old_value: oldVal ?? null,
            new_value: newVal ?? null,
            field:     key,
          },
        });
      } catch (_) { /* non-blocking — ignore */ }
    })();
  }

  return data;
}

// ── Doctor Earnings — Independent Pricing System ──────────────────────────────
//
// Revenue source: doctor_earnings_events.earnings_amount
// Doctor price  = enrollment.assigned_price  (per-student override)
//              ?? profiles.doctor_global_price (doctor's own global price)
//
// NEVER uses platform credit_selling_price — completely independent.
//
// Transaction types:
//   purchase          → positive amount  (student enrolled)
//   removal           → negative amount  (student removed, revenue deducted)
//   suspension_refund → negative amount  (optional refund on suspension)
//   adjustment        → positive or negative (manual correction)

export type EarningsTransactionType = 'purchase' | 'removal' | 'suspension_refund' | 'adjustment' | 'account_deletion';

export interface EarningsTransactionRow {
  id:               string;
  student_id:       string | null;
  student_name:     string | null;   // null only when student_id is null (legacy event)
  student_phone:    string | null;
  student_email:    string | null;
  student_avatar:   string | null;
  // Immutable snapshots — always available even after account deletion
  student_phone_snapshot:    string | null;
  student_email_snapshot:    string | null;
  student_watermark_snapshot: string | null;
  course_id:        string | null;
  course_title:     string | null;
  amount:           number;           // positive = income, negative = deduction
  price_snapshot:   number;           // the price used when this event was created
  pricing_mode:     string;           // 'doctor_independent' | 'global' | etc.
  transaction_type: EarningsTransactionType;
  notes:            string | null;
  created_at:       string;
}

export interface EarningsCourseRow {
  course_id:    string;
  course_title: string;
  students:     number;  // net enrolled (purchases - removals)
  revenue_egp:  number;  // net revenue
  pct:          number;  // % of total net revenue
}

export interface EarningsTimePoint {
  label:      string;   // x-axis label
  key:        string;   // sort key  YYYY-MM-DD / YYYY-WW / YYYY-MM / YYYY
  amount:     number;   // net revenue for this period
  isNegative: boolean;  // true if net is negative
}

export interface DoctorEarningsDashboard {
  totalRevenue:         number;  // net (purchases - removals)
  thisMonthRevenue:     number;
  totalPaidStudents:    number;  // unique students with net positive revenue
  totalTransactions:    number;
  avgRevenuePerStudent: number;
  courseRows:           EarningsCourseRow[];
  transactions:         EarningsTransactionRow[];
  timePoints:           EarningsTimePoint[];   // pre-bucketed for daily view by default
}

export interface DoctorStudentProfile {
  id:           string;
  full_name:    string | null;
  phone:        string | null;
  email:        string | null;
  avatar_url:   string | null;
  watermark_id: string | null;
  created_at:   string | null;
  /** 'active' | 'suspended' | 'trashed' — used to determine isDeleted in modal */
  account_status: string;
  enrollments: {
    enrollment_id:    string;
    course_id:        string;
    course_title:     string;
    enrolled_at:      string;
    status:           string;
    assigned_price:   number | null;
    progress_percent: number;
  }[];
}

export interface DoctorPricingSettings {
  doctor_global_price: number;
}

/**
 * Fetch the doctor's full earnings dashboard from doctor_earnings_events.
 * Revenue = SUM(earnings_amount) using doctor's own pricing — never platform credit price.
 * RLS: doctor_read_own_dee ensures only own records are visible.
 *
 * Name resolution priority (per transaction):
 *  1. student_name_snapshot  — immutable, written at insert time
 *  2. current profiles.full_name — live join fallback
 *  3. 'Deleted Account'      — student_id exists but profile is gone
 *  No row ever shows "Unknown Student", "Legacy Transaction", or "Deleted Student".
 */
export async function getDoctorEarningsDashboard(
  doctorId: string,
): Promise<DoctorEarningsDashboard> {
  const empty: DoctorEarningsDashboard = {
    totalRevenue: 0, thisMonthRevenue: 0, totalPaidStudents: 0,
    totalTransactions: 0, avgRevenuePerStudent: 0,
    courseRows: [], transactions: [], timePoints: [],
  };

  const { data: events, error: evErr } = await supabase
    .from('doctor_earnings_events')
    .select('id, course_id, student_id, transaction_type, earnings_amount, notes, created_at, student_name_snapshot, course_name_snapshot, student_email_snapshot, student_phone_snapshot, student_watermark_snapshot, price_snapshot, pricing_mode')
    .eq('doctor_id', doctorId)
    .order('created_at', { ascending: false });
  if (evErr) throw evErr;

  const evArr: any[] = events ?? [];
  if (evArr.length === 0) return empty;

  const courseIds  = [...new Set(evArr.map(e => e.course_id).filter(Boolean))]  as string[];
  const studentIds = [...new Set(evArr.map(e => e.student_id).filter(Boolean))] as string[];

  const [courseRes, profileRes] = await Promise.all([
    supabase.from('courses').select('id, title').in('id', courseIds),
    supabase.from('profiles').select('id, full_name, phone, profile_email, email, avatar_url, status').in('id', studentIds),
  ]);

  const courseMap:  Record<string, string> = {};
  (courseRes.data ?? []).forEach((c: any) => { courseMap[c.id] = c.title; });

  const profileMap: Record<string, any> = {};
  (profileRes.data ?? []).forEach((p: any) => { profileMap[p.id] = p; });

  // Set of student IDs whose accounts are trashed — their events must not
  // contribute to revenue totals (Recalculate will insert matching deductions,
  // but the dashboard must never show positive net for deleted accounts).
  const trashedIds = new Set<string>(
    (profileRes.data ?? []).filter((p: any) => p.status === 'trashed').map((p: any) => p.id as string),
  );

  // ── Totals ────────────────────────────────────────────────────────────────
  const now = new Date();
  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let totalRevenue = 0;
  let thisMonthRevenue = 0;
  const dailyMap: Record<string, number> = {};
  const studentNetMap: Record<string, number> = {};
  const courseAggMap: Record<string, { revenue: number; students: Set<string> }> = {};

  evArr.forEach(e => {
    // Never let trashed (deleted) accounts inflate revenue.
    // Their events still exist in the DB until Recalculate inserts the
    // matching negative correction — skip their contribution entirely here.
    if (e.student_id && trashedIds.has(e.student_id)) return;

    const amt = Number(e.earnings_amount ?? 0); // already signed in DB (negative for removals)
    totalRevenue += amt;
    const d   = new Date(e.created_at);
    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const monKey  = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    dailyMap[dayKey] = (dailyMap[dayKey] ?? 0) + amt;
    if (monKey === thisMonthKey) thisMonthRevenue += amt;

    if (e.student_id) {
      studentNetMap[e.student_id] = (studentNetMap[e.student_id] ?? 0) + amt;
    }
    const cid = e.course_id ?? 'unknown';
    if (!courseAggMap[cid]) courseAggMap[cid] = { revenue: 0, students: new Set() };
    courseAggMap[cid].revenue += amt;
    if (e.student_id && amt > 0) courseAggMap[cid].students.add(e.student_id);
  });

  const totalPaidStudents    = Object.values(studentNetMap).filter(v => v > 0).length;
  const avgRevenuePerStudent = totalPaidStudents > 0 ? totalRevenue / totalPaidStudents : 0;

  // ── Time points (daily, last 30 days) ─────────────────────────────────────
  const timePoints: EarningsTimePoint[] = Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-30)
    .map(([key, amount]) => {
      const [, m, dd] = key.split('-');
      return { key, label: `${dd}/${m}`, amount, isNegative: amount < 0 };
    });

  // ── Course rows ───────────────────────────────────────────────────────────
  const posTotal = Object.values(courseAggMap).reduce((s, c) => s + Math.max(0, c.revenue), 0) || 1;
  const courseRows: EarningsCourseRow[] = Object.entries(courseAggMap)
    .map(([cid, agg]) => ({
      course_id:    cid,
      course_title: courseMap[cid] ?? 'Unknown Course',
      students:     agg.students.size,
      revenue_egp:  agg.revenue,
      pct:          Math.round((Math.max(0, agg.revenue) / posTotal) * 100),
    }))
    .sort((a, b) => b.revenue_egp - a.revenue_egp);

  // ── Transactions (latest 50) ──────────────────────────────────────────────
  // Name resolution: snapshot → live join → 'Deleted Account' (never placeholder labels)
  const transactions: EarningsTransactionRow[] = evArr.slice(0, 50).map(e => {
    const prof = e.student_id ? profileMap[e.student_id] : null;
    // Snapshot takes priority; live join is a fallback; 'Deleted Account' only when
    // student_id exists but both snapshot and live profile are missing.
    const resolvedName: string | null =
      e.student_name_snapshot ??
      (prof?.full_name ?? null) ??
      (e.student_id ? 'Deleted Account' : null);

    const resolvedCourse: string | null =
      e.course_name_snapshot ??
      (e.course_id ? (courseMap[e.course_id] ?? null) : null);

    return {
      id:               e.id,
      student_id:       e.student_id ?? null,
      student_name:     resolvedName,
      student_phone:    prof?.phone ?? null,
      student_email:    prof?.profile_email ?? prof?.email ?? null,
      student_avatar:   prof?.avatar_url ?? null,
      student_phone_snapshot:     e.student_phone_snapshot    ?? null,
      student_email_snapshot:     e.student_email_snapshot    ?? null,
      student_watermark_snapshot: e.student_watermark_snapshot ?? null,
      course_id:        e.course_id  ?? null,
      course_title:     resolvedCourse,
      amount:           Number(e.earnings_amount ?? 0),
      price_snapshot:   Number(e.price_snapshot  ?? 0),
      pricing_mode:     e.pricing_mode ?? 'doctor_independent',
      transaction_type: (e.transaction_type ?? 'purchase') as EarningsTransactionType,
      notes:            e.notes ?? null,
      created_at:       e.created_at,
    };
  });

  return {
    totalRevenue, thisMonthRevenue, totalPaidStudents,
    totalTransactions: evArr.length, avgRevenuePerStudent,
    courseRows, transactions, timePoints,
  };
}

/**
 * Get time-series data bucketed by period for the revenue chart.
 * Returns signed amounts — removals appear as negative bars.
 */
export function bucketEarningsTimeSeries(
  transactions: EarningsTransactionRow[],
  period: 'daily' | 'weekly' | 'monthly' | 'yearly',
): EarningsTimePoint[] {
  const buckets: Record<string, number> = {};

  transactions.forEach(t => {
    const d = new Date(t.created_at);
    let key = '';
    let label = '';
    if (period === 'daily') {
      key   = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      label = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    } else if (period === 'weekly') {
      // ISO week number
      const startOfYear = new Date(d.getFullYear(), 0, 1);
      const week = Math.ceil(((d.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
      key   = `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
      label = `W${week}`;
    } else if (period === 'monthly') {
      key   = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      label = months[d.getMonth()];
    } else {
      key   = String(d.getFullYear());
      label = key;
    }
    buckets[key] = (buckets[key] ?? 0) + t.amount;
  });

  const limit = period === 'daily' ? 30 : period === 'weekly' ? 16 : period === 'monthly' ? 12 : 5;
  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-limit)
    .map(([key, amount]) => ({
      key,
      label: Object.entries(buckets).find(([k]) => k === key) ? key : key,
      amount,
      isNegative: amount < 0,
    }))
    .map(p => ({
      ...p,
      label: (() => {
        const d = new Date(p.key.replace(/-W\d+/, ''));
        if (period === 'daily') {
          const [, m, dd] = p.key.split('-');
          return `${dd}/${m}`;
        }
        if (period === 'weekly') return p.key.replace(/^\d+-/, '');
        if (period === 'monthly') {
          const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          return months[d.getMonth()] ?? p.key;
        }
        return p.key;
      })(),
    }));
}

/**
 * Get a student's full profile including enrollments on this doctor's courses.
 *
 * Uses the get_doctor_student_profile SECURITY DEFINER RPC because doctors
 * do not have direct RLS access to student rows in the profiles table
 * (only their own row + other doctors are visible via standard policies).
 *
 * The RPC verifies the enrollment relationship before returning data.
 *
 * Returns null when:
 *   - the student row was hard-deleted (extremely rare)
 *   - the doctor has no enrollment relationship with this student
 *   - an unexpected error occurs
 * The modal treats null as "account not found" and shows the snapshot fallback.
 */
export async function getDoctorStudentProfile(
  doctorId: string,
  studentId: string,
): Promise<DoctorStudentProfile | null> {
  const { data, error } = await supabase.rpc('get_doctor_student_profile', {
    p_doctor_id:  doctorId,
    p_student_id: studentId,
  });

  if (error) {
    console.warn('[getDoctorStudentProfile] RPC error:', error.message);
    return null;
  }

  const d = data as any;

  // RPC returned a logical error (no relationship, forbidden, etc.)
  if (d?.error || d?.found === false) return null;

  const enrollments: DoctorStudentProfile['enrollments'] = ((d.enrollments ?? []) as any[]).map(e => ({
    enrollment_id:    e.enrollment_id,
    course_id:        e.course_id,
    course_title:     e.course_title ?? 'Unknown',
    enrolled_at:      e.enrolled_at,
    status:           e.status ?? 'active',
    assigned_price:   e.assigned_price != null ? Number(e.assigned_price) : null,
    progress_percent: e.progress_percent ?? 0,
  }));

  return {
    id:             d.id,
    full_name:      d.full_name    ?? null,
    phone:          d.phone        ?? null,
    email:          d.email        ?? null,
    avatar_url:     d.avatar_url   ?? null,
    watermark_id:   d.watermark_id ?? null,
    created_at:     d.created_at   ?? null,
    account_status: d.account_status ?? 'active',
    enrollments,
  };
}

/** Get the doctor's global earnings price. */
export async function getDoctorPricingSettings(
  doctorId: string,
): Promise<DoctorPricingSettings> {
  const { data, error } = await supabase
    .from('profiles')
    .select('doctor_global_price')
    .eq('id', doctorId)
    .single();
  if (error) throw error;
  return {
    doctor_global_price: Number((data as any)?.doctor_global_price ?? 0),
  };
}

/**
 * Update the doctor's global earnings price.
 * Fallback logic (enforced in DB / Edge Functions):
 *   1. doctor_global_price  — if set (> 0)
 *   2. course publish price — automatic fallback when global price is 0 / null
 */
export async function setDoctorGlobalPrice(
  doctorId: string,
  globalPrice: number,
): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({ doctor_global_price: globalPrice })
    .eq('id', doctorId);
  if (error) throw error;
}

/** Set a per-student assigned price override on an enrollment. */
/**
 * Set (or clear) the per-student price override on an enrollment.
 *
 * Uses a SECURITY DEFINER RPC instead of a direct table UPDATE because the
 * enrollments_update RLS policy only covers the student themselves and admins —
 * doctors are blocked from direct UPDATE even on their own students, causing the
 * call to silently match 0 rows and return no error while saving nothing.
 *
 * The RPC also runs recalculate_doctor_earnings immediately, so doctor_earnings_events
 * reflects the new price without requiring a separate manual recalculate step.
 *
 * Returns the number of correction events inserted by the recalculation.
 */
export async function setEnrollmentAssignedPrice(
  enrollmentId: string,
  price: number | null,
): Promise<{ corrections: number }> {
  const { data, error } = await supabase.rpc('set_enrollment_assigned_price', {
    p_enrollment_id: enrollmentId,
    p_price:         price,
  });
  if (error) throw error;
  const r = data as { success: boolean; code?: string; corrections?: number };
  if (!r?.success) throw new Error(r?.code ?? 'Failed to save price override');
  return { corrections: r.corrections ?? 0 };
}

/**
 * Recalculate doctor earnings without wiping history.
 * Inserts corrective 'adjustment' events so every active student/course pair
 * nets the correct price. Also zeroes out revenue for trashed (deleted) accounts.
 */
export async function recalculateDoctorEarnings(
  doctorId: string,
): Promise<{ corrections: number }> {
  const { data, error } = await supabase.rpc('recalculate_doctor_earnings', {
    p_doctor_id: doctorId,
  });
  if (error) throw error;
  const r = data as { success: boolean; code?: string; corrections?: number };
  if (!r?.success) throw new Error(r?.code ?? 'Recalculate failed');
  return { corrections: r.corrections ?? 0 };
}

/**
 * Reset doctor earnings: delete ALL existing events then rebuild from scratch
 * using only active, non-trashed enrollments.
 */
export async function resetDoctorEarnings(
  doctorId: string,
): Promise<{ deleted: number; rebuilt: number }> {
  const { data, error } = await supabase.rpc('reset_doctor_earnings', {
    p_doctor_id: doctorId,
  });
  if (error) throw error;
  const r = data as { success: boolean; code?: string; deleted?: number; rebuilt?: number };
  if (!r?.success) throw new Error(r?.code ?? 'Reset failed');
  return { deleted: r.deleted ?? 0, rebuilt: r.rebuilt ?? 0 };
}


export async function suspendStudentCourseAccess(
  enrollmentId: string,
): Promise<void> {
  const { error } = await supabase
    .from('enrollments')
    .update({ status: 'suspended' })
    .eq('id', enrollmentId);
  if (error) throw error;
}

/**
 * Restore a suspended student's course access.
 */
export async function restoreStudentCourseAccess(
  enrollmentId: string,
): Promise<void> {
  const { error } = await supabase
    .from('enrollments')
    .update({ status: 'active' })
    .eq('id', enrollmentId);
  if (error) throw error;
}

/**
 * Remove a student from a course and deduct revenue — atomic SECURITY DEFINER RPC.
 * Price is resolved entirely inside the DB (assigned_price → course price → global price),
 * so the client never needs to pre-load or pass a price value.
 */
export async function removeStudentFromCourseWithRefund(params: {
  doctorId:            string;
  enrollmentId:        string;
  studentNameSnapshot: string;
  courseNameSnapshot:  string;
}): Promise<void> {
  const { data, error } = await supabase.rpc('remove_student_and_record_earnings', {
    p_enrollment_id: params.enrollmentId,
    p_doctor_id:     params.doctorId,
    p_student_name:  params.studentNameSnapshot,
    p_course_name:   params.courseNameSnapshot,
  });
  if (error) throw error;
  const result = data as { success: boolean; code?: string; message?: string; deducted?: number; event_id?: string };
  if (!result?.success) {
    throw new Error(result?.message ?? result?.code ?? 'Remove failed');
  }
}

/**
 * Fetch a doctor's default contact information from their profile.
 * Used when a course has use_default_contact = true.
 */
export async function getDoctorContactInfo(doctorId: string): Promise<{
  contact_whatsapp: string | null;
  contact_telegram: string | null;
  contact_phone:    string | null;
}> {
  const { data, error } = await supabase
    .from('profiles')
    .select('contact_whatsapp, contact_telegram, contact_phone')
    .eq('id', doctorId)
    .single();
  if (error) throw error;
  return data ?? { contact_whatsapp: null, contact_telegram: null, contact_phone: null };
}

// ── Doctor Earnings ───────────────────────────────────────────────────────────

export interface EarningsTransaction {
  id: string;
  course_id: string | null;
  student_id: string | null;
  amount_egp: number;
  transaction_type: string;
  description: string | null;
  created_at: string;
  course?: { title: string } | null;
  student?: { full_name: string } | null;
}

export interface PayoutRequest {
  id: string;
  amount_egp: number;
  status: 'pending' | 'approved' | 'rejected' | 'paid';
  method: string | null;
  notes: string | null;
  created_at: string;
}

export interface DoctorEarningsData {
  totalEarnings: number;
  pendingPayout:  number;
  paidOut:        number;
  transactions:   EarningsTransaction[];
  payouts:        PayoutRequest[];
  monthlyTotals:  { month: string; amount: number }[];
}

/**
 * Fetch the doctor's full earnings dashboard data.
 * Returns empty zeros when no transactions exist — safe to display before
 * any earnings are recorded.
 */
export async function getDoctorEarningsData(doctorId: string): Promise<DoctorEarningsData> {
  const [txRes, payRes] = await Promise.all([
    supabase
      .from('doctor_earnings_transactions')
      .select('*, course:courses(title), student:profiles!doctor_earnings_transactions_student_id_fkey(full_name)')
      .eq('doctor_id', doctorId)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('doctor_payout_requests')
      .select('*')
      .eq('doctor_id', doctorId)
      .order('created_at', { ascending: false }),
  ]);
  if (txRes.error) throw txRes.error;
  if (payRes.error) throw payRes.error;

  const transactions: EarningsTransaction[] = (txRes.data ?? []).map((r: any) => ({
    ...r,
    course:  Array.isArray(r.course)  ? (r.course[0]  ?? null) : r.course,
    student: Array.isArray(r.student) ? (r.student[0] ?? null) : r.student,
  }));
  const payouts: PayoutRequest[] = payRes.data ?? [];

  const totalEarnings = transactions
    .filter(t => t.transaction_type !== 'refund')
    .reduce((s, t) => s + (t.amount_egp ?? 0), 0);

  const paidOut = payouts
    .filter(p => p.status === 'paid')
    .reduce((s, p) => s + (p.amount_egp ?? 0), 0);

  const pendingPayout = payouts
    .filter(p => p.status === 'pending' || p.status === 'approved')
    .reduce((s, p) => s + (p.amount_egp ?? 0), 0);

  // Build monthly totals for chart (last 6 months)
  const monthlyMap: Record<string, number> = {};
  transactions.forEach(t => {
    if (t.transaction_type === 'refund') return;
    const d = new Date(t.created_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthlyMap[key] = (monthlyMap[key] ?? 0) + (t.amount_egp ?? 0);
  });
  const monthlyTotals = Object.entries(monthlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([month, amount]) => ({ month, amount }));

  return { totalEarnings, pendingPayout, paidOut, transactions, payouts, monthlyTotals };
}

/**
 * Submit a payout request on behalf of a doctor.
 */
export async function submitPayoutRequest(doctorId: string, payload: {
  amount_egp: number;
  method: string;
  notes?: string;
}): Promise<void> {
  const { error } = await supabase.from('doctor_payout_requests').insert({
    doctor_id:  doctorId,
    amount_egp: payload.amount_egp,
    method:     payload.method,
    notes:      payload.notes ?? null,
    status:     'pending',
  });
  if (error) throw error;
}

export async function getAllUsers(role?: string, status?: string) {
  // Join credits for doctors so user cards can display Allocated/Consumed/Remaining
  // without additional per-row requests (no N+1).
  const select = role === 'doctor' || !role
    ? '*, credits:credits(allocated,consumed,remaining)'
    : '*';
  let query = supabase
    .from('profiles')
    .select(select)
    .order('created_at', { ascending: false })
    .limit(200);
  if (role) query = query.eq('role', role);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  // Flatten the 1-to-1 credits join (Supabase returns it as an array)
  return (data ?? []).map((u: any) => {
    if (u.role !== 'doctor') return u;
    const cr = Array.isArray(u.credits) ? u.credits[0] : u.credits;
    return {
      ...u,
      credits_allocated: cr?.allocated ?? 0,
      credits_consumed:  cr?.consumed  ?? 0,
      credits_balance:   cr?.remaining ?? 0,
    };
  });
}

// ── Universal user search (name / email / phone / user_id) ────────────────────
export async function searchUsers(identifier: string) {
  const { data, error } = await supabase.rpc('lookup_user_by_identifier', {
    p_identifier: identifier.trim(),
  });
  if (error) throw error;
  return data ?? [];
}

// ── Server-side search helpers — ILIKE on DB instead of client-side filter ────

export async function searchCourses(q: string) {
  const like = `%${q.trim().replace(/\s+/g, '%')}%`;
  const { data, error } = await supabase
    .from('courses')
    .select('id, title, short_description, image_url, status, price_egp, doctor_id, doctor:profiles!courses_doctor_id_fkey(id,full_name)')
    .or(`title.ilike.${like},short_description.ilike.${like}`)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data ?? [];
}

export async function searchUniversities(q: string) {
  const like = `%${q.trim().replace(/\s+/g, '%')}%`;
  const { data, error } = await supabase
    .from('universities')
    .select('*')
    .ilike('name', like)
    .order('name', { ascending: true })
    .limit(50);
  if (error) throw error;
  return data ?? [];
}

export async function searchFaculties(q: string) {
  const like = `%${q.trim().replace(/\s+/g, '%')}%`;
  const { data, error } = await supabase
    .from('faculties')
    .select('*, university:universities(id,name)')
    .ilike('name', like)
    .order('name', { ascending: true })
    .limit(50);
  if (error) throw error;
  return data ?? [];
}

export async function searchAcademicLevels(q: string) {
  const like = `%${q.trim().replace(/\s+/g, '%')}%`;
  const { data, error } = await supabase
    .from('academic_levels')
    .select('*, faculty:faculties(id,name)')
    .ilike('name', like)
    .order('display_order', { ascending: true })
    .limit(50);
  if (error) throw error;
  return data ?? [];
}

// ── Allocate credits using email / phone / user_id (or legacy doctor_id) ──────
export async function allocateCreditsToUser(
  identifier: string,    // email, phone, user_id, or name
  amount: number,
  notes: string,
  idempotencyKey?: string
) {
  return invokeEdgeFunction('credits', {
    action: 'allocate',
    identifier,
    amount,
    notes,
  }, idempotencyKey);
}

// ── Assign activation code to a user by email / phone / user_id ───────────────
export async function assignActivationCode(
  courseId: string,
  identifier: string,    // email, phone, or user_id
  expiresAt?: string,
  idempotencyKey?: string
) {
  return invokeEdgeFunction('activation-codes', {
    action: 'assign',
    course_id: courseId,
    identifier,
    expires_at: expiresAt ?? null,
  }, idempotencyKey);
}

// ── Role Promotion — SECURITY DEFINER DB functions ───────────────────────────
// These run server-side with elevated privilege; the caller only passes IDs.
// The DB function verifies the caller's role internally via auth.uid().

// ── User Management (create user / create admin via Edge Function) ────────────

export interface CreateUserPayload {
  action: 'create_user' | 'create_doctor' | 'create_admin' | 'create_super_admin';
  full_name: string;
  email: string;
  phone?: string;
  phone_country_code?: string;
  phone_national?: string;
  password: string;
  university_id?: string;
  faculty_id?: string;
  academic_level_id?: string;
  status?: 'active' | 'suspended';
}

export async function createManagedUser(payload: CreateUserPayload): Promise<{ user_id: string; role: string }> {
  return invokeEdgeFunction('user-management', payload as unknown as Record<string, unknown>);
}

// ── Role Management ───────────────────────────────────────────────────────────

/** Generic role setter — handles ALL transitions with no prior-role checks. */
export async function setUserRole(userId: string, newRole: 'student' | 'doctor' | 'admin') {
  const { error } = await supabase.rpc('set_user_role', {
    p_user_id:  userId,
    p_new_role: newRole,
  });
  if (error) throw error;
}

/** Shorthand helpers kept for call-site clarity — all delegate to setUserRole. */
export async function promoteToDoctor(userId: string) {
  return setUserRole(userId, 'doctor');
}

export async function demoteDoctor(doctorId: string) {
  return setUserRole(doctorId, 'student');
}

export async function updateUserStatus(userId: string, status: 'active' | 'suspended' | 'blocked') {
  // Use the audited RPC so every status change is logged with actor + description
  const { error } = await supabase.rpc('set_user_status', {
    p_user_id: userId,
    p_status:  status,
  });
  if (error) throw error;
}

/** Suspend a user account (system/violation use only — for admin blocking use blockUser). */
export async function suspendUser(userId: string, _reason?: string) {
  return updateUserStatus(userId, 'suspended');
}

/** Re-activate a previously suspended account. */
export async function activateUser(userId: string) {
  return updateUserStatus(userId, 'active');
}

/**
 * Block a user account (super_admin only).
 * Immediately invalidates all sessions and prevents future logins.
 * Routed through the block-user Edge Function — uses service role on the server.
 */
export async function blockUser(targetUserId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('block-user', {
    body: { target_user_id: targetUserId, action: 'block' },
  });
  if (error) {
    const msg = await (error as any)?.context?.text?.().catch(() => error.message);
    throw new Error(msg ?? 'Failed to block user.');
  }
  if ((data as any)?.error) throw new Error((data as any).error);
}

/**
 * Unblock a previously blocked user account (super_admin only).
 * Does NOT auto-login; user must sign in fresh.
 */
export async function unblockUser(targetUserId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('block-user', {
    body: { target_user_id: targetUserId, action: 'unblock' },
  });
  if (error) {
    const msg = await (error as any)?.context?.text?.().catch(() => error.message);
    throw new Error(msg ?? 'Failed to unblock user.');
  }
  if ((data as any)?.error) throw new Error((data as any).error);
}

export interface DeletePreflight {
  found: boolean;
  id: string;
  role: string;
  full_name: string;
  email: string;
  phone?: string;
  active_courses: number;
  credits_remaining: number;
  devices: number;
  active_enrollments: number;
}

/** Fetch account details + counts for the permanent-delete confirmation modal. */
export async function getDeletePreflight(targetUserId: string): Promise<DeletePreflight> {
  return invokeEdgeFunction<DeletePreflight>('delete-user', { target_user_id: targetUserId }, undefined, 'GET');
}

/** Permanently delete a user account (hard delete). Calls the delete-user EF. */
export async function deleteUser(userId: string, reason?: string): Promise<void> {
  await invokeEdgeFunction('delete-user', {
    target_user_id: userId,
    reason: reason ?? 'Permanent delete by admin',
  });
}

/**
 * Trigger a password reset email for any user (admin-initiated).
 * Also writes an audit log entry via SECURITY DEFINER RPC.
 * @deprecated Use changeAdminPassword() for direct password change instead.
 */
export async function resetUserPassword(targetUserId: string) {
  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('email')
    .eq('id', targetUserId)
    .single();
  if (profileErr || !profile?.email) throw new Error('Could not find user email.');

  const { error } = await supabase.auth.resetPasswordForEmail(profile.email);
  if (error) throw error;

  // Write audit log (non-blocking — do not fail the reset if audit fails)
  Promise.resolve(
    supabase.rpc('reset_user_password_by_admin', { p_target_id: targetUserId })
  ).catch(() => {});
}

/**
 * Directly change a user's password (Super Admin only for admin targets).
 * Uses the change-password Edge Function — no email sent, no old password required.
 */
export async function changeAdminPassword(
  targetUserId: string,
  newPassword: string,
): Promise<{ target_name: string }> {
  return invokeEdgeFunction<{ target_name: string }>('change-password', {
    target_user_id: targetUserId,
    new_password:   newPassword,
  });
}

/** Get credit balance for a doctor (alias that works for admin views). */
export const getCredits = getMyCredits;

// ── Devices — routed through Edge Function ────────────────────────────────────
// All device writes go through the device-binding Edge Function (RLS blocks direct writes).

export interface DeviceRecord {
  id: string;
  device_fingerprint: string;
  device_name: string | null;
  device_model: string | null;
  platform: string;
  os: string | null;
  os_version: string | null;
  app_version: string | null;
  manufacturer: string | null;
  ip_address: string | null;
  status: 'active' | 'blocked' | 'logged_out';
  block_reason: string | null;
  blocked_at: string | null;
  registered_at: string;
  last_active_at: string;
}

export interface LoginHistoryRecord {
  id: string;
  user_id: string;
  device_fingerprint: string | null;
  device_name: string | null;
  platform: string | null;
  ip_address: string | null;
  success: boolean;
  failure_reason: string | null;
  created_at: string;
}

export async function registerDevice(opts: {
  fingerprint: string;
  device_name: string;
  platform: string;
  device_model?: string;
  os?: string;
  os_version?: string;
  app_version?: string;
  manufacturer?: string;
  installation_id?: string;
}) {
  return invokeEdgeFunction<{ device_id?: string; status?: string; error?: string; limit_reached?: boolean; device_blocked?: boolean }>(
    'device-binding',
    { action: 'register', ...opts }
  );
}

/**
 * Update (or clear) the Expo Push Token for the calling user's device.
 * @param pushToken  "ExponentPushToken[...]" string, or null to clear on logout.
 * @param installationId  Stable device ID from getInstallationId().
 */
export async function updateDevicePushToken(
  pushToken: string | null,
  installationId: string,
) {
  return invokeEdgeFunction<{ success: boolean }>('device-binding', {
    action:           'update_push_token',
    push_token:       pushToken,
    installation_id:  installationId,
  });
}

export async function getMyDevices() {
  return invokeEdgeFunction<{ devices: DeviceRecord[]; max_devices: number | null }>(
    'device-binding', { action: 'status' }
  );
}

export async function getAdminUserDevices(targetUserId: string) {
  return invokeEdgeFunction<{
    devices: DeviceRecord[];
    profile: { max_devices: number | null; full_name: string; email: string; role: string } | null;
  }>('device-binding', { action: 'get_devices', target_user_id: targetUserId });
}

export async function logoutDevice(deviceId: string) {
  return invokeEdgeFunction('device-binding', { action: 'logout_device', device_id: deviceId });
}

/** Admin force-logout: revokes device trust_level + bumps security_version → target device is kicked immediately */
export async function forceLogoutDevice(deviceId: string, reason = 'Admin force logout') {
  return invokeEdgeFunction('device-binding', { action: 'force_logout', device_id: deviceId, reason });
}

export async function blockDevice(deviceId: string, blockReason?: string) {
  return invokeEdgeFunction('device-binding', { action: 'block_device', device_id: deviceId, block_reason: blockReason ?? '' });
}

export async function unblockDevice(deviceId: string) {
  return invokeEdgeFunction('device-binding', { action: 'unblock_device', device_id: deviceId });
}

export async function deleteDevice(deviceId: string) {
  return invokeEdgeFunction('device-binding', { action: 'delete_device', device_id: deviceId });
}

export async function renameDevice(deviceId: string, newName: string) {
  return invokeEdgeFunction('device-binding', { action: 'rename_device', device_id: deviceId, new_name: newName });
}

export async function setDeviceLimit(targetUserId: string, maxDevices: number | null) {
  return invokeEdgeFunction('device-binding', { action: 'set_limit', target_user_id: targetUserId, max_devices: maxDevices });
}

export async function resetUserDevice(targetUserId: string, reason?: string) {
  return invokeEdgeFunction('device-binding', { action: 'admin_reset', target_user_id: targetUserId, reason: reason ?? '' });
}

export async function getLoginHistory(targetUserId?: string) {
  return invokeEdgeFunction<{ history: LoginHistoryRecord[] }>(
    'device-binding', { action: 'get_login_history', target_user_id: targetUserId }
  );
}

// ── Courses — reads direct, writes via SECURITY DEFINER RLS ──────────────────
export async function getCourses(options?: { doctorId?: string; status?: string }) {
  // getCourses select updated to include price_egp
  let query = supabase
    .from('courses')
    .select('*, price_egp, doctor:profiles!courses_doctor_id_fkey(id,full_name,avatar_url), category:categories(id,name)')
    .order('created_at', { ascending: false })
    .limit(100);
  if (options?.doctorId) query = query.eq('doctor_id', options.doctorId);
  if (options?.status) query = query.eq('status', options.status);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

// @deprecated alias — use getMySubscriptions instead; the actual implementation is below
// (original getMyCourses body removed; see getMySubscriptions in the Subscriptions section)

/** Returns all published courses with doctor + category info. Used by student explore/search. */
export async function getPublishedCourses() {
  const { data, error } = await supabase
    .from('courses')
    .select('id, title, short_description, image_url, thumbnail_url, price_egp, activation_code_required, doctor:profiles!courses_doctor_id_fkey(id,full_name), category:categories(id,name)')
    .eq('status', 'published')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

export async function getCourseById(courseId: string) {
  const { data, error } = await supabase
    .from('courses')
    .select(`
      *,
      doctor:profiles!courses_doctor_id_fkey(id,full_name,avatar_url),
      category:categories(id,name),
      university:universities(id,name),
      faculty:faculties(id,name),
      academic_level:academic_levels(id,name),
      sections(
        *,
        lessons(
          *,
          lesson_materials(*)
        )
      )
    `)
    .eq('id', courseId)
    .single();
  if (error) throw error;
  // Sort sections and lessons by order_index
  if (data?.sections) {
    data.sections.sort((a: any, b: any) => a.order_index - b.order_index);
    data.sections.forEach((s: any) => {
      if (s.lessons) s.lessons.sort((a: any, b: any) => a.order_index - b.order_index);
    });
  }
  return data;
}

// Course writes — allowed by RLS for doctor_id owner; integrity enforced server-side

/** Contact methods a doctor exposes on their course. At least one must be set. */
export interface CourseContactPayload {
  /**
   * true  = use doctor's profile contact_whatsapp/telegram/phone (default).
   * false = use the course-specific whatsapp/telegram/phone below.
   */
  use_default_contact?: boolean;
  /** WhatsApp phone number — only used when use_default_contact = false */
  whatsapp?: string;
  /** Telegram handle or link — only used when use_default_contact = false */
  telegram?: string;
  /** Phone number for direct calls — only used when use_default_contact = false */
  phone?: string;
}

export interface CourseBuilderPayload {
  title: string;
  description?: string;
  short_description?: string;
  full_description?: string;
  thumbnail_url?: string;
  cover_url?: string;
  university_id?: string;
  faculty_id?: string;
  academic_level_id?: string;
  language?: string;
  instructor_name?: string;
  status?: string;
  sequential_learning?: boolean;
  free_preview?: boolean;
  certificate_enabled?: boolean;
  subscription_required?: boolean;
  /** Course price in Egyptian Pounds (EGP). 0 = free. */
  price_egp?: number;
  doctor_id: string;
}

export async function createCourse(payload: CourseBuilderPayload & CourseContactPayload) {
  // Use audited RPC so every course creation is logged with actor info
  const { data, error } = await supabase.rpc('create_course_audited', {
    p_payload: payload as unknown as Record<string, unknown>,
  });
  if (error) throw error;
  // RPC returns { id, title } — fetch the full record for callers that need it
  const { data: course, error: fetchErr } = await supabase
    .from('courses')
    .select('*')
    .eq('id', (data as any).id)
    .single();
  if (fetchErr) throw fetchErr;
  return course;
}

export async function updateCourse(
  courseId: string,
  updates: Partial<CourseBuilderPayload & CourseContactPayload>
) {
  // Use audited RPC for full audit trail; falls back to direct update for non-audited fields (e.g. image_url only)
  const { error: rpcErr } = await supabase.rpc('update_course_audited', {
    p_course_id: courseId,
    p_updates:   updates as unknown as Record<string, unknown>,
  });
  if (rpcErr) throw rpcErr;
  // Return current state of the course for callers that use the return value
  const { data, error } = await supabase
    .from('courses')
    .select('*')
    .eq('id', courseId)
    .single();
  if (error) throw error;
  return data;
}

/** Publish a course — audited via SECURITY DEFINER RPC. */
export async function publishCourse(courseId: string): Promise<void> {
  const { error } = await supabase.rpc('publish_course', { p_course_id: courseId });
  if (error) throw error;
}

/** Unpublish/hide a course — audited via SECURITY DEFINER RPC. */
export async function unpublishCourse(courseId: string): Promise<void> {
  const { error } = await supabase.rpc('unpublish_course', { p_course_id: courseId });
  if (error) throw error;
}

/** Full course deletion with cascade + storage cleanup + audit. Uses delete-course EF. */
export async function deleteCourseWithCleanup(courseId: string): Promise<{
  students_removed: number;
  lessons_deleted: number;
  videos_deleted: number;
  storage_bytes_freed: number;
}> {
  return invokeEdgeFunction('delete-course', { course_id: courseId });
}

/** Fetch pre-delete stats via SECURITY DEFINER RPC — real SQL COUNTs.
 *  Replaces the broken nested PostgREST count() approach. */
export async function getCourseDeleteStats(courseId: string): Promise<{
  title: string;
  doctor_name: string;
  created_at: string;
  updated_at: string;
  enrolled_count: number;
  section_count: number;
  lesson_count: number;
  video_count: number;
  pdf_count: number;
  attachment_count: number;
  code_count: number;
}> {
  const { data, error } = await supabase.rpc('get_course_delete_stats', { p_course_id: courseId });
  if (error) throw error;
  return data as any;
}

// ── Sections ──────────────────────────────────────────────────────────────────
export async function createSection(courseId: string, title: string, orderIndex: number) {
  const { data, error } = await supabase
    .from('sections')
    .insert({ course_id: courseId, title, order_index: orderIndex })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateSection(sectionId: string, updates: { title?: string; order_index?: number; description?: string }) {
  const { data, error } = await supabase
    .from('sections')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', sectionId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteSection(sectionId: string) {
  const { error } = await supabase.from('sections').delete().eq('id', sectionId);
  if (error) throw error;
}

/** Reorder sections for a course atomically via individual updates. */
export async function reorderSections(courseId: string, orderedIds: string[]) {
  await Promise.all(
    orderedIds.map((id, idx) =>
      supabase.from('sections').update({ order_index: idx }).eq('id', id).eq('course_id', courseId)
    )
  );
}

// ── Lessons ───────────────────────────────────────────────────────────────────
export async function getLessonById(lessonId: string, role?: string) {
  // Defense-in-depth: students must only receive published lessons.
  // The primary enforcement is the RLS policy on the lessons table;
  // this client-side filter is a second layer to prevent accidental exposure
  // if RLS is ever misconfigured, and to return null (→ 404 UI) promptly.
  //
  // IMPORTANT: Supabase query builders are IMMUTABLE — each chained method
  // returns a NEW object. We must reassign `let query` after each `.eq()` call.
  let query = supabase
    .from('lessons')
    .select('*, section:sections(id,course_id,title), lesson_pdfs(*), lesson_materials(*), video_asset_id')
    .eq('id', lessonId);

  if (role === 'student') {
    // Must reassign: `.eq()` returns a new builder, it does NOT mutate in place.
    query = query.eq('status', 'published') as typeof query;
  }

  const { data, error } = await query.single();
  if (error) throw error;
  return data;
}

export interface LessonBuilderPayload {
  section_id: string;
  course_id: string;
  title: string;
  description?: string;
  order_index: number;
  video_type?: 'vdocipher' | 'coming_soon' | 'youtube';
  video_id?: string;
  video_title?: string;
  video_playback_id?: string;
  video_thumbnail?: string;
  video_duration_seconds?: number;
  /** 11-character YouTube video ID — only populated when video_type = 'youtube' */
  youtube_video_id?: string;
  content_html?: string;
  notes?: string;
  is_preview?: boolean;
  download_enabled?: boolean;
  comments_enabled?: boolean;
  visible?: boolean;
  status?: string;
  duration_seconds?: number;
  scheduled_at?: string;
}

export async function createLesson(payload: LessonBuilderPayload) {
  const { data, error } = await supabase.from('lessons').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function updateLesson(lessonId: string, updates: Partial<LessonBuilderPayload>) {
  const { data, error } = await supabase
    .from('lessons')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', lessonId)
    .select()
    .single();
  if (error) throw error;
  // Guard against the silent-failure case: Supabase can return (error=null,
  // data=null) when the UPDATE matched 0 rows — e.g. the row was deleted, the
  // lesson ID is wrong, or an RLS policy matched on the old row but blocked the
  // RETURNING clause on the new row.  Without this guard, callers would see a
  // success toast while the DB remained unchanged.
  if (!data) throw new Error('Lesson update returned no data — the record may not exist or access was denied.');
  return data;
}

export async function deleteLesson(lessonId: string, reason?: string) {
  return invokeEdgeFunction<{ success: boolean; vdo_deleted: boolean; vdo_error?: string }>(
    'delete-lesson',
    { lesson_id: lessonId, reason: reason ?? 'doctor_delete' },
  );
}

/** Reorder lessons inside a section atomically. */
export async function reorderLessons(sectionId: string, orderedIds: string[]) {
  await Promise.all(
    orderedIds.map((id, idx) =>
      supabase.from('lessons').update({ order_index: idx }).eq('id', id).eq('section_id', sectionId)
    )
  );
}

/** Duplicate a lesson (without materials) into the same section. */
export async function duplicateLesson(lessonId: string, newOrderIndex: number) {
  const { data: src, error: fe } = await supabase.from('lessons').select('*').eq('id', lessonId).single();
  if (fe) throw fe;
  const { id: _id, created_at: _c, updated_at: _u, ...rest } = src;
  const { data, error } = await supabase
    .from('lessons')
    .insert({ ...rest, title: `${rest.title} (Copy)`, order_index: newOrderIndex, status: 'draft' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Upload a video file to the lesson-materials bucket and return paths.
 *  The doctor never sees the storage path — the platform links it internally. */
// REMOVED: uploadLessonVideo — dead code. Video files go directly to VdoCipher.
// PDFs and lesson attachments continue to use uploadLessonMaterial() below.

/** Replace an existing lesson material file — keeps the same DB record, swaps the storage object. */
export async function replaceLessonMaterialFile(
  materialId: string,
  oldStoragePath: string,
  courseId: string,
  lessonId: string,
  fileUri: string,
  fileName: string,
  mimeType: string,
  fileSize: number,
): Promise<any> {
  // Upload new file
  const { storagePath, publicUrl } = await uploadLessonMaterial(
    courseId, lessonId, fileUri, fileName, mimeType,
  );
  // Delete old file from storage (best-effort)
  await supabase.storage.from('lesson-materials').remove([oldStoragePath]).catch(() => null);
  // Update DB record
  const { data, error } = await supabase
    .from('lesson_materials')
    .update({
      file_name: fileName,
      file_url: publicUrl,
      storage_path: storagePath,
      file_type: mimeType,
      file_size: fileSize,
      updated_at: new Date().toISOString(),
    })
    .eq('id', materialId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Lesson Materials ──────────────────────────────────────────────────────────
export interface LessonMaterialPayload {
  lesson_id: string;
  course_id: string;
  uploaded_by: string;
  file_name: string;
  file_url: string;
  storage_path: string;
  file_type: string;
  file_size: number;
  download_enabled?: boolean;
  preview_enabled?: boolean;
  order_index?: number;
}

export async function getLessonMaterials(lessonId: string) {
  const { data, error } = await supabase
    .from('lesson_materials')
    .select('*')
    .eq('lesson_id', lessonId)
    .order('order_index');
  if (error) throw error;
  return data ?? [];
}

export async function createLessonMaterial(payload: LessonMaterialPayload) {
  const { data, error } = await supabase.from('lesson_materials').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function updateLessonMaterial(id: string, updates: Partial<{ file_name: string; download_enabled: boolean; preview_enabled: boolean; order_index: number }>) {
  const { data, error } = await supabase.from('lesson_materials').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteLessonMaterial(id: string, storagePath: string) {
  // Remove from storage first
  await supabase.storage.from('lesson-materials').remove([storagePath]);
  const { error } = await supabase.from('lesson_materials').delete().eq('id', id);
  if (error) throw error;
}

// ── Course Cover Image ────────────────────────────────────────────────────────

/**
 * Upload (or replace) the cover image for a course.
 * Uses a unique timestamped filename per upload so the public URL changes
 * each time — this is required because Supabase CDN caches by URL, so
 * reusing the same path (upsert) serves the old cached image even after
 * the Storage object is replaced.
 *
 * Flow:
 *   1. Generate a unique path: `{courseId}/{timestamp}-cover.{ext}`
 *   2. Upload to Storage (no upsert needed — always a new path)
 *   3. Get the new public URL
 *   4. Persist new URL to DB (courses.image_url)
 *   5. Delete the old Storage object (best-effort, using previous URL)
 *
 * Bucket: 'course-images' (public, created in migration 00002)
 */
export async function uploadCourseCover(
  courseId: string,
  fileUri: string,
  mimeType = 'image/jpeg',
  previousUrl?: string,
): Promise<string> {
  const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg';
  // Unique path per upload — URL changes so CDN never serves stale content
  const storagePath = `${courseId}/${Date.now()}-cover.${ext}`;

  const resp = await fetch(fileUri);
  const blob = await resp.blob();

  const { error: upErr } = await supabase.storage
    .from('course-images')
    .upload(storagePath, blob, { contentType: mimeType, upsert: false });
  if (upErr) throw upErr;

  const { data: urlData } = supabase.storage.from('course-images').getPublicUrl(storagePath);
  const publicUrl = urlData.publicUrl;

  // Persist new URL to DB before deleting old file
  await updateCourse(courseId, { image_url: publicUrl } as any);

  // Delete old Storage object (best-effort — do NOT block on this)
  if (previousUrl) {
    const marker = '/course-images/';
    const idx = previousUrl.indexOf(marker);
    if (idx !== -1) {
      const oldPath = previousUrl.slice(idx + marker.length).split('?')[0];
      await supabase.storage.from('course-images').remove([oldPath]).catch(() => {});
    }
  }

  return publicUrl;
}

/**
 * Remove the cover image for a course.
 * Deletes the file from storage (best-effort) and clears image_url in the DB.
 */
export async function removeCourseCover(courseId: string, currentUrl: string): Promise<void> {
  // Clear DB first so no stale URL can be restored on reload
  await updateCourse(courseId, { image_url: null } as any);
  // Then delete Storage object (best-effort)
  try {
    const marker = '/course-images/';
    const idx = currentUrl.indexOf(marker);
    if (idx !== -1) {
      const storagePath = currentUrl.slice(idx + marker.length).split('?')[0];
      await supabase.storage.from('course-images').remove([storagePath]);
    }
  } catch (_) { /* best-effort */ }
}

/** Upload a file to lesson-materials bucket and return { storagePath, fileUrl }.
 *
 *  WHY NO PUBLIC URL
 *  ─────────────────
 *  The `lesson-materials` bucket is PRIVATE (public: false).  Calling
 *  getPublicUrl() on a private bucket generates a /object/public/... URL that
 *  Supabase Storage immediately rejects with "Bucket not found" because public
 *  access is disabled.  We store only the storage_path and generate a fresh
 *  signed URL at open-time via getMaterialSignedUrl().
 */
export async function uploadLessonMaterial(
  courseId: string,
  lessonId: string,
  fileUri: string,
  fileName: string,
  mimeType: string
): Promise<{ storagePath: string; publicUrl: string }> {
  const storagePath = `${courseId}/${lessonId}/${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

  // Fetch file as blob
  const resp = await fetch(fileUri);
  const blob = await resp.blob();

  const { error: upErr } = await supabase.storage
    .from('lesson-materials')
    .upload(storagePath, blob, { contentType: mimeType, upsert: false });
  if (upErr) throw upErr;

  // Return the storage path as the "publicUrl" placeholder so existing callers
  // that store file_url continue to work.  The actual URL is always generated
  // as a signed URL at read-time; this value is never opened directly.
  return { storagePath, publicUrl: storagePath };
}

// ── Private Storage — Signed URL helpers ─────────────────────────────────────
//
// WHY EDGE FUNCTION:
//   Both `lesson-materials` and `lesson-pdfs` buckets are private (public:false).
//   Supabase Storage's createSignedUrl endpoint checks the SELECT RLS policy
//   using the caller's JWT role. On React Native, the Supabase JS client uses
//   expo-sqlite localStorage shim for session persistence; if the session is
//   not yet hydrated when the Storage API call is made, the request runs as
//   the `anon` role, which has no SELECT policy on either bucket → AccessDenied.
//
//   Solution: route through the `get-signed-url` Edge Function, which:
//     1. Validates the caller's JWT explicitly (requireAuth)
//     2. Applies authorisation logic server-side
//     3. Calls createSignedUrl using the service_role key (bypasses RLS on the
//        storage API itself, so the call always succeeds for authorised users)

/** Generate a 1-hour signed URL for a private lesson-materials file.
 *
 *  Accepts either a raw storage_path or a legacy full URL — the Edge Function
 *  normalises it automatically.
 */
export async function getMaterialSignedUrl(storagePathOrUrl: string): Promise<string> {
  const result = await invokeEdgeFunction<{ signed_url: string }>('get-signed-url', {
    bucket: 'lesson-materials',
    path:   storagePathOrUrl,
    expires_in: 3600,
  });
  return result.signed_url;
}

/** Generate a 1-hour signed URL for a private lesson-pdfs file.
 *
 *  Accepts either a raw storage path or a legacy full URL.
 */
export async function getLessonPdfSignedUrl(fileUrlOrPath: string): Promise<string> {
  const result = await invokeEdgeFunction<{ signed_url: string }>('get-signed-url', {
    bucket: 'lesson-pdfs',
    path:   fileUrlOrPath,
    expires_in: 3600,
  });
  return result.signed_url;
}

// ── Lesson Progress ───────────────────────────────────────────────────────────
export async function getLessonProgress(studentId: string, courseId: string) {
  const { data, error } = await supabase
    .from('lesson_progress')
    .select('*')
    .eq('student_id', studentId)
    .eq('course_id', courseId)
    .limit(500);
  if (error) throw error;
  return data ?? [];
}

export async function upsertLessonProgress(payload: {
  student_id: string;
  lesson_id: string;
  course_id: string;
  watch_position_seconds: number;
  completed: boolean;
}) {
  const { error } = await supabase
    .from('lesson_progress')
    .upsert({ ...payload, last_watched_at: new Date().toISOString() }, { onConflict: 'student_id,lesson_id' });
  if (error) throw error;
}

// ── Credits — reads direct; writes via Edge Function ─────────────────────────
// Credit mutation (allocate/refund) must go through the Edge Function.
// grant_course_access stays as a SECURITY DEFINER DB function (atomic + idempotent).

/** Live credit balance — uses the get_my_credits_balance RPC (SECURITY DEFINER). Never returns null. */
export async function getLiveCreditBalance(): Promise<{ allocated: number; consumed: number; remaining: number }> {
  const { data, error } = await supabase.rpc('get_my_credits_balance');
  if (error) throw error;
  return data as { allocated: number; consumed: number; remaining: number };
}

export async function getMyCredits(doctorId: string) {
  const { data, error } = await supabase.from('credits').select('*').eq('doctor_id', doctorId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function getCreditTransactions(doctorId: string) {
  const { data, error } = await supabase
    .from('credit_transactions')
    .select('*, course:courses!credit_transactions_course_id_fkey(title), student:profiles!credit_transactions_student_id_fkey(full_name)')
    .eq('doctor_id', doctorId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

export async function allocateCredits(
  doctorId: string,
  amount: number,
  notes: string,
  idempotencyKey?: string
) {
  // Routed through Edge Function — service role key never in client
  return invokeEdgeFunction('credits', { action: 'allocate', doctor_id: doctorId, amount, notes }, idempotencyKey);
}

export async function refundCredits(
  doctorId: string,
  amount: number,
  notes: string,
  idempotencyKey?: string
) {
  return invokeEdgeFunction('credits', { action: 'refund', doctor_id: doctorId, amount, notes }, idempotencyKey);
}

export async function getAllCredits() {
  const { data, error } = await supabase
    .from('credits')
    .select('*, doctor:profiles!credits_doctor_id_fkey(id,full_name,email)')
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

// ── Subscriptions (formerly: Enrollments) ────────────────────────────────────
// grantCourseAccess uses SECURITY DEFINER DB function:
// validates ownership + credits + atomically subscribes, deducts, logs
export async function grantCourseAccess(
  studentId: string,
  courseId: string,
  idempotencyKey?: string
) {
  const { data, error } = await supabase.rpc('grant_course_access', {
    p_student_id: studentId,
    p_course_id: courseId,
    p_idempotency_key: idempotencyKey ?? null,
  });
  if (error) throw error;
  return data;
}

// getSubscribedStudents — returns students subscribed to a given course
export async function getSubscribedStudents(courseId: string) {
  const { data, error } = await supabase
    .from('enrollments')
    .select('*, student:profiles!enrollments_student_id_fkey(id,full_name,email,phone)')
    .eq('course_id', courseId)
    .limit(500);
  if (error) throw error;
  return data ?? [];
}

// ── Doctor Student Management ─────────────────────────────────────────────────

/** Returns all students enrolled in any course owned by doctorId, with rich details. */
export async function getDoctorStudentEnrollments(doctorId: string) {
  // Uses SECURITY DEFINER RPC get_doctor_students to bypass RLS and perform a
  // proper SQL JOIN (courses.doctor_id = p_doctor_id). The old PostgREST query
  // used .eq('courses.doctor_id') [wrong alias] + .order('created_at') [wrong
  // column — enrollments has enrolled_at] which caused a silent PostgREST error
  // returning an empty array for every doctor.
  const { data, error } = await supabase.rpc('get_doctor_students', { p_doctor_id: doctorId });
  if (error) throw error;
  // RPC returns a jsonb array; supabase-js wraps scalar RPCs as { data: value }
  const rows: any[] = Array.isArray(data) ? data : [];
  return rows;
}

/** Suspend a student's course subscription (doctor or admin only). */
export async function suspendCourseSubscription(enrollmentId: string) {
  const { error } = await supabase
    .from('enrollments')
    .update({ status: 'suspended', updated_at: new Date().toISOString() })
    .eq('id', enrollmentId);
  if (error) throw error;
}

/** Resume a suspended course subscription. */
export async function resumeCourseSubscription(enrollmentId: string) {
  const { error } = await supabase
    .from('enrollments')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', enrollmentId);
  if (error) throw error;
}

/** Remove a student from a course via SECURITY DEFINER RPC.
 *  Fixes the silent no-op caused by the missing DELETE RLS policy on enrollments:
 *  client-side .delete() returned 200 with 0 rows affected (RLS blocked it),
 *  making the student re-appear on every refresh. */
export async function removeStudentFromCourse(enrollmentId: string) {
  const { data, error } = await supabase.rpc('remove_course_enrollment', {
    p_enrollment_id: enrollmentId,
    p_doctor_id: (await supabase.auth.getUser()).data.user?.id ?? '',
  });
  if (error) throw error;
  return data;
}

/** Enroll a student via credits — calls SECURITY DEFINER grant_course_access RPC,
 *  which atomically deducts 1 credit, creates enrollment, writes ledger + audit. */
// ── student-operations Edge Function wrappers ─────────────────────────────────
// All student creation + activation now routes through the single unified
// student-operations EF which guarantees atomicity and proper rollback.

export type StudentOpMode =
  | 'create_only'
  | 'create_and_enroll_credits'
  | 'create_and_enroll_code'
  | 'enroll_existing_credits'
  | 'enroll_existing_code';

export interface StudentOpResult {
  success: boolean;
  mode: StudentOpMode;
  student_id: string;
  email?: string | null;        // null for phone-only accounts — never the internal email
  phone?: string | null;        // display phone (local format, e.g. 01020182886)
  phone_e164?: string | null;   // E.164 format (+201020182886)
  login_type?: 'email' | 'phone' | 'both';
  activation?: {
    balance_before?: number;
    balance_after?: number;
    transaction_id?: string;
    idempotent?: boolean;
  };
}

/**
 * Unified student operation — single atomic EF call for all create/enroll modes.
 * Replaces createStudentByDoctor + enrollStudentViaCredits + enrollStudentViaCode.
 */
export async function processStudentOperation(params: {
  mode: StudentOpMode;
  // New student fields (modes A/B/C)
  full_name?: string;
  email?: string;
  phone?: string;
  password?: string;
  university_id?: string;
  faculty_id?: string;
  academic_level_id?: string;
  // Existing student (modes D/E)
  student_id?: string;
  // Activation fields (modes B/C/D/E)
  course_id?: string;
  activation_code?: string;
}): Promise<StudentOpResult> {
  return invokeEdgeFunction<StudentOpResult>('student-operations', params as unknown as Record<string, unknown>);
}

/** @deprecated Use processStudentOperation with mode='create_only' */
export async function createStudentByDoctor(params: {
  full_name: string;
  email?: string;
  phone?: string;
  password: string;
  university_id?: string;
  faculty_id?: string;
  academic_level_id?: string;
}) {
  const result = await processStudentOperation({ mode: 'create_only', ...params });
  return { success: result.success, user_id: result.student_id, email: result.email ?? '' };
}

/** @deprecated Use processStudentOperation with mode='enroll_existing_credits' */
export async function enrollStudentViaCredits(studentId: string, courseId: string) {
  return processStudentOperation({
    mode: 'enroll_existing_credits',
    student_id: studentId,
    course_id: courseId,
  });
}

/** @deprecated Use processStudentOperation with mode='enroll_existing_code' */
export async function enrollStudentViaCode(code: string) {
  // Legacy: code-only enroll without creating a student or specifying course.
  // The old path used a direct RPC (redeem_activation_code) which the caller
  // passes to. Keep this path for the existing "Via Code" tab in add-student modal.
  const { data, error } = await supabase.rpc('redeem_activation_code', {
    p_code: code.trim().toUpperCase(),
  });
  if (error) throw error;
  return data;
}

// @deprecated Use getSubscribedStudents — kept for backward compatibility
export const getEnrolledStudents = getSubscribedStudents;

// ── Student Courses Browse ─────────────────────────────────────────────────────

/**
 * Returns the newest `limit` published courses for the student home page.
 * Does NOT return all courses — keeps the initial load fast.
 */
export async function getFeaturedCourses(limit = 10) {
  const { data, error } = await supabase
    .from('courses')
    .select('id, title, description, image_url, price_egp, whatsapp, telegram, phone, use_default_contact, doctor:profiles!courses_doctor_id_fkey(id,full_name,contact_whatsapp,contact_telegram,contact_phone), category:categories(id,name)')
    .eq('status', 'published')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

/**
 * Searches ALL published courses by title / description / instructor name.
 * Only called when the student has typed a non-empty query.
 */
export async function searchAllPublishedCourses(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const { data, error } = await supabase
    .from('courses')
    .select('id, title, description, image_url, price_egp, whatsapp, telegram, phone, use_default_contact, doctor:profiles!courses_doctor_id_fkey(id,full_name,contact_whatsapp,contact_telegram,contact_phone), category:categories(id,name)')
    .eq('status', 'published')
    .or(`title.ilike.%${q}%,description.ilike.%${q}%`)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return data ?? [];
}

// getMySubscriptions — returns the calling student's subscribed courses
export async function getMySubscriptions(studentId: string) {
  const { data, error } = await supabase
    .from('enrollments')
    .select('*, course:courses!enrollments_course_id_fkey(*, doctor:profiles!courses_doctor_id_fkey(id,full_name), category:categories(id,name))')
    .eq('student_id', studentId)
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

// @deprecated Use getMySubscriptions — kept for backward compatibility
export const getMyCourses = getMySubscriptions;

// ── Activation Codes — writes via Edge Function ───────────────────────────────
// Direct INSERT is blocked in RLS (migration 00004).
// Redemption uses SECURITY DEFINER DB function for atomic row-level locking.

export async function getActivationCodes() {
  // Limit to 200 rows and exclude batched codes (batch_id IS NULL) to prevent
  // the JOIN query from timing out when large batches exist in the table.
  // Per-batch code rows are loaded on demand via getActivationLedger({ batchId }).
  const { data, error } = await supabase
    .from('activation_codes')
    .select('*, course:courses!activation_codes_course_id_fkey(title), used_by_profile:profiles!activation_codes_used_by_fkey(full_name)')
    .is('batch_id', null)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

export async function createActivationCode(
  courseId: string,
  expiresAt?: string,
  idempotencyKey?: string
) {
  // Routed through Edge Function — generates code server-side
  return invokeEdgeFunction(
    'activation-codes',
    { action: 'create', course_id: courseId, expires_at: expiresAt ?? null },
    idempotencyKey
  );
}

export async function batchCreateActivationCodes(
  courseId: string,
  count: number,
  opts?: {
    expiresAt?: string;
    batchLabel?: string;
    notes?: string;
    prefix?: string;
    maxUses?: number | 'unlimited';
  },
  idempotencyKey?: string
) {
  return invokeEdgeFunction(
    'activation-codes',
    {
      action: 'batch_create',
      course_id: courseId,
      count,
      expires_at: opts?.expiresAt ?? null,
      batch_label: opts?.batchLabel ?? null,
      notes: opts?.notes ?? null,
      prefix: opts?.prefix ?? null,
      max_uses: opts?.maxUses === 'unlimited' ? null : (opts?.maxUses ?? null),
    },
    idempotencyKey
  );
}

export async function deleteActivationCode(codeId: string) {
  return invokeEdgeFunction('activation-codes', { action: 'delete_code', code_id: codeId });
}

export async function deactivateActivationCode(codeId: string) {
  // action name matches EF handler: 'deactivate' (not 'deactivate_code')
  return invokeEdgeFunction('activation-codes', { action: 'deactivate', code_id: codeId });
}

export async function reactivateActivationCode(codeId: string) {
  return invokeEdgeFunction('activation-codes', { action: 'reactivate', code_id: codeId });
}

export async function bulkDeleteActivationCodes(codeIds: string[]) {
  return invokeEdgeFunction('activation-codes', { action: 'bulk_delete', code_ids: codeIds });
}

export async function bulkDisableActivationCodes(codeIds: string[]) {
  return invokeEdgeFunction('activation-codes', { action: 'bulk_disable', code_ids: codeIds });
}

export async function bulkEnableActivationCodes(codeIds: string[]) {
  return invokeEdgeFunction('activation-codes', { action: 'bulk_enable', code_ids: codeIds });
}

export async function redeemActivationCode(code: string) {
  // SECURITY DEFINER DB function: row-locked, rate-limited, single-redemption guaranteed
  const { data, error } = await supabase.rpc('redeem_activation_code', { p_code: code });
  if (error) throw error;
  return data;
}

// ── Password Management — via Edge Function ───────────────────────────────────
// Self-service: pass only newPassword (changes caller's own password)
// Admin change: pass targetUserId + newPassword (role hierarchy enforced server-side)
// Does NOT reset device binding, subscriptions, credits, progress, or audit history.
export async function changePassword(newPassword: string, targetUserId?: string, currentInstallationId?: string) {
  return invokeEdgeFunction('change-password', {
    new_password: newPassword,
    ...(targetUserId ? { target_user_id: targetUserId } : {}),
    ...(currentInstallationId ? { current_installation_id: currentInstallationId } : {}),
  });
}

// ── Video Playback — OTP via Edge Function ────────────────────────────────────
// VDOCIPHER_API_SECRET never leaves the server.
// Returns { otp, playbackInfo } for the VdoCipher player.
export async function getVideoPlaybackToken(videoId: string, lessonId?: string) {
  return invokeEdgeFunction<{ otp: string; playbackInfo: string }>(
    'vdocipher-otp',
    { video_id: videoId, lesson_id: lessonId ?? null }
  );
}

// ── Video Upload — VdoCipher credential generation ────────────────────────────
// Step 1 of the upload pipeline: create a VdoCipher video entry server-side
// (so VDOCIPHER_API_SECRET never touches the client) and return upload creds.
// Returns { video_id, upload_url, client_payload } where:
//   video_id       — VdoCipher opaque video ID (store immediately on the lesson)
//   upload_url     — S3 presigned POST endpoint (the "uploadLink" from VdoCipher)
//   client_payload — ALL other S3 form fields verbatim (key, policy, x-amz-*, …)
//
// The frontend copies client_payload into FormData, then EXPLICITLY appends
// success_action_status="201" and success_action_redirect="" per the official
// VdoCipher browser upload spec:
// https://www.vdocipher.com/docs/server/upload/browser/
export async function initVdoCipherUpload(lessonId: string, title: string) {
  return invokeEdgeFunction<{
    video_id:       string;
    upload_url:     string;
    client_payload: Record<string, unknown>;
  }>(
    'vdocipher-upload-init',
    { lesson_id: lessonId, title }
  );
}

// ── VdoCipher — delete video asset ────────────────────────────────────────────
// Deletes a VdoCipher asset and optionally clears the lesson video reference.
// Called on: cancel, markFailed, replaceVideo, deleteVideo, lesson/course delete.
export async function deleteVdoCipherVideo(
  videoId: string,
  opts?: {
    lessonId?: string;
    uploadId?: string;
    reason?: string;
    clearLesson?: boolean;
  },
): Promise<{ success: boolean; vdo_deleted: boolean; vdo_error?: string }> {
  return invokeEdgeFunction<{ success: boolean; vdo_deleted: boolean; vdo_error?: string }>(
    'vdocipher-delete-video',
    {
      video_id:     videoId,
      lesson_id:    opts?.lessonId,
      upload_id:    opts?.uploadId,
      reason:       opts?.reason ?? 'manual_delete',
      clear_lesson: opts?.clearLesson ?? false,
    },
  );
}

// ── Chunked Video Upload — API helpers ────────────────────────────────────────

/**
 * Fetch the current chunk progress for a resumable upload.
 * Returns { total_chunks, chunks_completed, chunk_size_bytes, assembly_triggered, status }
 * Used on resume to skip already-uploaded chunks.
 */
export async function getChunkUploadState(uploadId: string): Promise<{
  total_chunks: number;
  chunks_completed: number;
  chunk_size_bytes: number;
  assembly_triggered: boolean;
  status: string;
} | null> {
  const { data, error } = await supabase.rpc('get_chunk_upload_state', { p_upload_id: uploadId });
  if (error || !data || data.length === 0) return null;
  return data[0] as {
    total_chunks: number;
    chunks_completed: number;
    chunk_size_bytes: number;
    assembly_triggered: boolean;
    status: string;
  };
}

/**
 * POST a single binary chunk to the video-upload-chunk Edge Function.
 * Uses native fetch (not invokeEdgeFunction) because the body is binary, not JSON.
 *
 * @param uploadId    - video_uploads.id (UUID)
 * @param chunkIndex  - 0-based index of this chunk
 * @param totalChunks - total number of chunks
 * @param chunkData   - raw binary data for this chunk (Uint8Array or ArrayBuffer)
 * @param fileName    - original file name for metadata
 * @param mimeType    - original MIME type
 * @returns { received, total, assembly_triggered }
 */
export async function uploadVideoChunk(params: {
  uploadId:    string;
  chunkIndex:  number;
  totalChunks: number;
  chunkData:   Uint8Array | ArrayBuffer;
  fileName:    string;
  mimeType:    string;
  signal?:     AbortSignal;
}): Promise<{ received: number; total: number; assembly_triggered: boolean }> {
  const { uploadId, chunkIndex, totalChunks, chunkData, fileName, mimeType, signal } = params;

  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) throw new Error('Not authenticated');

  // Route through PHP backend instead of Supabase Edge Function
  const API_BASE =
    process.env.EXPO_PUBLIC_PHP_API_URL ||
    process.env.EXPO_PUBLIC_SUPABASE_URL?.replace(/\/?$/, '/backend/public/index.php') || '';
  const url = `${API_BASE}/video/chunk`;
  // Use expo/fetch — global fetch cannot send ArrayBuffer bodies on iOS/Android
  const body: ArrayBuffer = (chunkData instanceof Uint8Array ? chunkData : new Uint8Array(chunkData)).buffer as ArrayBuffer;

  const response = await expoFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':   'application/octet-stream',
      'Authorization':  `Bearer ${token}`,
      'x-upload-id':    uploadId,
      'x-chunk-index':  String(chunkIndex),
      'x-total-chunks': String(totalChunks),
      'x-chunk-size':   String(body.byteLength),
      'x-file-name':    fileName,
      'x-mime-type':    mimeType,
    },
    body,
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    let errMsg = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(errText) as { error?: string };
      if (parsed.error) errMsg = parsed.error;
    } catch { errMsg = errText || errMsg; }
    throw new Error(`Chunk ${chunkIndex} upload failed: ${errMsg}`);
  }

  return response.json() as Promise<{ received: number; total: number; assembly_triggered: boolean }>;
}

/**
 * Trigger assembly of all chunks into a final video on VdoCipher.
 * Idempotent — safe to call even if assembly was already triggered.
 * Returns { status, video_id, chunks_assembled }
 */
export async function triggerChunkAssembly(params: {
  uploadId:    string;
  totalChunks: number;
  fileName:    string;
  mimeType:    string;
}): Promise<{ status: string; video_id: string; chunks_assembled?: number; skipped_upload?: boolean }> {
  return invokeEdgeFunction<{ status: string; video_id: string; chunks_assembled?: number; skipped_upload?: boolean }>(
    'video-assemble-upload',
    {
      upload_id:    params.uploadId,
      total_chunks: params.totalChunks,
      file_name:    params.fileName,
      mime_type:    params.mimeType,
    },
  );
}

// ── Video Upload — status polling ─────────────────────────────────────────────
// Step 3 of the upload pipeline: poll VdoCipher for encoding status.
// Returns { status: 'processing'|'encoding'|'ready'|'failed', vdo_status, duration?, poster? }
// Call repeatedly (every ~5 s) after the frontend finishes the direct S3 upload
// until status === 'ready' or status === 'failed'.
export async function getVdoCipherVideoStatus(videoId: string) {
  return invokeEdgeFunction<{
    video_id: string;
    status: 'processing' | 'encoding' | 'ready' | 'failed';
    vdo_status: string;
    title: string | null;
    duration: number | null;
    poster: string | null;
    error?: string;
  }>(
    'vdocipher-upload-status',
    { video_id: videoId },
    undefined,
    'GET'
  );
}

// ── Notifications ─────────────────────────────────────────────────────────────
export async function getNotifications(userId: string) {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return data ?? [];
}

export async function markNotificationRead(notificationId: string) {
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', notificationId);
  if (error) throw error;
}

export async function deleteNotification(notificationId: string) {
  const { error } = await supabase.from('notifications').delete().eq('id', notificationId);
  if (error) throw error;
}

export async function getUnreadNotificationCount(userId: string) {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_read', false);
  if (error) return 0;
  return count ?? 0;
}

// ── Audit Logs — read-only from client ───────────────────────────────────────
// Writes are blocked for clients (migration 00004).
// Only SECURITY DEFINER functions and the service role can write audit logs.
export async function getAuditLogs(limit = 100) {
  const { data, error } = await supabase
    .from('audit_logs')
    .select('*, actor:profiles!audit_logs_actor_id_fkey(full_name,email,role)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export interface AuditTrailFilters {
  search?:     string;
  // category: 'users'|'roles'|'doctor'|'student'|'courses'|'codes'|'auth'|'platform'|'finance'|'security'
  category?:      string;
  logStatus?:     string;   // 'success'|'failed'|'warning'
  dateFrom?:      string;   // ISO string
  dateTo?:        string;   // ISO string
  actorSearch?:   string;   // search by actor name/email
  targetSearch?:  string;   // search by target name
  resourceSearch?: string;  // search by resource type or id
  limit?:         number;
  offset?:        number;
}

export interface AuditTrailEntry {
  id:            string;
  action:        string;
  actor_id:      string | null;
  actor_name:    string | null;
  actor_email:   string | null;
  actor_role:    string | null;
  target_name:   string | null;
  description:   string | null;
  log_status:    string;
  resource_type: string | null;
  resource_id:   string | null;
  old_values:    Record<string, unknown> | null;
  new_values:    Record<string, unknown> | null;
  details:       Record<string, unknown> | null;
  ip_address:    string | null;
  created_at:    string;
  total_count:   number;
}

export async function getAuditTrail(filters: AuditTrailFilters = {}): Promise<{
  entries: AuditTrailEntry[];
  totalCount: number;
}> {
  // Combine actor/target/resource into the general search if no unified search present
  const combinedSearch =
    filters.search ??
    filters.actorSearch ??
    filters.targetSearch ??
    filters.resourceSearch ??
    null;

  const { data, error } = await supabase.rpc('search_audit_logs', {
    p_search:        combinedSearch,
    p_action_filter: null,
    p_category:      filters.category      ?? null,
    p_log_status:    filters.logStatus     ?? null,
    p_date_from:     filters.dateFrom      ?? null,
    p_date_to:       filters.dateTo        ?? null,
    p_limit:         filters.limit         ?? 100,
    p_offset:        filters.offset        ?? 0,
  });
  if (error) throw error;
  const rows = (data ?? []) as AuditTrailEntry[];
  return {
    entries: rows,
    totalCount: rows[0]?.total_count ?? 0,
  };
}

// ── Categories ────────────────────────────────────────────────────────────────
export async function getCategories() {
  const { data, error } = await supabase.from('categories').select('*').order('name');
  if (error) throw error;
  return data ?? [];
}

// ── System Config ─────────────────────────────────────────────────────────────
export async function getSystemConfig() {
  const { data, error } = await supabase.from('system_config').select('*');
  if (error) throw error;
  return data ?? [];
}

export async function upsertSystemConfig(key: string, value: unknown) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('system_config')
    .upsert({ key, value, updated_by: user!.id, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

// ── Support Settings ──────────────────────────────────────────────────────────

export interface SupportContactEntry {
  value:   string;
  label:   string;
  enabled: boolean;
}

export interface SupportSettings {
  phone?:    SupportContactEntry;
  whatsapp?: SupportContactEntry;
  telegram?: SupportContactEntry;
}

/** Fetch all support contact entries from the support_settings table. */
export async function getSupportSettings(): Promise<SupportSettings> {
  const { data, error } = await supabase
    .from('support_settings')
    .select('key, value, label, enabled');
  if (error) throw error;
  const result: SupportSettings = {};
  for (const row of data ?? []) {
    if (row.key === 'phone' || row.key === 'whatsapp' || row.key === 'telegram') {
      result[row.key as keyof SupportSettings] = {
        value:   row.value   ?? '',
        label:   row.label   ?? '',
        enabled: row.enabled ?? false,
      };
    }
  }
  return result;
}

/** Upsert a single support contact entry (Super Admin only). */
export async function upsertSupportSetting(
  key: 'phone' | 'whatsapp' | 'telegram',
  entry: Partial<SupportContactEntry>,
) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('support_settings')
    .upsert(
      { key, ...entry, updated_by: user?.id, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) throw error;
}


export async function getAdminStats() {
  const [users, courses, codes, students, doctors] = await Promise.all([
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    supabase.from('courses').select('id', { count: 'exact', head: true }),
    supabase.from('activation_codes').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'student'),
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'doctor'),
  ]);
  return {
    totalUsers: users.count ?? 0,
    totalStudents: students.count ?? 0,
    totalDoctors: doctors.count ?? 0,
    totalCourses: courses.count ?? 0,
    totalActiveCodes: codes.count ?? 0,
  };
}

// ── Universities ──────────────────────────────────────────────────────────────
export async function getUniversities() {
  const { data, error } = await supabase
    .from('universities')
    .select('*')
    .order('name', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function createUniversity(name: string) {
  const { data, error } = await supabase
    .from('universities')
    .insert({ name: name.trim() })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateUniversity(id: string, updates: Partial<{ name: string; is_active: boolean }>) {
  const { data, error } = await supabase
    .from('universities')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteUniversity(id: string) {
  const { error } = await supabase.from('universities').delete().eq('id', id);
  if (error) throw error;
}

// ── Faculties ─────────────────────────────────────────────────────────────────
export async function getFaculties(universityId?: string) {
  let query = supabase
    .from('faculties')
    .select('*, university:universities(id,name)')
    .order('name', { ascending: true });
  if (universityId) query = query.eq('university_id', universityId);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function createFaculty(universityId: string, name: string) {
  const { data, error } = await supabase
    .from('faculties')
    .insert({ university_id: universityId, name: name.trim() })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateFaculty(id: string, updates: Partial<{ name: string; is_active: boolean }>) {
  const { data, error } = await supabase
    .from('faculties')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteFaculty(id: string) {
  const { error } = await supabase.from('faculties').delete().eq('id', id);
  if (error) throw error;
}

// ── Academic Levels ───────────────────────────────────────────────────────────
export async function getAcademicLevels(facultyId: string) {
  const { data, error } = await supabase
    .from('academic_levels')
    .select('*')
    .eq('faculty_id', facultyId)
    .order('display_order', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function getAllAcademicLevels() {
  const { data, error } = await supabase
    .from('academic_levels')
    .select('*, faculty:faculties(id,name)')
    .order('display_order', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function createAcademicLevel(facultyId: string, name: string, displayOrder: number) {
  const { data, error } = await supabase
    .from('academic_levels')
    .insert({ faculty_id: facultyId, name: name.trim(), display_order: displayOrder })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateAcademicLevel(
  id: string,
  updates: Partial<{ name: string; display_order: number; is_active: boolean; faculty_id: string }>
) {
  const { data, error } = await supabase
    .from('academic_levels')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteAcademicLevel(id: string) {
  const { error } = await supabase.from('academic_levels').delete().eq('id', id);
  if (error) throw error;
}

// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE ADMIN PANEL V2 — NEW API FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════════

// ── Super Admin Comprehensive Stats ──────────────────────────────────────────
export async function getSuperAdminStats() {
  const [
    students, doctors, admins, superAdmins,
    universities, faculties, levels,
    publishedCourses, draftCourses,
    devices, credits, codes,
  ] = await Promise.all([
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'student'),
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'doctor'),
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin'),
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'super_admin'),
    supabase.from('universities').select('id', { count: 'exact', head: true }),
    supabase.from('faculties').select('id', { count: 'exact', head: true }),
    supabase.from('academic_levels').select('id', { count: 'exact', head: true }),
    supabase.from('courses').select('id', { count: 'exact', head: true }).eq('status', 'published'),
    supabase.from('courses').select('id', { count: 'exact', head: true }).eq('status', 'draft'),
    supabase.from('device_stats').select('*').single(),
    supabase.from('credits_summary').select('*').single(),
    supabase.from('activation_codes_summary').select('*').single(),
  ]);

  const totalUsers = (students.count ?? 0) + (doctors.count ?? 0) + (admins.count ?? 0) + (superAdmins.count ?? 0);
  return {
    totalStudents:    students.count ?? 0,
    totalDoctors:     doctors.count ?? 0,
    totalAdmins:      admins.count ?? 0,
    totalSuperAdmins: superAdmins.count ?? 0,
    totalUsers,
    totalUniversities: universities.count ?? 0,
    totalFaculties:    faculties.count ?? 0,
    totalLevels:       levels.count ?? 0,
    publishedCourses:  publishedCourses.count ?? 0,
    draftCourses:      draftCourses.count ?? 0,
    totalCourses:      (publishedCourses.count ?? 0) + (draftCourses.count ?? 0),
    totalDevices:      (devices.data as any)?.total_devices ?? 0,
    usersWithDevices:  (devices.data as any)?.users_with_devices ?? 0,
    totalCredits:      Number((credits.data as any)?.total_credits ?? 0),
    usedCredits:       Number((credits.data as any)?.used_credits ?? 0),
    remainingCredits:  Number((credits.data as any)?.remaining_credits ?? 0),
    activeCodes:       Number((codes.data as any)?.active_codes ?? 0),
    usedCodes:         Number((codes.data as any)?.used_codes ?? 0),
    disabledCodes:     Number((codes.data as any)?.disabled_codes ?? 0),
    expiredCodes:      Number((codes.data as any)?.expired_codes ?? 0),
    totalCodes:        Number((codes.data as any)?.total_codes ?? 0),
  };
}

// ── Video Provider Management ─────────────────────────────────────────────────

export interface VideoProvider {
  id: string;
  provider_key: string;
  display_name: string;
  is_globally_enabled: boolean;
  updated_at: string;
}

export interface TeacherProviderPermission {
  provider_key: string;
  display_name: string;
  global_enabled: boolean;
  teacher_enabled: boolean;
  final_enabled: boolean;
}

export interface TeacherWithPermissions {
  id: string;
  full_name: string;
  email: string;
  permissions: TeacherProviderPermission[];
}

/** Fetch all global video providers (super_admin / authenticated read). */
export async function getVideoProviders(): Promise<VideoProvider[]> {
  const { data, error } = await supabase
    .from('video_providers')
    .select('*')
    .order('provider_key');
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

/** Toggle a global provider on/off (super_admin only). */
export async function setGlobalProviderEnabled(
  providerKey: string,
  enabled: boolean,
): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('video_providers')
    .update({ is_globally_enabled: enabled, updated_by: user?.id, updated_at: new Date().toISOString() })
    .eq('provider_key', providerKey);
  if (error) throw error;
}

/** Fetch resolved provider permissions for the calling user (doctor). */
export async function getMyProviderPermissions(): Promise<TeacherProviderPermission[]> {
  const { data, error } = await supabase.rpc('get_teacher_provider_permissions');
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

/** Fetch resolved provider permissions for a specific teacher (super_admin only). */
export async function getTeacherProviderPermissionsById(
  teacherId: string,
): Promise<TeacherProviderPermission[]> {
  const { data, error } = await supabase.rpc('get_teacher_provider_permissions', {
    p_teacher_id: teacherId,
  });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

/** Upsert a teacher-level provider permission (super_admin only). */
export async function setTeacherProviderPermission(
  teacherId: string,
  providerKey: string,
  enabled: boolean,
): Promise<void> {
  const { error } = await supabase.rpc('upsert_teacher_provider_permission', {
    p_teacher_id: teacherId,
    p_provider_key: providerKey,
    p_is_enabled: enabled,
  });
  if (error) throw error;
}

/** List all doctors for super_admin video provider management. */
export async function getDoctorsForProviderMgmt(): Promise<
  Array<{ id: string; full_name: string; email: string }>
> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, email')
    .eq('role', 'doctor')
    .order('full_name');
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

// ── Feature Flags ─────────────────────────────────────────────────────────────
export async function getFeatureFlags() {
  const { data, error } = await supabase
    .from('feature_flags')
    .select('*')
    .order('key');
  if (error) throw error;
  return data ?? [];
}

export async function toggleFeatureFlag(key: string, enabled: boolean) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('feature_flags')
    .update({ enabled, updated_by: user?.id, updated_at: new Date().toISOString() })
    .eq('key', key);
  if (error) throw error;
}

// ── Branding ──────────────────────────────────────────────────────────────────
export async function getBranding() {
  const { data, error } = await supabase
    .from('app_branding')
    .select('*')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single();
  if (error) throw error;
  return data;
}

export async function updateBranding(updates: Partial<{
  app_name: string; logo_url: string; splash_logo_url: string;
  primary_color: string; secondary_color: string; contact_email: string;
  contact_phone: string; facebook_url: string; instagram_url: string;
  youtube_url: string; telegram_url: string; whatsapp_url: string;
  website_url: string; support_email: string;
}>) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('app_branding')
    .update({ ...updates, updated_by: user?.id, updated_at: new Date().toISOString() })
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── CMS Pages ─────────────────────────────────────────────────────────────────
export async function getCMSPages() {
  const { data, error } = await supabase
    .from('app_pages')
    .select('*')
    .order('key');
  if (error) throw error;
  return data ?? [];
}

export async function getCMSPage(key: string) {
  const { data, error } = await supabase
    .from('app_pages')
    .select('*')
    .eq('key', key)
    .single();
  if (error) throw error;
  return data;
}

export async function updateCMSPage(key: string, updates: { title?: string; content?: string; published?: boolean }) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('app_pages')
    .update({ ...updates, updated_by: user?.id, updated_at: new Date().toISOString() })
    .eq('key', key)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Maintenance Mode ──────────────────────────────────────────────────────────
export async function getMaintenanceConfig() {
  const { data, error } = await supabase
    .from('system_config')
    .select('key, value')
    .in('key', ['maintenance_enabled', 'maintenance_message']);
  if (error) throw error;
  const cfg: Record<string, unknown> = {};
  (data ?? []).forEach((row: { key: string; value: unknown }) => { cfg[row.key] = row.value; });
  return {
    enabled: cfg.maintenance_enabled === true || cfg.maintenance_enabled === 'true',
    message: (cfg.maintenance_message as string) ?? 'We are currently performing maintenance.',
  };
}

export async function setMaintenanceMode(enabled: boolean, message?: string) {
  await Promise.all([
    upsertSystemConfig('maintenance_enabled', enabled),
    ...(message !== undefined ? [upsertSystemConfig('maintenance_message', message)] : []),
  ]);
}

export async function getMaintenanceWhitelist() {
  const { data, error } = await supabase
    .from('maintenance_whitelist')
    .select('*, profile:profiles!maintenance_whitelist_user_id_fkey(id,full_name,email,role,phone_e164)')
    .order('added_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function addToMaintenanceWhitelist(userId: string) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('maintenance_whitelist')
    .upsert({ user_id: userId, added_by: user?.id }, { onConflict: 'user_id' });
  if (error) throw error;
}

export async function removeFromMaintenanceWhitelist(userId: string) {
  const { error } = await supabase
    .from('maintenance_whitelist')
    .delete()
    .eq('user_id', userId);
  if (error) throw error;
}

// ── Pricing ───────────────────────────────────────────────────────────────────
export async function getPricingSettings() {
  const { data, error } = await supabase
    .from('system_config')
    .select('key, value')
    .in('key', ['credit_price', 'activation_code_price']);
  if (error) throw error;
  const cfg: Record<string, unknown> = {};
  (data ?? []).forEach((row: { key: string; value: unknown }) => { cfg[row.key] = row.value; });
  return {
    creditPrice: (cfg.credit_price as { amount: number; currency: string }) ?? { amount: 10, currency: 'EGP' },
    activationCodePrice: (cfg.activation_code_price as { amount: number; currency: string }) ?? { amount: 25, currency: 'EGP' },
  };
}

export async function updatePricingSettings(creditAmount: number, codeAmount: number, currency = 'EGP') {
  await Promise.all([
    upsertSystemConfig('credit_price', { amount: creditAmount, currency }),
    upsertSystemConfig('activation_code_price', { amount: codeAmount, currency }),
  ]);
}

/** Set a doctor's individual credit selling price.
 *  Writes an audit log entry with old/new values automatically (server-side RPC). */
export async function setDoctorCreditPrice(
  doctorId:  string,
  newPrice:  number,
  actorId?:  string,
  actorName?: string,
  actorRole?: string,
): Promise<void> {
  const { error } = await supabase.rpc('set_doctor_credit_price', {
    p_doctor_id:  doctorId,
    p_new_price:  newPrice,
    p_actor_id:   actorId  ?? null,
    p_actor_name: actorName ?? null,
    p_actor_role: actorRole ?? null,
  });
  if (error) throw error;
}

/** Set a per-course price override for a doctor (admin only). */
export async function setDoctorCoursePrice(
  courseId: string,
  newPrice: number,
): Promise<void> {
  const { error } = await supabase
    .from('courses')
    .update({ price_egp: newPrice })
    .eq('id', courseId);
  if (error) throw error;
}

export interface DoctorActivityStats {
  credit_selling_price: number;
  total_allocated:      number;
  total_used:           number;
  remaining_credits:    number;
  total_earnings:       number;
  courses_sold:         number;
  students_enrolled:    number;
  videos_uploaded:      number;
  last_login:           string | null;
  last_active:          string | null;
}

/** Returns aggregated activity stats for a single doctor. */
export async function getDoctorActivityStats(doctorId: string): Promise<DoctorActivityStats | null> {
  const { data, error } = await supabase.rpc('get_doctor_activity_stats', { p_doctor_id: doctorId });
  if (error) throw error;
  return data as DoctorActivityStats | null;
}

// ── Doctor Management (Admin/SA) ──────────────────────────────────────────────
export async function getDoctors(options?: { status?: string }) {
  // credits table columns: id, doctor_id, allocated, consumed, remaining, updated_at
  // (no 'total_allocated' column — use 'allocated')
  let q = supabase
    .from('profiles')
    .select('*, university:universities(id,name), faculty:faculties(id,name), credits:credits(remaining,allocated,consumed)')
    .eq('role', 'doctor')
    .order('full_name');
  if (options?.status) q = q.eq('status', options.status);
  const { data, error } = await q;
  if (error) throw error;
  // credits is a 1-to-1 join returned as an array; flatten for convenience
  return (data ?? []).map((d: any) => {
    const cr = Array.isArray(d.credits) ? d.credits[0] : d.credits;
    return {
      ...d,
      credits_balance: cr?.remaining ?? 0,
      credits_allocated: cr?.allocated ?? 0,
      credits_consumed: cr?.consumed ?? 0,
    };
  });
}

export async function promoteToAdmin(userId: string) {
  return setUserRole(userId, 'admin');
}

export async function demoteAdmin(adminId: string) {
  return setUserRole(adminId, 'student');
}

// ── Notification Center ───────────────────────────────────────────────────────
export async function sendBroadcastNotification(payload: {
  title: string;
  body: string;
  target_type: 'all' | 'role' | 'university' | 'faculty' | 'level' | 'course' | 'individual';
  target_role?: string;
  target_university_id?: string;
  target_faculty_id?: string;
  target_level_id?: string;
  target_course_id?: string;
  target_user_id?: string;
}) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  // For individual target
  if (payload.target_type === 'individual' && payload.target_user_id) {
    const { error } = await supabase.from('notifications').insert({
      user_id: payload.target_user_id,
      title: payload.title,
      body: payload.body,
      notification_type: 'admin_broadcast',
      target_type: payload.target_type,
      sent_by: user.id,
    });
    if (error) throw error;
    return;
  }

  // For broadcast to a group — fetch target user IDs first
  let userIds: string[] = [];

  if (payload.target_type === 'course' && payload.target_course_id) {
    // Students enrolled in the selected course
    const { data: enrollments, error: enrollErr } = await supabase
      .from('enrollments')
      .select('student_id')
      .eq('course_id', payload.target_course_id);
    if (enrollErr) throw enrollErr;
    userIds = (enrollments ?? []).map((e: { student_id: string }) => e.student_id);
  } else {
    let userQuery = supabase.from('profiles').select('id');
    if (payload.target_type === 'role' && payload.target_role) {
      userQuery = userQuery.eq('role', payload.target_role);
    } else if (payload.target_type === 'university' && payload.target_university_id) {
      userQuery = userQuery.eq('university_id', payload.target_university_id);
    } else if (payload.target_type === 'faculty' && payload.target_faculty_id) {
      userQuery = userQuery.eq('faculty_id', payload.target_faculty_id);
    } else if (payload.target_type === 'level' && payload.target_level_id) {
      userQuery = userQuery.eq('academic_level_id', payload.target_level_id);
    }
    const { data: users, error: usersErr } = await userQuery.limit(500);
    if (usersErr) throw usersErr;
    userIds = (users ?? []).map((u: { id: string }) => u.id);
  }

  const inserts = userIds.map(uid => ({
    user_id: uid,
    title: payload.title,
    body: payload.body,
    notification_type: 'admin_broadcast',
    target_type: payload.target_type,
    target_role: payload.target_role ?? null,
    target_university_id: payload.target_university_id ?? null,
    target_faculty_id: payload.target_faculty_id ?? null,
    target_level_id: payload.target_level_id ?? null,
    sent_by: user.id,
  }));

  if (inserts.length === 0) return;
  const { error } = await supabase.from('notifications').insert(inserts);
  if (error) throw error;
}

export async function getSentNotifications(limit = 50) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('sent_by', user?.id ?? '')
    .order('sent_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

// ── Reports ───────────────────────────────────────────────────────────────────
export async function getReportData(type: string, from?: string, to?: string) {
  const fromDate = from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const toDate = to ?? new Date().toISOString();

  switch (type) {
    case 'credits': {
      const { data, error } = await supabase
        .from('credit_transactions')
        .select('*, doctor:profiles!credit_transactions_doctor_id_fkey(full_name,email)')
        .gte('created_at', fromDate)
        .lte('created_at', toDate)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return data ?? [];
    }
    case 'activation': {
      const { data, error } = await supabase
        .from('activation_codes')
        .select('*, course:courses(title), redeemed_by:profiles!activation_codes_redeemed_by_fkey(full_name,email)')
        .gte('created_at', fromDate)
        .lte('created_at', toDate)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return data ?? [];
    }
    case 'users': {
      const { data, error } = await supabase
        .from('profiles')
        .select('id,full_name,email,phone_e164,role,status,created_at,university:universities(name),faculty:faculties(name)')
        .gte('created_at', fromDate)
        .lte('created_at', toDate)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return data ?? [];
    }
    default:
      return [];
  }
}

// ── Storage Stats ─────────────────────────────────────────────────────────────
export async function getStorageStats() {
  try {
    const [
      { data: buckets },
      { data: plyrUploads },
      { data: vdoLessons },
    ] = await Promise.all([
      supabase.storage.listBuckets(),
      // Plyr: active uploads only (exclude failed/canceled/deleted)
      supabase
        .from('video_uploads')
        .select('file_size, provider')
        .in('status', ['ready', 'uploading', 'processing', 'encoding', 'verifying', 'waiting']),
      // VdoCipher: lessons with vdocipher video set
      supabase
        .from('lessons')
        .select('id, video_type')
        .eq('video_type', 'vdocipher')
        .not('video_id', 'is', null)
        .neq('video_id', '')
        .is('deleted_at', null),
    ]);

    const plyrBytes = (plyrUploads ?? []).reduce((s: number, u: any) => s + (u.file_size ?? 0), 0);
    const vdoCount  = (vdoLessons ?? []).length;

    return {
      buckets:      buckets ?? [],
      totalBuckets: buckets?.length ?? 0,
      plyrStorage:  plyrBytes,
      vdoVideoCount: vdoCount,
      // VdoCipher does not expose file size via this API;
      // show count and note that size is managed by VdoCipher externally.
      vdoStorageNote: 'Storage managed by VdoCipher (external)',
      totalLocalBytes: plyrBytes,
    };
  } catch {
    return {
      buckets: [], totalBuckets: 0,
      plyrStorage: 0, vdoVideoCount: 0,
      vdoStorageNote: 'Storage managed by VdoCipher (external)',
      totalLocalBytes: 0,
    };
  }
}

// ── Revenue Calculation ───────────────────────────────────────────────────────
export async function getRevenueStats() {
  const [pricing, creditTx] = await Promise.all([
    getPricingSettings(),
    supabase
      .from('credit_transactions')
      .select('amount, created_at, transaction_type')
      .in('transaction_type', ['allocation', 'grant_admin', 'grant_super_admin'])
      .order('created_at', { ascending: false })
      .limit(1000),
  ]);

  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const thisYear = new Date(now.getFullYear(), 0, 1).toISOString();

  const txns = creditTx.data ?? [];
  const totalCreditsAllocated = txns.reduce((sum: number, t: { amount: number | null }) => sum + (t.amount ?? 0), 0);
  const monthlyCredits = txns
    .filter((t: { created_at: string; amount: number | null }) => t.created_at >= thisMonth)
    .reduce((sum: number, t: { amount: number | null }) => sum + (t.amount ?? 0), 0);
  const yearlyCredits = txns
    .filter((t: { created_at: string; amount: number | null }) => t.created_at >= thisYear)
    .reduce((sum: number, t: { amount: number | null }) => sum + (t.amount ?? 0), 0);

  const unitPrice = pricing.creditPrice.amount;
  return {
    totalRevenue: totalCreditsAllocated * unitPrice,
    monthlyRevenue: monthlyCredits * unitPrice,
    yearlyRevenue: yearlyCredits * unitPrice,
    currency: pricing.creditPrice.currency,
    creditPrice: unitPrice,
    activationCodePrice: pricing.activationCodePrice.amount,
  };
}

// ── Platform Earnings Reset ───────────────────────────────────────────────────

export interface EarningsResetRecord {
  id: string;
  reset_at: string;
  earnings_before: number;
  reset_by_email: string;
}

export interface PlatformEarningsStats {
  totalEarningsAllTime: number;
  earningsSinceReset: number;
  lastReset: EarningsResetRecord | null;
  currency: string;
  creditPrice: number;
}

/**
 * Returns platform earnings stats:
 * - total all-time revenue
 * - revenue since the last reset (earnings counter value)
 * - last reset record
 */
export async function getPlatformEarningsStats(): Promise<PlatformEarningsStats> {
  const [pricing, creditTx, resetRows] = await Promise.all([
    getPricingSettings(),
    supabase
      .from('credit_transactions')
      .select('amount, created_at, transaction_type')
      .in('transaction_type', ['allocation', 'grant_admin', 'grant_super_admin'])
      .order('created_at', { ascending: false })
      .limit(5000),
    supabase
      .from('platform_earnings_resets')
      .select('id, reset_at, earnings_before, reset_by_email')
      .order('reset_at', { ascending: false })
      .limit(1),
  ]);

  const txns = creditTx.data ?? [];
  const unitPrice = pricing.creditPrice.amount;
  const lastReset = (resetRows.data ?? [])[0] ?? null;

  const totalCredits = txns.reduce((s: number, t: { amount: number | null }) => s + (t.amount ?? 0), 0);
  const totalEarningsAllTime = totalCredits * unitPrice;

  const creditsAfterReset = lastReset
    ? txns
        .filter((t: { created_at: string; amount: number | null }) => t.created_at > lastReset.reset_at)
        .reduce((s: number, t: { amount: number | null }) => s + (t.amount ?? 0), 0)
    : totalCredits;

  return {
    totalEarningsAllTime,
    earningsSinceReset: creditsAfterReset * unitPrice,
    lastReset: lastReset ?? null,
    currency: pricing.creditPrice.currency,
    creditPrice: unitPrice,
  };
}

/**
 * Atomically resets the platform earnings counter via SECURITY DEFINER RPC.
 * Writes an audit log entry. Only callable by super_admin.
 */
export async function resetPlatformEarnings(
  earningsBefore: number,
  adminEmail: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('reset_platform_earnings', {
    p_earnings_before: earningsBefore,
    p_admin_email:     adminEmail,
    p_note:            null,
  });
  if (error) throw error;
  return data as string;
}

// ── Enterprise Ledger API ─────────────────────────────────────────────────────

/**
 * Full credit ledger from the denormalized view (up to 2000 rows).
 * Supports server-side filtering by transaction_type and performed_by.
 */
export async function getCreditLedger(opts?: {
  type?: string;
  doctorId?: string;
  performedBy?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}) {
  let q = supabase
    .from('credit_ledger_view')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(opts?.limit ?? 2000);

  if (opts?.offset) q = q.range(opts.offset, opts.offset + (opts.limit ?? 2000) - 1);
  if (opts?.type)        q = q.eq('transaction_type', opts.type);
  if (opts?.doctorId)    q = q.eq('doctor_id', opts.doctorId);
  if (opts?.performedBy) q = q.eq('performed_by', opts.performedBy);
  if (opts?.from)        q = q.gte('created_at', opts.from);
  if (opts?.to)          q = q.lte('created_at', opts.to);

  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

/** Summary stats for the credit ledger dashboard widgets */
export async function getCreditLedgerStats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIso = today.toISOString();

  const [all, todayRows] = await Promise.all([
    supabase
      .from('credit_transactions')
      .select('transaction_type, amount'),
    supabase
      .from('credit_transactions')
      .select('transaction_type, amount')
      .gte('created_at', todayIso),
  ]);

  const allTx    = all.data ?? [];
  const todayTx  = todayRows.data ?? [];
  const addTypes = ['allocation', 'grant_admin', 'grant_super_admin', 'adjustment', 'transfer', 'restoration'];
  const useTypes = ['consumption'];
  const remTypes = ['deduction', 'expiry'];

  const sum = (arr: typeof allTx, types: string[]) =>
    arr
      .filter((t: { transaction_type: string; amount: number | null }) => types.includes(t.transaction_type))
      .reduce((s: number, t: { transaction_type: string; amount: number | null }) => s + (t.amount ?? 0), 0);

  return {
    total_tx:       allTx.length,
    total_added:    sum(allTx,   addTypes),
    total_used:     sum(allTx,   useTypes),
    total_removed:  sum(allTx,   remTypes),
    total_refunded: sum(allTx,   ['restoration']),
    today_added:    sum(todayTx, addTypes),
    today_used:     sum(todayTx, useTypes),
    today_removed:  sum(todayTx, remTypes),
  };
}

/** Doctor credit timeline — from doctor_credit_summary view */
export async function getDoctorCreditSummary(doctorId?: string) {
  let q = supabase.from('doctor_credit_summary').select('*');
  if (doctorId) q = q.eq('id', doctorId);
  const { data, error } = await q;
  if (error) throw error;
  return doctorId ? (data?.[0] ?? null) : (data ?? []);
}

/** Credit daily stats for analytics chart */
export async function getCreditDailyStats(days = 30) {
  const from = new Date();
  from.setDate(from.getDate() - days);
  const { data, error } = await supabase
    .from('credit_daily_stats')
    .select('*')
    .gte('day', from.toISOString().slice(0, 10))
    .order('day', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Top doctors by credits balance */
export async function getTopDoctorsByCredits(limit = 10) {
  const { data, error } = await supabase
    .from('doctor_credit_summary')
    .select('*')
    .order('current_balance', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

/** Full activation code ledger from the denormalized view */
export async function getActivationLedger(opts?: {
  status?: string;
  courseId?: string;
  createdBy?: string;
  batchId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}) {
  let q = supabase
    .from('activation_ledger_view')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(opts?.limit ?? 2000);

  if (opts?.offset) q = q.range(opts.offset, opts.offset + (opts.limit ?? 2000) - 1);
  if (opts?.status)    q = q.eq('status',     opts.status);
  if (opts?.courseId)  q = q.eq('course_id',  opts.courseId);
  if (opts?.createdBy) q = q.eq('created_by', opts.createdBy);
  if (opts?.batchId)   q = q.eq('batch_id',   opts.batchId);
  if (opts?.from)      q = q.gte('created_at', opts.from);
  if (opts?.to)        q = q.lte('created_at', opts.to);

  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

/** Summary stats for the activation code ledger dashboard widgets */
export async function getActivationLedgerStats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIso = today.toISOString();

  const [all, todayRows] = await Promise.all([
    supabase.from('activation_codes').select('status'),
    supabase.from('activation_codes').select('status').gte('created_at', todayIso),
  ]);

  const allCodes   = all.data ?? [];
  const todayCodes = todayRows.data ?? [];

  return {
    total:          allCodes.length,
    used:           allCodes.filter((c: { status: string }) => c.status === 'used').length,
    active:         allCodes.filter((c: { status: string }) => c.status === 'active').length,
    expired:        allCodes.filter((c: { status: string }) => c.status === 'expired').length,
    disabled:       allCodes.filter((c: { status: string }) => ['disabled', 'deactivated'].includes(c.status)).length,
    today_generated: todayCodes.length,
    today_used:     todayCodes.filter((c: { status: string }) => c.status === 'used').length,
  };
}

/** Batch list with counts */
export async function getCodeBatches() {
  const { data, error } = await supabase
    .from('code_batches')
    .select('*, course:courses!code_batches_course_id_fkey(title), creator:profiles!code_batches_created_by_fkey(full_name, role)')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return data ?? [];
}

/** Most activated courses (by used activation codes) */
export async function getMostActivatedCourses(limit = 5) {
  const { data, error } = await supabase
    .from('activation_codes')
    .select('course_id, course:courses!activation_codes_course_id_fkey(title)')
    .eq('status', 'used')
    .limit(5000);
  if (error) throw error;

  const counts: Record<string, { title: string; count: number }> = {};
  for (const row of (data ?? [])) {
    const key = row.course_id;
    if (!counts[key]) counts[key] = { title: (row.course as any)?.title ?? key, count: 0 };
    counts[key].count++;
  }
  return Object.entries(counts)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, limit)
    .map(([id, v]) => ({ course_id: id, ...v }));
}

/** Fraud flags — unresolved only */
export async function getFraudFlags(resolved = false) {
  const { data, error } = await supabase
    .from('fraud_flags')
    .select('*, doctor:profiles!fraud_flags_doctor_id_fkey(full_name)')
    .eq('resolved', resolved)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return data ?? [];
}

/** Resolve a fraud flag */
export async function resolveFraudFlag(flagId: string) {
  const { error } = await supabase
    .from('fraud_flags')
    .update({ resolved: true, resolved_at: new Date().toISOString() })
    .eq('id', flagId);
  if (error) throw error;
}

/** Get revenue analytics rows (from the view) */
export async function getRevenueAnalytics(opts?: {
  from?: string; to?: string; adminId?: string; doctorId?: string; limit?: number;
}) {
  let q = supabase
    .from('revenue_analytics')
    .select('*')
    .order('day', { ascending: false })
    .limit(opts?.limit ?? 5000);
  if (opts?.from)     q = q.gte('day', opts.from);
  if (opts?.to)       q = q.lte('day', opts.to);
  if (opts?.adminId)  q = q.eq('admin_id', opts.adminId);
  if (opts?.doctorId) q = q.eq('doctor_id', opts.doctorId);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

/** Low credit threshold from system_config */
export async function getLowCreditThreshold(): Promise<number> {
  const { data } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', 'low_credit_threshold')
    .single();
  return (data?.value as any)?.amount ?? 10;
}

/** Update low credit threshold */
export async function setLowCreditThreshold(amount: number) {
  const { error } = await supabase
    .from('system_config')
    .update({ value: { amount } })
    .eq('key', 'low_credit_threshold');
  if (error) throw error;
}

/** Enable unlimited devices for a user (max_devices = null) */
export async function enableUnlimitedDevices(userId: string) {
  return invokeEdgeFunction('device-binding', { action: 'set_limit', target_user_id: userId, max_devices: null });
}

/** Disable unlimited devices (revert to a numeric limit) */
export async function disableUnlimitedDevices(userId: string, limit = 1) {
  return invokeEdgeFunction('device-binding', { action: 'set_limit', target_user_id: userId, max_devices: limit });
}

/** Demote an admin to student role (routed through set_user_role RPC for full audit trail). */
export async function demoteAdminToStudent(adminId: string) {
  return setUserRole(adminId, 'student');
}

/** Get activity timeline for a user (audit + login events) */
export async function getUserActivityTimeline(userId: string, limit = 50) {
  const { data, error } = await supabase
    .from('audit_logs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export interface UserProfileSummary {
  id:            string;
  full_name:     string;
  email:         string | null;
  profile_email: string | null;
  phone:         string | null;
  role:          string;
  status:        string;
  avatar_url:    string | null;
  created_at:    string;
  last_login:    string | null;
  last_logout:   string | null;
  last_active:   string | null;
}

export async function getUserProfileSummary(userId: string): Promise<UserProfileSummary | null> {
  const { data, error } = await supabase.rpc('get_user_profile_summary', { p_user_id: userId });
  if (error) throw error;
  return data as UserProfileSummary | null;
}

export interface UserActivityEntry {
  id:            string;
  action:        string;
  actor_id:      string | null;
  actor_name:    string | null;
  actor_email:   string | null;
  actor_role:    string | null;
  target_name:   string | null;
  description:   string | null;
  log_status:    string;
  resource_type: string | null;
  resource_id:   string | null;
  old_values:    Record<string, unknown> | null;
  new_values:    Record<string, unknown> | null;
  details:       Record<string, unknown> | null;
  ip_address:    string | null;
  created_at:    string;
  total_count:   number;
}

export async function getUserActivity(opts: {
  userId:     string;
  category?:  string;
  search?:    string;
  direction?: string;   // 'by' | 'on' | undefined (both)
  dateFrom?:  string;   // ISO string
  dateTo?:    string;   // ISO string
  limit?:     number;
  offset?:    number;
}): Promise<{ entries: UserActivityEntry[]; totalCount: number }> {
  const { data, error } = await supabase.rpc('get_user_activity', {
    p_user_id:   opts.userId,
    p_category:  opts.category  ?? null,
    p_search:    opts.search    ?? null,
    p_direction: opts.direction ?? null,
    p_date_from: opts.dateFrom  ?? null,
    p_date_to:   opts.dateTo    ?? null,
    p_limit:     opts.limit     ?? 50,
    p_offset:    opts.offset    ?? 0,
  });
  if (error) throw error;
  const rows = (data ?? []) as UserActivityEntry[];
  return { entries: rows, totalCount: rows[0]?.total_count ?? 0 };
}

/** Course activation stats — for the course timeline */
export async function getCourseActivationStats(courseId: string) {
  const { data, error } = await supabase
    .from('activation_codes')
    .select('status')
    .eq('course_id', courseId);
  if (error) throw error;
  const rows = data ?? [];
  return {
    total:    rows.length,
    used:     rows.filter((r: { status: string }) => r.status === 'used').length,
    active:   rows.filter((r: { status: string }) => r.status === 'active').length,
    expired:  rows.filter((r: { status: string }) => r.status === 'expired').length,
    disabled: rows.filter((r: { status: string }) => ['disabled','deactivated'].includes(r.status)).length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v48 — ADVANCED COURSE BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

// ── Course Progress (RPC) ─────────────────────────────────────────────────────
export interface CourseProgressResult {
  total_lessons: number;
  completed_lessons: number;
  progress_pct: number;
  remaining_seconds: number;
  last_lesson_id: string | null;
  last_viewed_at: string | null;
}

export async function getCourseProgress(
  studentId: string,
  courseId: string
): Promise<CourseProgressResult> {
  const { data, error } = await supabase.rpc('get_course_progress', {
    p_student_id: studentId,
    p_course_id: courseId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row ?? {
    total_lessons: 0, completed_lessons: 0, progress_pct: 0,
    remaining_seconds: 0, last_lesson_id: null, last_viewed_at: null,
  };
}

// ── Update lesson_materials permission field ──────────────────────────────────
export type DownloadPermission = 'allow' | 'preview_only' | 'hidden' | 'disabled';

export async function updateMaterialPermission(id: string, permission: DownloadPermission) {
  const { data, error } = await supabase
    .from('lesson_materials')
    .update({ permission, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Course Duplication (RPC) ──────────────────────────────────────────────────
export async function duplicateCourse(
  courseId: string,
  doctorId: string,
  newTitle?: string
): Promise<string> {
  const { data, error } = await supabase.rpc('duplicate_course', {
    p_source_id:     courseId,
    p_target_doctor: doctorId,
    p_new_title:     newTitle ?? null,
  });
  if (error) throw error;
  return data as string;
}

// ── Course Templates ──────────────────────────────────────────────────────────
export interface CourseTemplate {
  id: string;
  doctor_id: string;
  title: string;
  description?: string;
  source_course_id?: string;
  template_data: Record<string, unknown>;
  is_public: boolean;
  created_at: string;
}

export async function getCourseTemplates(doctorId: string): Promise<CourseTemplate[]> {
  const { data, error } = await supabase
    .from('course_templates')
    .select('*')
    .or(`doctor_id.eq.${doctorId},is_public.eq.true`)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function saveCourseAsTemplate(
  courseId: string,
  doctorId: string,
  templateTitle: string
): Promise<CourseTemplate> {
  // Pull course + sections + lessons to embed in template_data
  const { data: course, error: ce } = await supabase
    .from('courses')
    .select('*, sections(*, lessons(*))')
    .eq('id', courseId)
    .single();
  if (ce) throw ce;

  const { sections, ...courseData } = course as any;
  const templateData = {
    course: courseData,
    sections: (sections ?? []).map((s: any) => ({
      ...s,
      lessons: (s.lessons ?? []).map((l: any) => ({
        ...l,
        // strip student-specific data
        id: undefined, created_at: undefined, updated_at: undefined,
      })),
    })),
  };

  const { data, error } = await supabase
    .from('course_templates')
    .insert({
      doctor_id: doctorId,
      title: templateTitle,
      source_course_id: courseId,
      template_data: templateData,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteCourseTemplate(templateId: string) {
  const { error } = await supabase.from('course_templates').delete().eq('id', templateId);
  if (error) throw error;
}

export async function createCourseFromTemplate(
  templateId: string,
  doctorId: string
): Promise<string> {
  // Load template
  const { data: tmpl, error: te } = await supabase
    .from('course_templates')
    .select('*')
    .eq('id', templateId)
    .single();
  if (te) throw te;

  const td = (tmpl as CourseTemplate).template_data as any;
  const c = td?.course ?? {};

  // Create course
  const { data: newCourse, error: nce } = await supabase
    .from('courses')
    .insert({
      title: `${c.title ?? 'Untitled'} (from template)`,
      description: c.description, short_description: c.short_description,
      category_id: c.category_id, university_id: c.university_id,
      faculty_id: c.faculty_id, academic_level_id: c.academic_level_id,
      language: c.language, difficulty: c.difficulty, tags: c.tags,
      sequential_learning: c.sequential_learning, free_preview: c.free_preview,
      certificate_enabled: c.certificate_enabled,
      subscription_required: c.subscription_required,
      price_egp: c.price_egp,
      activation_code_required: c.activation_code_required,
      doctor_id: doctorId, status: 'draft',
    })
    .select()
    .single();
  if (nce) throw nce;
  const courseId = (newCourse as any).id as string;

  // Create sections + lessons
  for (const sec of td?.sections ?? []) {
    const { data: newSec, error: se } = await supabase
      .from('sections')
      .insert({ course_id: courseId, title: sec.title, description: sec.description, order_index: sec.order_index })
      .select()
      .single();
    if (se) throw se;
    for (const les of sec.lessons ?? []) {
      await supabase.from('lessons').insert({
        section_id: (newSec as any).id,
        course_id: courseId,
        title: les.title,
        description: les.description,
        order_index: les.order_index,
        video_type: les.video_type,
        duration_seconds: les.duration_seconds,
        status: 'draft',
      });
    }
  }

  return courseId;
}

// ── Bulk Lesson Creation from Files ──────────────────────────────────────────
export interface BulkLessonFile {
  name: string;
  uri: string;
  mimeType: string;
  size: number;
}

export async function bulkCreateLessonsFromFiles(
  sectionId: string,
  courseId: string,
  files: BulkLessonFile[],
  startOrderIndex: number
): Promise<any[]> {
  const lessonPayloads = files.map((f, i) => ({
    section_id: sectionId,
    course_id: courseId,
    title: f.name.replace(/\.[^/.]+$/, ''), // strip extension
    order_index: startOrderIndex + i,
    status: 'draft',
    video_type: 'vdocipher' as const,
    // external_url removed — only direct MedAcademy uploads are supported
  }));
  const { data, error } = await supabase
    .from('lessons')
    .insert(lessonPayloads)
    .select();
  if (error) throw error;
  return data ?? [];
}

// ── Bulk Material Attachment ──────────────────────────────────────────────────
export async function bulkAttachMaterials(
  lessonId: string,
  courseId: string,
  uploadedBy: string,
  files: Array<{ file_name: string; file_url: string; storage_path: string; file_type: string; file_size: number }>,
  startOrderIndex: number
): Promise<any[]> {
  const payloads = files.map((f, i) => ({
    lesson_id: lessonId,
    course_id: courseId,
    uploaded_by: uploadedBy,
    ...f,
    download_enabled: true,
    preview_enabled: true,
    permission: 'allow' as DownloadPermission,
    order_index: startOrderIndex + i,
  }));
  const { data, error } = await supabase.from('lesson_materials').insert(payloads).select();
  if (error) throw error;
  return data ?? [];
}

// ══════════════════════════════════════════════════════════════════════════════
//  v49 — COURSE LIFECYCLE: Estimated Study Time + Archive
// ══════════════════════════════════════════════════════════════════════════════

// ── Estimated Study Time helpers ──────────────────────────────────────────────

/** Format minutes into a human-readable string: "5 min", "1 h", "1 h 30 min" */
export function formatStudyTime(minutes: number): string {
  if (!minutes || minutes <= 0) return '—';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}

/** Sum estimated_minutes from all lessons in a course/section */
export function calcCourseDuration(sections: any[]): number {
  return sections.reduce((total: number, s: any) => {
    const secMin = (s.lessons ?? []).reduce((t: number, l: any) => t + (l.estimated_minutes ?? 0), 0);
    return total + secMin;
  }, 0);
}

export function calcSectionDuration(lessons: any[]): number {
  return lessons.reduce((t: number, l: any) => t + (l.estimated_minutes ?? 0), 0);
}

// ── Estimated time from progress ──────────────────────────────────────────────
export function calcRemainingTime(sections: any[], completedLessonIds: Set<string>): number {
  return sections.reduce((total: number, s: any) =>
    total + (s.lessons ?? []).reduce((t: number, l: any) =>
      completedLessonIds.has(l.id) ? t : t + (l.estimated_minutes ?? 0), 0), 0);
}

export function calcCompletedTime(sections: any[], completedLessonIds: Set<string>): number {
  return sections.reduce((total: number, s: any) =>
    total + (s.lessons ?? []).reduce((t: number, l: any) =>
      completedLessonIds.has(l.id) ? t + (l.estimated_minutes ?? 0) : t, 0), 0);
}

// ── Update lesson estimated_minutes — REMOVED (auto-set from video_duration_seconds)

// ── Archive Course ─────────────────────────────────────────────────────────────
export async function archiveCourse(
  courseId: string,
  actorId: string,
  actorRole: string,
  reason?: string
) {
  const { error } = await supabase.rpc('archive_course', {
    p_course_id: courseId,
    p_actor_id: actorId,
    p_actor_role: actorRole,
    p_reason: reason ?? null,
  });
  if (error) throw error;
}

// ── Restore Course ─────────────────────────────────────────────────────────────
export async function restoreCourse(
  courseId: string,
  actorId: string,
  actorRole: string
) {
  const { error } = await supabase.rpc('restore_course', {
    p_course_id: courseId,
    p_actor_id: actorId,
    p_actor_role: actorRole,
  });
  if (error) throw error;
}

// ── Permanently Delete Course (Super Admin only) ───────────────────────────────
export async function permanentlyDeleteCourse(courseId: string, actorId: string) {
  const { error } = await supabase.rpc('permanently_delete_course', {
    p_course_id: courseId,
    p_actor_id: actorId,
  });
  if (error) throw error;
}

// ── Fetch Archived Courses ────────────────────────────────────────────────────
export interface ArchivedCourse {
  id: string;
  title: string;
  doctor_id: string;
  doctor_name: string;
  archived_at: string;
  archived_by: string;
  archived_by_name: string;
  archive_reason: string | null;
  students_count: number;
  lessons_count: number;
  status: string;
}

export async function getArchivedCourses(
  actorId: string,
  actorRole: string,
  doctorId?: string
): Promise<ArchivedCourse[]> {
  const { data, error } = await supabase.rpc('get_archived_courses', {
    p_actor_id: actorId,
    p_actor_role: actorRole,
    p_doctor_id: doctorId ?? null,
  });
  if (error) throw error;
  return (data ?? []) as ArchivedCourse[];
}

// ── Archive Analytics ─────────────────────────────────────────────────────────
export interface ArchiveAnalytics {
  total_archived: number;
  total_restored: number;
  total_deleted: number;
  recent_archives: Array<{
    course_title: string;
    action: string;
    actor_role: string;
    created_at: string;
  }> | null;
}

export async function getArchiveAnalytics(): Promise<ArchiveAnalytics> {
  const { data, error } = await supabase.rpc('get_archive_analytics');
  if (error) throw error;
  const row = data?.[0] ?? { total_archived: 0, total_restored: 0, total_deleted: 0, recent_archives: null };
  return row as ArchiveAnalytics;
}

// ── Course Lifecycle Logs (read) ───────────────────────────────────────────────
export interface CourseLifecycleLog {
  id: string;
  course_id: string | null;
  course_title: string;
  doctor_id: string | null;
  action: string;
  actor_id: string | null;
  actor_role: string | null;
  reason: string | null;
  students_count: number;
  lessons_count: number;
  videos_count: number;
  attachments_count: number;
  created_at: string;
}

export async function getCourseLifecycleLogs(limit = 100): Promise<CourseLifecycleLog[]> {
  const { data, error } = await supabase
    .from('course_lifecycle_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as CourseLifecycleLog[];
}

// ── Get courses with optional archived flag ────────────────────────────────────
export async function getCoursesWithArchived(options?: {
  doctorId?: string;
  status?: string;
  includeArchived?: boolean;
}) {
  let query = supabase
    .from('courses')
    .select('*, doctor:profiles!courses_doctor_id_fkey(id,full_name,avatar_url), category:categories(id,name)')
    .order('created_at', { ascending: false })
    .limit(200);

  if (options?.doctorId) query = query.eq('doctor_id', options.doctorId);
  if (options?.status) query = query.eq('status', options.status);

  // By default, exclude archived courses unless explicitly requested
  if (!options?.includeArchived) {
    query = query.is('archived_at', null);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Trash Bin — v74 ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export interface TrashItem {
  id: string;
  full_name: string;
  email: string;
  phone_e164: string | null;
  role: string;
  trashed_at: string;
  trash_expires_at: string;
  trash_reason: string | null;
  pre_trash_status: string;
  trashed_by_name: string | null;
  days_remaining: number;
}

export interface TrashListResult { items: TrashItem[]; total: number; }

export interface TrashStats {
  total_trashed: number;
  expiring_soon: number;
  expired: number;
  by_role: { student: number; doctor: number; admin: number; super_admin: number };
  recently_restored: Array<{ user_id: string; name: string; role: string; created_at: string }> | null;
}

export interface TrashConfig {
  id: string;
  retention_days: number;
  custom_days: number | null;
  updated_at: string;
}

export type BulkOperation =
  | 'trash' | 'restore' | 'suspend' | 'unsuspend'
  | 'reset_password' | 'reset_devices' | 'permanent_delete';

export interface BulkOpsResult {
  success: boolean;
  operation: BulkOperation;
  processed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ user_id: string; message: string }>;
}

export interface DeletePermissions {
  can_delete_students: boolean;
  can_delete_doctors: boolean;
  can_delete_admins: boolean;
  can_permanent_delete: boolean;
  can_restore: boolean;
  can_empty_trash: boolean;
}

export async function trashUser(targetUserId: string, reason?: string) {
  return invokeEdgeFunction<{ user_id: string; full_name: string; expires_at: string }>(
    'trash-user', { target_user_id: targetUserId, reason },
  );
}

/** Undo trash — same EF but action=restore, used within 10-second undo window. */
export async function undoTrash(targetUserId: string) {
  return invokeEdgeFunction<{ user_id: string }>('trash-user', { target_user_id: targetUserId, action: 'restore' });
}

/** Restore a user from the Trash Bin. */
export async function restoreUser(targetUserId: string) {
  return invokeEdgeFunction<{ user_id: string; full_name: string }>(
    'trash-user', { target_user_id: targetUserId, action: 'restore' },
  );
}

export async function bulkUserOps(
  operation: BulkOperation,
  userIds: string[],
  reason?: string,
): Promise<BulkOpsResult> {
  return invokeEdgeFunction<BulkOpsResult>('bulk-user-ops', { operation, user_ids: userIds, reason });
}

export async function getTrashList(opts?: { role?: string; limit?: number; offset?: number }): Promise<TrashListResult> {
  const { data, error } = await supabase.rpc('get_trash_list', {
    p_role:   opts?.role   ?? null,
    p_limit:  opts?.limit  ?? 50,
    p_offset: opts?.offset ?? 0,
  });
  if (error) throw error;
  return (data ?? { items: [], total: 0 }) as TrashListResult;
}

export async function getTrashStats(): Promise<TrashStats> {
  const { data, error } = await supabase.rpc('get_trash_stats');
  if (error) throw error;
  return data as TrashStats;
}

export async function getTrashConfig(): Promise<TrashConfig> {
  const { data, error } = await supabase
    .from('trash_config').select('*')
    .order('updated_at', { ascending: false }).limit(1).single();
  if (error) throw error;
  return data as TrashConfig;
}

export async function saveTrashConfig(retentionDays: number, customDays?: number): Promise<void> {
  const { data: existing } = await supabase.from('trash_config').select('id').limit(1).single();
  const payload = { retention_days: retentionDays, custom_days: customDays ?? null, updated_at: new Date().toISOString() };
  if (existing?.id) {
    const { error } = await supabase.from('trash_config').update(payload).eq('id', existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('trash_config').insert(payload);
    if (error) throw error;
  }
}

export async function runTrashCleanup() {
  return invokeEdgeFunction<{ deleted: number; failed: number }>('trash-cleanup', {});
}

export async function getDeletePermissions(adminId: string): Promise<DeletePermissions> {
  const { data, error } = await supabase.from('profiles').select('delete_permissions').eq('id', adminId).single();
  if (error) throw error;
  const defaults: DeletePermissions = {
    can_delete_students: true, can_delete_doctors: false, can_delete_admins: false,
    can_permanent_delete: false, can_restore: true, can_empty_trash: false,
  };
  return { ...defaults, ...(data?.delete_permissions ?? {}) } as DeletePermissions;
}

export async function saveDeletePermissions(adminId: string, perms: DeletePermissions): Promise<void> {
  const { error } = await supabase.from('profiles').update({ delete_permissions: perms }).eq('id', adminId);
  if (error) throw error;
}

// ── Upload session heartbeat ──────────────────────────────────────────────────
// Called every 15 s while an upload is active. Orphan-cleanup skips sessions
// whose last_heartbeat is within the last 60 s.
export async function pingUploadSessionHeartbeat(uploadId: string): Promise<void> {
  await supabase
    .from('upload_sessions')
    .update({ last_heartbeat: new Date().toISOString() })
    .eq('upload_id', uploadId);
}

// ── Upload lock recovery ──────────────────────────────────────────────────────
// Returns sessions left in uploading/processing/encoding with a stale heartbeat.
// Called on app launch to detect uploads interrupted by crash/reload/reboot.
export async function recoverStaleUploadSessions(staleThresholdSeconds = 60): Promise<Array<{
  session_id: string;
  upload_id: string;
  lesson_id: string | null;
  provider_video_id: string | null;
  status: string;
  last_heartbeat: string | null;
  created_at: string;
}>> {
  const { data, error } = await supabase.rpc('recover_stale_upload_sessions', {
    p_stale_threshold_seconds: staleThresholdSeconds,
  });
  if (error) {
    console.warn('[recoverStaleUploadSessions] RPC failed:', error.message);
    return [];
  }
  return data ?? [];
}

// ── Lesson video state ────────────────────────────────────────────────────────
// Returns the lesson's video state for the consistency audit.
export async function getLessonVideoState(lessonId: string): Promise<{
  lesson_id: string;
  video_id: string | null;
  video_status: string;
  video_upload_id: string | null;
  has_video: boolean;
  is_missing: boolean;
  thumbnail_url: string | null;
  duration_seconds: number | null;
} | null> {
  const { data, error } = await supabase.rpc('get_lesson_video_state', { p_lesson_id: lessonId });
  if (error) {
    console.warn('[getLessonVideoState] RPC failed:', error.message);
    return null;
  }
  return data ?? null;
}

// ── Mark lesson video missing ─────────────────────────────────────────────────
// Called by the consistency-audit when VdoCipher confirms the asset is gone.
export async function markLessonVideoMissing(lessonId: string): Promise<void> {
  await supabase.rpc('mark_lesson_video_missing', { p_lesson_id: lessonId });
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ENROLLMENT MANAGEMENT
// All calls go through the admin-enrollment Edge Function (service role).
// Role verification is enforced server-side — never trust client-side checks.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdminEnrollResult {
  success: boolean;
  already_enrolled: boolean;
  enrollment_id?: string;
  visibility_level?: string;
  message: string;
}

export type EnrollmentVisibility = 'all' | 'admin_only' | 'super_admin_only';

export const ENROLLMENT_VISIBILITY_OPTIONS: {
  value: EnrollmentVisibility;
  label: string;
  description: string;
}[] = [
  { value: 'all',             label: 'Visible to everyone',              description: 'Default' },
  { value: 'admin_only',      label: 'Hide from instructors',            description: 'Student is visible only to Admin and Super Admin.' },
  { value: 'super_admin_only',label: 'Hide from admins and instructors', description: 'Student is visible only to Super Admin.' },
];

export interface AdminCourse {
  id: string;
  title: string;
  status: string;
  doctor: { id: string; full_name: string } | null;
}

export interface AdminEnrollmentRow {
  id: string;
  student_id: string;
  course_id: string;
  enrolled_at: string;
  enrollment_method: string | null;
  status: string;
  enrolled_by: string | null;
  visibility_level?: EnrollmentVisibility;
  student: {
    id: string;
    full_name: string;
    email: string;
    profile_email: string | null;
    watermark_id: string | null;
    role: string;
  } | null;
}

export interface AdminUserSearchResult {
  id: string;
  full_name: string;
  email: string;
  profile_email: string | null;
  phone: string | null;
  role: string;
  status: string;
  watermark_id: string | null;
  avatar_url: string | null;
}

/** Enroll any user into any course (admin/super_admin only).
 *  visibilityLevel is accepted only when the caller is super_admin —
 *  the Edge Function silently forces 'all' for regular admins. */
export async function adminEnrollUser(
  studentId: string,
  courseId: string,
  visibilityLevel: EnrollmentVisibility = 'all',
): Promise<AdminEnrollResult> {
  const { data, error } = await supabase.functions.invoke('admin-enrollment', {
    body: {
      action: 'enroll',
      student_id: studentId,
      course_id: courseId,
      visibility_level: visibilityLevel,
    },
  });
  if (error) {
    const msg = await error?.context?.text?.().catch(() => error.message);
    throw new Error(msg ?? 'Enrollment failed');
  }
  return data as AdminEnrollResult;
}

/** Set enrollment visibility level (super_admin only). */
export async function adminSetEnrollmentVisibility(
  enrollmentId: string,
  visibilityLevel: EnrollmentVisibility,
): Promise<void> {
  const { data, error } = await supabase.functions.invoke('admin-enrollment', {
    body: { action: 'set_hidden', enrollment_id: enrollmentId, visibility_level: visibilityLevel },
  });
  if (error) {
    const msg = await error?.context?.text?.().catch(() => error.message);
    throw new Error(msg ?? 'Set visibility failed');
  }
  if (!(data as any)?.success) throw new Error('Set visibility failed');
}

/** Remove any enrollment (admin/super_admin only). */
export async function adminRemoveEnrollment(enrollmentId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('admin-enrollment', {
    body: { action: 'remove', enrollment_id: enrollmentId },
  });
  if (error) {
    const msg = await error?.context?.text?.().catch(() => error.message);
    throw new Error(msg ?? 'Remove failed');
  }
  if (!(data as any)?.success) throw new Error('Remove failed');
}


// ── Admin Doctor Earnings (RPC-backed, admin-only) ────────────────────────────

export interface DoctorEarningsCourse {
  course_id:         string;
  course_title:      string;
  current_price:     number;
  enrollment_count:  number;
  course_revenue:    number;
  avg_price_at_sale: number;
}

export interface AdminDoctorEarningsDashboard {
  custom_pricing_enabled: boolean;
  earnings_mode:          'credit' | 'course';
  credit_selling_price:   number;
  total_earnings:         number;
  monthly_earnings:       number;
  today_earnings:         number;
  total_enrollments:      number;
  paid_courses_count:     number;
  avg_course_price:       number;
  per_course:             DoctorEarningsCourse[];
}

export interface DoctorPricingHistoryRow {
  id:           string;
  field_name:   string;
  old_value:    string | null;
  new_value:    string | null;
  changed_by:   string;
  changer_name: string | null;
  created_at:   string;
}

/** Get full earnings dashboard for a doctor (admin view via RPC). */
export async function getAdminDoctorEarningsDashboard(
  doctorId: string,
): Promise<AdminDoctorEarningsDashboard> {
  const { data, error } = await supabase.rpc('get_doctor_earnings_dashboard', {
    p_doctor_id: doctorId,
  });
  if (error) throw error;
  return data as AdminDoctorEarningsDashboard;
}

/** Update custom pricing toggle + earnings mode for a doctor (admin only). */
export async function setDoctorEarningsSettings(
  doctorId: string,
  customPricingEnabled: boolean,
  earningsMode: 'credit' | 'course',
): Promise<void> {
  const { error } = await supabase.functions.invoke('admin-doctor-earnings', {
    body: { action: 'update_settings', doctor_id: doctorId, custom_pricing_enabled: customPricingEnabled, earnings_mode: earningsMode },
  });
  if (error) throw error;
}

/** Get pricing change history for a doctor (admin only). */
export async function getDoctorPricingHistory(
  doctorId: string,
  limit = 50,
): Promise<DoctorPricingHistoryRow[]> {
  const { data, error } = await supabase
    .from('doctor_pricing_history')
    .select('id, field_name, old_value, new_value, changed_by, changer:profiles!doctor_pricing_history_changed_by_fkey(full_name), created_at')
    .eq('doctor_id', doctorId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as any[]).map(r => ({
    id:           r.id,
    field_name:   r.field_name,
    old_value:    r.old_value,
    new_value:    r.new_value,
    changed_by:   r.changed_by,
    changer_name: r.changer?.full_name ?? null,
    created_at:   r.created_at,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────

/** Search users by name, email, watermark ID, or user ID (admin/super_admin only). */
export async function searchUsersForEnrollment(
  query: string,
): Promise<AdminUserSearchResult[]> {
  const { data, error } = await supabase.functions.invoke('admin-enrollment', {
    body: { action: 'search', query },
  });
  if (error) {
    const msg = await error?.context?.text?.().catch(() => error.message);
    throw new Error(msg ?? 'Search failed');
  }
  return Array.isArray((data as any)?.users) ? (data as any).users : [];
}

/** Get all courses for the admin enrollment picker. */
export async function getAdminAllCourses(): Promise<AdminCourse[]> {
  const { data, error } = await supabase.functions.invoke('admin-enrollment', {
    body: { action: 'courses' },
  });
  if (error) {
    const msg = await error?.context?.text?.().catch(() => error.message);
    throw new Error(msg ?? 'Failed to load courses');
  }
  return Array.isArray((data as any)?.courses) ? (data as any).courses : [];
}

/** Get all enrollments for a specific course (admin/super_admin only). */
export async function getAdminCourseEnrollments(
  courseId: string,
): Promise<AdminEnrollmentRow[]> {
  const { data, error } = await supabase.functions.invoke('admin-enrollment', {
    body: { action: 'enrollments', course_id: courseId },
  });
  if (error) {
    const msg = await error?.context?.text?.().catch(() => error.message);
    throw new Error(msg ?? 'Failed to load enrollments');
  }
  return Array.isArray((data as any)?.enrollments) ? (data as any).enrollments : [];
}

/**
 * Super-admin-only: update a user's email in both Supabase Auth and the profiles table.
 * Routed through the admin-update-email Edge Function — never uses the service role on the client.
 */
export async function updateUserEmail(targetUserId: string, newEmail: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('admin-update-email', {
    body: { target_user_id: targetUserId, new_email: newEmail },
  });
  if (error) {
    const msg = await error?.context?.text?.().catch(() => error.message);
    throw new Error(msg ?? 'Failed to update email.');
  }
  if ((data as any)?.error) {
    throw new Error((data as any).error);
  }
}
