
-- ============================================================
-- v68: Production Hardening — Constraints, Indexes, Columns
-- ============================================================

-- ------------------------------------------------------------
-- 1. UNIQUE CONSTRAINTS
-- ------------------------------------------------------------

-- 1a. enrollments(student_id, course_id) WHERE status='active'
--     Drop full unique if present, replace with partial unique index
ALTER TABLE public.enrollments DROP CONSTRAINT IF EXISTS enrollments_student_id_course_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS enrollments_active_unique
  ON public.enrollments (student_id, course_id)
  WHERE status = 'active';

-- 1b. devices(installation_id) — partial (only when set)
CREATE UNIQUE INDEX IF NOT EXISTS devices_installation_id_unique
  ON public.devices (installation_id)
  WHERE installation_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2. CHECK CONSTRAINTS
-- ------------------------------------------------------------

-- 2a. credits: non-negative balance fields
ALTER TABLE public.credits
  ADD CONSTRAINT credits_remaining_non_negative CHECK (remaining >= 0),
  ADD CONSTRAINT credits_consumed_non_negative  CHECK (consumed  >= 0);

-- 2b. sections & lessons: non-negative ordering
ALTER TABLE public.sections
  ADD CONSTRAINT sections_order_index_non_negative CHECK (order_index >= 0);

ALTER TABLE public.lessons
  ADD CONSTRAINT lessons_order_index_non_negative CHECK (order_index >= 0);

-- 2c. enrollments: progress fields 0-100
ALTER TABLE public.enrollments
  ADD CONSTRAINT enrollments_progress_non_negative
    CHECK (progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 100));

-- 2d. lesson_progress: watch position non-negative
ALTER TABLE public.lesson_progress
  ADD CONSTRAINT lesson_progress_watch_position_non_negative
    CHECK (watch_position_seconds IS NULL OR watch_position_seconds >= 0);

-- ------------------------------------------------------------
-- 3. CREDIT TRANSACTIONS — add transaction_id + admin_id
-- ------------------------------------------------------------

-- 3a. Add dedicated transaction_id column (maps to business event UUID)
ALTER TABLE public.credit_transactions
  ADD COLUMN IF NOT EXISTS transaction_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS admin_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 3b. Unique constraint on transaction_id
ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_transaction_id_key UNIQUE (transaction_id);

-- 3c. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_credit_transactions_transaction_id
  ON public.credit_transactions (transaction_id);

CREATE INDEX IF NOT EXISTS idx_credit_transactions_doctor_created
  ON public.credit_transactions (doctor_id, created_at DESC);

