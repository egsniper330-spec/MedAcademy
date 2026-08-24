-- =============================================================================
-- MedAcademy — Canonical Database Schema (PUBLIC)
-- Generated: 2026-07-13
-- Supabase Project: xdvjwfuqipatkpimejcb
-- Total Tables: 60 public tables
-- =============================================================================
-- Run enums/enums.sql FIRST before this file
-- =============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- Sequences (auto-created by serial columns; listed for completeness)
-- refresh_tokens_id_seq  (auth schema)
-- wm_id_seq              (internal)

-- =============================================================================
-- CORE USER / AUTH TABLES
-- =============================================================================

CREATE TABLE public.profiles (
  id               uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role             public.user_role NOT NULL DEFAULT 'student',
  status           public.user_status NOT NULL DEFAULT 'active',
  full_name        text,
  phone            text,
  email            text,
  avatar_url       text,
  university_id    uuid REFERENCES public.universities(id) ON DELETE SET NULL,
  faculty_id       uuid REFERENCES public.faculties(id) ON DELETE SET NULL,
  academic_level_id uuid REFERENCES public.academic_levels(id) ON DELETE SET NULL,
  national_id      text,
  is_first_login   boolean NOT NULL DEFAULT true,
  unlimited_devices boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.devices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id        text NOT NULL,
  device_name      text,
  platform         text,
  app_version      text,
  status           public.device_status NOT NULL DEFAULT 'active',
  last_seen_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, device_id)
);

-- =============================================================================
-- ACADEMIC STRUCTURE
-- =============================================================================

CREATE TABLE public.universities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.faculties (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id    uuid NOT NULL REFERENCES public.universities(id) ON DELETE CASCADE,
  name             text NOT NULL,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.academic_levels (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  faculty_id       uuid NOT NULL REFERENCES public.faculties(id) ON DELETE CASCADE,
  name             text NOT NULL,
  display_order    int NOT NULL DEFAULT 0,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.categories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- COURSE CONTENT
-- =============================================================================

CREATE TABLE public.courses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title            text NOT NULL,
  description      text,
  category_id      uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  thumbnail_url    text,
  status           public.course_status NOT NULL DEFAULT 'draft',
  difficulty       public.difficulty_level NOT NULL DEFAULT 'all_levels',
  credit_price     int NOT NULL DEFAULT 0,
  custom_pricing   boolean NOT NULL DEFAULT false,
  university_id    uuid REFERENCES public.universities(id) ON DELETE SET NULL,
  faculty_id       uuid REFERENCES public.faculties(id) ON DELETE SET NULL,
  academic_level_id uuid REFERENCES public.academic_levels(id) ON DELETE SET NULL,
  is_deleted       boolean NOT NULL DEFAULT false,
  deleted_at       timestamptz,
  deleted_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  archived_at      timestamptz,
  sort_order       int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.sections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id        uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  title            text NOT NULL,
  sort_order       int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.lessons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id       uuid NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
  course_id        uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  title            text NOT NULL,
  description      text,
  video_type       public.video_type DEFAULT 'coming_soon',
  video_id         text,
  duration_seconds int,
  sort_order       int NOT NULL DEFAULT 0,
  status           public.lesson_status NOT NULL DEFAULT 'draft',
  is_preview       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.lesson_materials (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id        uuid NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  name             text NOT NULL,
  file_url         text NOT NULL,
  file_size        bigint,
  mime_type        text,
  download_permission public.download_permission NOT NULL DEFAULT 'allow',
  sort_order       int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.lesson_progress (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lesson_id        uuid NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  completed        boolean NOT NULL DEFAULT false,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, lesson_id)
);

-- =============================================================================
-- ENROLLMENTS & CREDITS
-- =============================================================================

CREATE TABLE public.enrollments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id        uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  enrolled_at      timestamptz NOT NULL DEFAULT now(),
  assigned_price   int,
  visibility       public.enrollment_visibility NOT NULL DEFAULT 'all',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, course_id)
);

