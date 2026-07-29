
-- Fix run_db_audit: scope pg_stat_user_tables to schemaname='public'
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

  -- Scope strictly to public schema to avoid cross-schema name collisions
  SELECT jsonb_agg(t ORDER BY t.size_bytes DESC) INTO v_largest_tables
  FROM (
    SELECT
      s.relname AS table_name,
      pg_total_relation_size('public.' || quote_ident(s.relname)) AS size_bytes,
      pg_size_pretty(pg_total_relation_size('public.' || quote_ident(s.relname))) AS size_pretty,
      s.n_live_tup AS row_count
    FROM pg_stat_user_tables s
    WHERE s.schemaname = 'public'
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

-- Fix get_system_stats: activation_codes uses status='active' not is_active bool
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
  -- activation_codes uses status enum, not a bool column
  SELECT COUNT(*) INTO v_active_codes
    FROM public.activation_codes WHERE status = 'active' AND used_at IS NULL;
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