-- ------------------------------------------------------------
-- 4. AUDIT LOGS — add old_values, new_values, transaction_id
-- ------------------------------------------------------------

ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS old_values    jsonb,
  ADD COLUMN IF NOT EXISTS new_values    jsonb,
  ADD COLUMN IF NOT EXISTS transaction_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_transaction_id_unique
  ON public.audit_logs (transaction_id)
  WHERE transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_transaction_id
  ON public.audit_logs (transaction_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created
  ON public.audit_logs (actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_resource
  ON public.audit_logs (resource_type, resource_id);

-- ------------------------------------------------------------
-- 5. PERFORMANCE INDEXES (frequently queried paths)
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_enrollments_student_status
  ON public.enrollments (student_id, status);

CREATE INDEX IF NOT EXISTS idx_enrollments_course_status
  ON public.enrollments (course_id, status);

CREATE INDEX IF NOT EXISTS idx_devices_user_status
  ON public.devices (user_id, status);

CREATE INDEX IF NOT EXISTS idx_devices_installation_id
  ON public.devices (installation_id);

CREATE INDEX IF NOT EXISTS idx_security_events_user_created
  ON public.security_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_content_protection_violations_user_created
  ON public.content_protection_violations (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_courses_doctor_status
  ON public.courses (doctor_id, status);

CREATE INDEX IF NOT EXISTS idx_lessons_section_order
  ON public.lessons (section_id, order_index);

-- ------------------------------------------------------------
-- 6. DB AUDIT HELPER VIEWS
-- ------------------------------------------------------------

-- 6a. Duplicate active enrollments detector
CREATE OR REPLACE VIEW public.v_duplicate_active_enrollments AS
SELECT student_id, course_id, COUNT(*) AS cnt,
       array_agg(id ORDER BY enrolled_at) AS enrollment_ids
FROM public.enrollments
WHERE status = 'active'
GROUP BY student_id, course_id
HAVING COUNT(*) > 1;

-- 6b. Duplicate devices by installation_id
CREATE OR REPLACE VIEW public.v_duplicate_devices AS
SELECT installation_id, COUNT(*) AS cnt,
       array_agg(id ORDER BY registered_at) AS device_ids
FROM public.devices
WHERE installation_id IS NOT NULL
GROUP BY installation_id
HAVING COUNT(*) > 1;

-- 6c. Negative credit balances
CREATE OR REPLACE VIEW public.v_negative_credit_balances AS
SELECT id, doctor_id, remaining, consumed
FROM public.credits
WHERE remaining < 0 OR consumed < 0;

-- 6d. Orphan enrollments (no matching course or student profile)
CREATE OR REPLACE VIEW public.v_orphan_enrollments AS
SELECT e.id, e.student_id, e.course_id
FROM public.enrollments e
WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = e.student_id)
   OR NOT EXISTS (SELECT 1 FROM public.courses c WHERE c.id = e.course_id);

-- 6e. Orphan lessons (no matching course)
CREATE OR REPLACE VIEW public.v_orphan_lessons AS
SELECT l.id, l.course_id, l.section_id
FROM public.lessons l
WHERE NOT EXISTS (SELECT 1 FROM public.courses c WHERE c.id = l.course_id);

-- 6f. Duplicate activation codes (by code value)
CREATE OR REPLACE VIEW public.v_duplicate_activation_codes AS
SELECT code, COUNT(*) AS cnt,
       array_agg(id ORDER BY created_at) AS code_ids
FROM public.activation_codes
GROUP BY code
HAVING COUNT(*) > 1;

-- 6g. Duplicate credit transactions (by transaction_id)
CREATE OR REPLACE VIEW public.v_duplicate_credit_transactions AS
SELECT transaction_id, COUNT(*) AS cnt,
       array_agg(id ORDER BY created_at) AS tx_ids
FROM public.credit_transactions
GROUP BY transaction_id
HAVING COUNT(*) > 1;

-- 6h. Broken FK references summary
CREATE OR REPLACE VIEW public.v_broken_fk_summary AS
SELECT 'credit_transactions.course_id' AS fk_path, COUNT(*) AS broken_count
FROM public.credit_transactions ct
WHERE ct.course_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.courses c WHERE c.id = ct.course_id)
UNION ALL
SELECT 'credit_transactions.student_id', COUNT(*)
FROM public.credit_transactions ct
WHERE ct.student_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = ct.student_id)
UNION ALL
SELECT 'video_uploads_without_lesson', COUNT(*)
FROM public.video_uploads vu
WHERE NOT EXISTS (SELECT 1 FROM public.lessons l WHERE l.video_upload_id = vu.id)
  AND vu.status = 'completed';

-- ------------------------------------------------------------
-- 7. COMPREHENSIVE DB AUDIT RPC
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.run_db_audit()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_duplicate_enrollments   integer;
  v_duplicate_devices       integer;
  v_negative_balances       integer;
  v_orphan_enrollments      integer;
  v_orphan_lessons          integer;
  v_duplicate_codes         integer;
  v_duplicate_transactions  integer;
  v_broken_fks              integer;
  v_total_tables            integer;
  v_total_indexes           integer;
  v_db_size_bytes           bigint;
  v_largest_tables          jsonb;