CREATE TABLE public.credits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  balance          int NOT NULL DEFAULT 0 CHECK (balance >= 0),
  total_allocated  int NOT NULL DEFAULT 0,
  total_consumed   int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.credit_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount           int NOT NULL,
  transaction_type public.credit_transaction_type NOT NULL,
  note             text,
  course_id        uuid REFERENCES public.courses(id) ON DELETE SET NULL,
  performed_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- ACTIVATION CODES
-- =============================================================================

CREATE TABLE public.code_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  credit_amount    int NOT NULL DEFAULT 0,
  code_count       int NOT NULL DEFAULT 0,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.activation_codes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,
  batch_id         uuid REFERENCES public.code_batches(id) ON DELETE SET NULL,
  credit_amount    int NOT NULL DEFAULT 0,
  status           public.activation_code_status NOT NULL DEFAULT 'active',
  used_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  used_at          timestamptz,
  expires_at       timestamptz,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- NOTIFICATIONS
-- =============================================================================

CREATE TABLE public.notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  title            text NOT NULL,
  body             text NOT NULL,
  type             public.notification_type NOT NULL DEFAULT 'info',
  data             jsonb DEFAULT '{}',
  is_read          boolean NOT NULL DEFAULT false,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- SECURITY
-- =============================================================================

CREATE TABLE public.security_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  device_id        uuid REFERENCES public.devices(id) ON DELETE SET NULL,
  event_type       public.security_event_type NOT NULL,
  platform         text,
  app_version      text,
  metadata         jsonb DEFAULT '{}',
  ip_address       inet,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.security_policies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detection_type   public.security_detection_type NOT NULL UNIQUE,
  action           public.security_policy_action NOT NULL DEFAULT 'block_login',
  enabled          boolean NOT NULL DEFAULT true,
  updated_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.security_vpn_whitelist (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  note             text,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.content_protection_policies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  violation_type   public.violation_type NOT NULL UNIQUE,
  strike_threshold int NOT NULL DEFAULT 3,
  action           public.content_protection_action NOT NULL DEFAULT 'warn_only',
  cooldown_hours   int NOT NULL DEFAULT 24,
  enabled          boolean NOT NULL DEFAULT true,
  updated_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.content_protection_violations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id        uuid REFERENCES public.devices(id) ON DELETE SET NULL,
  violation_type   public.violation_type NOT NULL,
  strike_count     int NOT NULL DEFAULT 1,
  last_occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, violation_type)
);

