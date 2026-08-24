-- =============================================================================
-- MedAcademy — Key Database Indexes
-- Generated: 2026-07-13
-- Note: Primary key indexes (PK) are auto-created. Listed here are explicit
--       performance and uniqueness indexes.
-- =============================================================================

-- profiles
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_status ON public.profiles(status);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_phone ON public.profiles(phone);
CREATE INDEX IF NOT EXISTS idx_profiles_university_id ON public.profiles(university_id);
CREATE INDEX IF NOT EXISTS idx_profiles_faculty_id ON public.profiles(faculty_id);

-- devices
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_user_device ON public.devices(user_id, device_id);
CREATE INDEX IF NOT EXISTS idx_devices_user_id ON public.devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_status ON public.devices(status);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON public.devices(last_seen_at DESC);

-- courses
CREATE INDEX IF NOT EXISTS idx_courses_doctor_id ON public.courses(doctor_id);
CREATE INDEX IF NOT EXISTS idx_courses_status ON public.courses(status);
CREATE INDEX IF NOT EXISTS idx_courses_category_id ON public.courses(category_id);
CREATE INDEX IF NOT EXISTS idx_courses_is_deleted ON public.courses(is_deleted);
CREATE INDEX IF NOT EXISTS idx_courses_university_id ON public.courses(university_id);
CREATE INDEX IF NOT EXISTS idx_courses_faculty_id ON public.courses(faculty_id);
CREATE INDEX IF NOT EXISTS idx_courses_created_at ON public.courses(created_at DESC);

-- sections
CREATE INDEX IF NOT EXISTS idx_sections_course_id ON public.sections(course_id);
CREATE INDEX IF NOT EXISTS idx_sections_sort_order ON public.sections(course_id, sort_order);

-- lessons
CREATE INDEX IF NOT EXISTS idx_lessons_section_id ON public.lessons(section_id);
CREATE INDEX IF NOT EXISTS idx_lessons_course_id ON public.lessons(course_id);
CREATE INDEX IF NOT EXISTS idx_lessons_status ON public.lessons(status);
CREATE INDEX IF NOT EXISTS idx_lessons_sort_order ON public.lessons(section_id, sort_order);

-- lesson_progress
CREATE UNIQUE INDEX IF NOT EXISTS idx_lesson_progress_user_lesson ON public.lesson_progress(user_id, lesson_id);
CREATE INDEX IF NOT EXISTS idx_lesson_progress_user_id ON public.lesson_progress(user_id);

-- enrollments
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_user_course ON public.enrollments(user_id, course_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_user_id ON public.enrollments(user_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_course_id ON public.enrollments(course_id);

-- credits
CREATE UNIQUE INDEX IF NOT EXISTS idx_credits_user_id ON public.credits(user_id);

-- credit_transactions
CREATE INDEX IF NOT EXISTS idx_credit_txn_user_id ON public.credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_txn_course_id ON public.credit_transactions(course_id);
CREATE INDEX IF NOT EXISTS idx_credit_txn_type ON public.credit_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_credit_txn_created_at ON public.credit_transactions(created_at DESC);

-- activation_codes
CREATE UNIQUE INDEX IF NOT EXISTS idx_activation_codes_code ON public.activation_codes(code);
CREATE INDEX IF NOT EXISTS idx_activation_codes_status ON public.activation_codes(status);
CREATE INDEX IF NOT EXISTS idx_activation_codes_batch_id ON public.activation_codes(batch_id);
CREATE INDEX IF NOT EXISTS idx_activation_codes_used_by ON public.activation_codes(used_by);

-- notifications
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON public.notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON public.notifications(created_at DESC);

-- security_events
CREATE INDEX IF NOT EXISTS idx_security_events_user_id ON public.security_events(user_id);
CREATE INDEX IF NOT EXISTS idx_security_events_device_id ON public.security_events(device_id);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON public.security_events(event_type);
CREATE INDEX IF NOT EXISTS idx_security_events_created_at ON public.security_events(created_at DESC);

-- content_protection_violations
CREATE UNIQUE INDEX IF NOT EXISTS idx_cpv_user_type ON public.content_protection_violations(user_id, violation_type);
CREATE INDEX IF NOT EXISTS idx_cpv_user_id ON public.content_protection_violations(user_id);

-- video_uploads
CREATE INDEX IF NOT EXISTS idx_video_uploads_doctor_id ON public.video_uploads(doctor_id);
CREATE INDEX IF NOT EXISTS idx_video_uploads_lesson_id ON public.video_uploads(lesson_id);
CREATE INDEX IF NOT EXISTS idx_video_uploads_status ON public.video_uploads(status);
CREATE INDEX IF NOT EXISTS idx_video_uploads_video_id ON public.video_uploads(video_id);

-- upload_sessions
CREATE INDEX IF NOT EXISTS idx_upload_sessions_user_id ON public.upload_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_status ON public.upload_sessions(status);

-- upload_audit_logs
CREATE INDEX IF NOT EXISTS idx_upload_audit_user_id ON public.upload_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_upload_audit_created_at ON public.upload_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upload_audit_action ON public.upload_audit_logs(action);

-- audit_logs
CREATE INDEX IF NOT EXISTS idx_audit_logs_performed_by ON public.audit_logs(performed_by);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target_user ON public.audit_logs(target_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_table_name ON public.audit_logs(table_name);

-- doctor_earnings_events
CREATE INDEX IF NOT EXISTS idx_dee_doctor_id ON public.doctor_earnings_events(doctor_id);
CREATE INDEX IF NOT EXISTS idx_dee_course_id ON public.doctor_earnings_events(course_id);
CREATE INDEX IF NOT EXISTS idx_dee_created_at ON public.doctor_earnings_events(created_at DESC);

-- video_assets
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_assets_video_id ON public.video_assets(video_id);
CREATE INDEX IF NOT EXISTS idx_video_assets_lesson_id ON public.video_assets(lesson_id);

-- system_config
CREATE UNIQUE INDEX IF NOT EXISTS idx_system_config_key ON public.system_config(key);

-- feature_flags
CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_flags_key ON public.feature_flags(key);

-- video_daily_health_reports
CREATE UNIQUE INDEX IF NOT EXISTS idx_vdhr_date_provider ON public.video_daily_health_reports(report_date, provider);