BEGIN
  SELECT COUNT(*) INTO v_duplicate_enrollments FROM public.v_duplicate_active_enrollments;
  SELECT COUNT(*) INTO v_duplicate_devices       FROM public.v_duplicate_devices;
  SELECT COUNT(*) INTO v_negative_balances       FROM public.v_negative_credit_balances;
  SELECT COUNT(*) INTO v_orphan_enrollments      FROM public.v_orphan_enrollments;
  SELECT COUNT(*) INTO v_orphan_lessons          FROM public.v_orphan_lessons;
  SELECT COUNT(*) INTO v_duplicate_codes         FROM public.v_duplicate_activation_codes;
  SELECT COUNT(*) INTO v_duplicate_transactions  FROM public.v_duplicate_credit_transactions;
  SELECT COALESCE(SUM(broken_count),0) INTO v_broken_fks FROM public.v_broken_fk_summary;

  SELECT COUNT(*) INTO v_total_tables
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

  SELECT COUNT(*) INTO v_total_indexes
  FROM pg_indexes WHERE schemaname = 'public';

  SELECT pg_database_size(current_database()) INTO v_db_size_bytes;

  SELECT jsonb_agg(t ORDER BY t.size_bytes DESC) INTO v_largest_tables
  FROM (
    SELECT
      relname AS table_name,
      pg_total_relation_size(quote_ident(relname)) AS size_bytes,
      pg_size_pretty(pg_total_relation_size(quote_ident(relname))) AS size_pretty,
      n_live_tup AS row_count
    FROM pg_stat_user_tables
    ORDER BY size_bytes DESC
    LIMIT 10
  ) t;

  RETURN jsonb_build_object(
    'checked_at',              now(),
    'duplicate_enrollments',   v_duplicate_enrollments,
    'duplicate_devices',       v_duplicate_devices,
    'negative_balances',       v_negative_balances,
    'orphan_enrollments',      v_orphan_enrollments,
    'orphan_lessons',          v_orphan_lessons,
    'duplicate_codes',         v_duplicate_codes,
    'duplicate_transactions',  v_duplicate_transactions,
    'broken_fks',              v_broken_fks,
    'total_issues',            (v_duplicate_enrollments + v_duplicate_devices + v_negative_balances +
                                v_orphan_enrollments + v_orphan_lessons + v_duplicate_codes +
                                v_duplicate_transactions + v_broken_fks),
    'database',                jsonb_build_object(
      'total_tables',   v_total_tables,
      'total_indexes',  v_total_indexes,
      'size_bytes',     v_db_size_bytes,
      'size_pretty',    pg_size_pretty(v_db_size_bytes),
      'largest_tables', COALESCE(v_largest_tables, '[]'::jsonb)
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.run_db_audit() TO authenticated;

-- ------------------------------------------------------------
-- 8. SYSTEM STATS RPC
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_system_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_users          integer;
  v_total_courses        integer;
  v_total_enrollments    integer;
  v_total_credits_used   integer;
  v_total_devices        integer;
  v_blocked_devices      integer;
  v_total_audit_logs     integer;
  v_security_events_24h  integer;
  v_violations_24h       integer;
  v_suspended_accounts   integer;
  v_active_codes         integer;
  v_total_videos         integer;
  v_processing_videos    integer;
  v_failed_videos        integer;
BEGIN
  SELECT COUNT(*) INTO v_total_users FROM public.profiles;
  SELECT COUNT(*) INTO v_total_courses FROM public.courses WHERE status != 'archived';
  SELECT COUNT(*) INTO v_total_enrollments FROM public.enrollments WHERE status = 'active';
  SELECT COALESCE(SUM(consumed),0) INTO v_total_credits_used FROM public.credits;
  SELECT COUNT(*) INTO v_total_devices FROM public.devices;
  SELECT COUNT(*) INTO v_blocked_devices FROM public.devices WHERE status = 'blocked';
  SELECT COUNT(*) INTO v_total_audit_logs FROM public.audit_logs;
  SELECT COUNT(*) INTO v_security_events_24h
    FROM public.security_events WHERE created_at > now() - interval '24 hours';
  SELECT COUNT(*) INTO v_violations_24h
    FROM public.content_protection_violations WHERE created_at > now() - interval '24 hours';
  SELECT COUNT(*) INTO v_suspended_accounts
    FROM public.profiles WHERE status = 'suspended';
  SELECT COUNT(*) INTO v_active_codes
    FROM public.activation_codes WHERE is_active = true AND used_at IS NULL;
  SELECT COUNT(*) INTO v_total_videos FROM public.video_uploads;
  SELECT COUNT(*) INTO v_processing_videos FROM public.video_uploads WHERE status = 'processing';
  SELECT COUNT(*) INTO v_failed_videos FROM public.video_uploads WHERE status = 'failed';

  RETURN jsonb_build_object(
    'collected_at',         now(),
    'users',                v_total_users,
    'courses',              v_total_courses,
    'active_enrollments',   v_total_enrollments,
    'credits_used',         v_total_credits_used,
    'total_devices',        v_total_devices,
    'blocked_devices',      v_blocked_devices,
    'total_audit_logs',     v_total_audit_logs,
    'security_events_24h',  v_security_events_24h,
    'violations_24h',       v_violations_24h,
    'suspended_accounts',   v_suspended_accounts,
    'active_codes',         v_active_codes,
    'videos',               jsonb_build_object(
      'total',      v_total_videos,
      'processing', v_processing_videos,
      'failed',     v_failed_videos
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_system_stats() TO authenticated;