CREATE TABLE public.fraud_flags (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  flag_type        text NOT NULL,
  details          jsonb DEFAULT '{}',
  resolved         boolean NOT NULL DEFAULT false,
  resolved_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- VIDEO / STORAGE
-- =============================================================================

CREATE TABLE public.video_uploads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id        uuid REFERENCES public.lessons(id) ON DELETE SET NULL,
  doctor_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  video_id         text,
  original_name    text,
  file_size        bigint,
  status           text NOT NULL DEFAULT 'pending',
  provider         text NOT NULL DEFAULT 'vdocipher',
  upload_id        text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.upload_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lesson_id        uuid REFERENCES public.lessons(id) ON DELETE SET NULL,
  provider         text NOT NULL DEFAULT 'vdocipher',
  total_size       bigint,
  uploaded_size    bigint NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'pending',
  metadata         jsonb DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.upload_audit_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action           text NOT NULL,
  file_name        text,
  file_size        bigint,
  bucket_name      text,
  storage_path     text,
  mime_type        text,
  status           text,
  error_message    text,
  metadata         jsonb DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.video_assets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id         text NOT NULL UNIQUE,
  lesson_id        uuid REFERENCES public.lessons(id) ON DELETE SET NULL,
  provider         text NOT NULL DEFAULT 'vdocipher',
  title            text,
  duration         int,
  status           text,
  metadata         jsonb DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.video_providers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL UNIQUE,
  is_active        boolean NOT NULL DEFAULT true,
  config           jsonb DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.video_provider_config (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         text NOT NULL UNIQUE,
  config           jsonb DEFAULT '{}',
  updated_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.video_daily_health_reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date      date NOT NULL,
  provider         text NOT NULL,
  total_videos     int NOT NULL DEFAULT 0,
  ok_count         int NOT NULL DEFAULT 0,
  error_count      int NOT NULL DEFAULT 0,
  missing_count    int NOT NULL DEFAULT 0,
  details          jsonb DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE(report_date, provider)
);

CREATE TABLE public.video_health_alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id        uuid REFERENCES public.lessons(id) ON DELETE SET NULL,
  video_id         text,
  alert_type       text NOT NULL,
  message          text,
  resolved         boolean NOT NULL DEFAULT false,
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- AUDIT / LOGS
-- =============================================================================

CREATE TABLE public.audit_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  performed_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  target_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action           public.audit_action NOT NULL,
  table_name       text,
  record_id        text,
  old_values       jsonb,
  new_values       jsonb,
  ip_address       inet,
  user_agent       text,
  metadata         jsonb DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.crash_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  error_message    text,
  stack_trace      text,
  platform         text,
  app_version      text,
  device_info      jsonb DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.analytics_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_name       text NOT NULL,
  properties       jsonb DEFAULT '{}',
  platform         text,
  app_version      text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.course_lifecycle_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id        uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  action           text NOT NULL,
  performed_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata         jsonb DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- DOCTOR EARNINGS
-- =============================================================================

CREATE TABLE public.doctor_earnings_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id        uuid REFERENCES public.courses(id) ON DELETE SET NULL,
  student_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  credit_amount    int NOT NULL DEFAULT 0,
  event_type       text NOT NULL,
  metadata         jsonb DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.doctor_earnings_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount           int NOT NULL,
  transaction_type text NOT NULL,
  note             text,
  performed_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.doctor_pricing_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  old_price        int,
  new_price        int NOT NULL,
  changed_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.doctor_payout_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount           int NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  note             text,
  processed_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  processed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.platform_earnings_resets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reset_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reset_at         timestamptz NOT NULL DEFAULT now(),
  previous_total   int,
  note             text
);

-- =============================================================================
-- CONFIGURATION / SETTINGS
-- =============================================================================

CREATE TABLE public.system_config (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key              text NOT NULL UNIQUE,
  value            jsonb NOT NULL,
  updated_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.feature_flags (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key              text NOT NULL UNIQUE,
  label            text,
  description      text,
  enabled          boolean NOT NULL DEFAULT false,
  updated_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.support_settings (
  key              text PRIMARY KEY,
  value            text NOT NULL DEFAULT '',
  label            text,
  enabled          boolean NOT NULL DEFAULT false,
  updated_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.maintenance_whitelist (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  note             text,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.trash_config (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retention_days   int NOT NULL DEFAULT 30,
  auto_purge       boolean NOT NULL DEFAULT true,
  updated_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- APP / BRANDING / CONTENT PAGES
-- =============================================================================

CREATE TABLE public.app_branding (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key              text NOT NULL UNIQUE,
  value            jsonb NOT NULL,
  updated_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.app_pages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE,
  title            text NOT NULL,
  content          text,
  is_published     boolean NOT NULL DEFAULT false,
  updated_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.course_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  description      text,
  template_data    jsonb DEFAULT '{}',
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- CREDIT ANALYTICS
-- =============================================================================

CREATE TABLE public.credit_daily_stats (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stat_date        date NOT NULL,
  total_allocated  int NOT NULL DEFAULT 0,
  total_consumed   int NOT NULL DEFAULT 0,
  total_balance    int NOT NULL DEFAULT 0,
  active_users     int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE(stat_date)
);

-- =============================================================================
-- ROW LEVEL SECURITY — Enable on all tables
-- =============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.universities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.faculties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.academic_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lesson_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lesson_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.code_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activation_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_vpn_whitelist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_protection_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_protection_violations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fraud_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upload_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_provider_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_daily_health_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_health_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crash_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_lifecycle_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctor_earnings_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctor_earnings_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctor_pricing_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctor_payout_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_earnings_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_whitelist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trash_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_daily_stats ENABLE ROW LEVEL SECURITY;

-- See database/policies/ for full RLS policy definitions
-- See database/functions/ for all SECURITY DEFINER helper functions
-- See database/triggers/ for all triggers
