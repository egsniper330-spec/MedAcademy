-- =============================================================================
-- MedAcademy — RLS Policies (All Tables)
-- Generated: 2026-07-13
-- Total: 100+ policies across 60 tables
-- =============================================================================
-- Helper function used by most policies:
--   public.get_my_role()         RETURNS user_role  SECURITY DEFINER
--   public.is_admin()            RETURNS boolean    SECURITY DEFINER
--   public.is_super_admin()      RETURNS boolean    SECURITY DEFINER
--   public.is_doctor()           RETURNS boolean    SECURITY DEFINER
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- profiles
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);

CREATE POLICY "Admins can view all profiles"
  ON public.profiles FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Admins can update all profiles"
  ON public.profiles FOR UPDATE
  USING (public.is_admin());

CREATE POLICY "Admins can insert profiles"
  ON public.profiles FOR INSERT
  WITH CHECK (public.is_admin());

CREATE POLICY "Service role full access on profiles"
  ON public.profiles FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- devices
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Users can view own devices"
  ON public.devices FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own devices"
  ON public.devices FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own devices"
  ON public.devices FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage all devices"
  ON public.devices FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on devices"
  ON public.devices FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- universities / faculties / academic_levels / categories
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Anyone authenticated can view universities"
  ON public.universities FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage universities"
  ON public.universities FOR ALL
  USING (public.is_admin());

CREATE POLICY "Anyone authenticated can view faculties"
  ON public.faculties FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage faculties"
  ON public.faculties FOR ALL
  USING (public.is_admin());

CREATE POLICY "Anyone authenticated can view academic_levels"
  ON public.academic_levels FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage academic_levels"
  ON public.academic_levels FOR ALL
  USING (public.is_admin());

CREATE POLICY "Anyone authenticated can view categories"
  ON public.categories FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage categories"
  ON public.categories FOR ALL
  USING (public.is_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- courses
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Students can view published non-deleted courses"
  ON public.courses FOR SELECT
  USING (status = 'published' AND is_deleted = false AND public.get_my_role() = 'student');

CREATE POLICY "Doctors can view own courses"
  ON public.courses FOR SELECT
  USING (doctor_id = auth.uid() AND public.get_my_role() IN ('doctor','assistant'));

CREATE POLICY "Doctors can insert courses"
  ON public.courses FOR INSERT
  WITH CHECK (doctor_id = auth.uid() AND public.get_my_role() IN ('doctor','assistant'));

CREATE POLICY "Doctors can update own courses"
  ON public.courses FOR UPDATE
  USING (doctor_id = auth.uid() AND public.get_my_role() IN ('doctor','assistant'));

CREATE POLICY "Admins can manage all courses"
  ON public.courses FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on courses"
  ON public.courses FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- sections / lessons
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Enrolled students can view sections"
  ON public.sections FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.enrollments e
      JOIN public.courses c ON c.id = sections.course_id
      WHERE e.user_id = auth.uid() AND e.course_id = sections.course_id
        AND c.is_deleted = false
    ) OR public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.courses c WHERE c.id = sections.course_id AND c.doctor_id = auth.uid()
      )
  );

CREATE POLICY "Doctors can manage own course sections"
  ON public.sections FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.courses WHERE id = sections.course_id AND doctor_id = auth.uid())
    OR public.is_admin()
  );

CREATE POLICY "Service role full access on sections"
  ON public.sections FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Enrolled students can view lessons"
  ON public.lessons FOR SELECT
  USING (
    is_preview = true
    OR EXISTS (
      SELECT 1 FROM public.enrollments e WHERE e.user_id = auth.uid() AND e.course_id = lessons.course_id
    )
    OR public.is_admin()
    OR EXISTS (SELECT 1 FROM public.courses WHERE id = lessons.course_id AND doctor_id = auth.uid())
  );

CREATE POLICY "Doctors can manage own lessons"
  ON public.lessons FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.courses WHERE id = lessons.course_id AND doctor_id = auth.uid())
    OR public.is_admin()
  );

CREATE POLICY "Service role full access on lessons"
  ON public.lessons FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- lesson_materials
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Enrolled users can view lesson materials"
  ON public.lesson_materials FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.lessons l
      JOIN public.enrollments e ON e.course_id = l.course_id AND e.user_id = auth.uid()
      WHERE l.id = lesson_materials.lesson_id
    ) OR public.is_admin()
  );

CREATE POLICY "Doctors can manage own lesson materials"
  ON public.lesson_materials FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.lessons l
      JOIN public.courses c ON c.id = l.course_id AND c.doctor_id = auth.uid()
      WHERE l.id = lesson_materials.lesson_id
    ) OR public.is_admin()
  );

CREATE POLICY "Service role full access on lesson_materials"
  ON public.lesson_materials FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- lesson_progress
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Users can manage own lesson progress"
  ON public.lesson_progress FOR ALL
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all lesson progress"
  ON public.lesson_progress FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Service role full access on lesson_progress"
  ON public.lesson_progress FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- enrollments
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Users can view own enrollments"
  ON public.enrollments FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Doctors can view enrollments in own courses"
  ON public.enrollments FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.courses WHERE id = enrollments.course_id AND doctor_id = auth.uid())
  );

CREATE POLICY "Admins can manage all enrollments"
  ON public.enrollments FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on enrollments"
  ON public.enrollments FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- credits / credit_transactions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Users can view own credits"
  ON public.credits FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage all credits"
  ON public.credits FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on credits"
  ON public.credits FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Users can view own credit transactions"
  ON public.credit_transactions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage all credit transactions"
  ON public.credit_transactions FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on credit_transactions"
  ON public.credit_transactions FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- activation_codes / code_batches
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Admins can manage activation codes"
  ON public.activation_codes FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on activation_codes"
  ON public.activation_codes FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Authenticated users can read own used code"
  ON public.activation_codes FOR SELECT
  USING (used_by = auth.uid());

CREATE POLICY "Admins can manage code batches"
  ON public.code_batches FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on code_batches"
  ON public.code_batches FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- notifications
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Users can view own notifications"
  ON public.notifications FOR SELECT
  USING (auth.uid() = user_id OR user_id IS NULL);

CREATE POLICY "Users can update own notifications (mark read)"
  ON public.notifications FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage all notifications"
  ON public.notifications FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on notifications"
  ON public.notifications FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- security_events / security_policies / security_vpn_whitelist
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Users can insert own security events"
  ON public.security_events FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can view all security events"
  ON public.security_events FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Service role full access on security_events"
  ON public.security_events FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Authenticated users can read security policies"
  ON public.security_policies FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage security policies"
  ON public.security_policies FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on security_policies"
  ON public.security_policies FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Admins can manage vpn whitelist"
  ON public.security_vpn_whitelist FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on security_vpn_whitelist"
  ON public.security_vpn_whitelist FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- content_protection_policies / content_protection_violations / fraud_flags
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated users can read content protection policies"
  ON public.content_protection_policies FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage content protection policies"
  ON public.content_protection_policies FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on content_protection_policies"
  ON public.content_protection_policies FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Users can view own violations"
  ON public.content_protection_violations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage all violations"
  ON public.content_protection_violations FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on content_protection_violations"
  ON public.content_protection_violations FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Admins can manage fraud flags"
  ON public.fraud_flags FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on fraud_flags"
  ON public.fraud_flags FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- video_uploads / upload_sessions / upload_audit_logs / video_assets
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Doctors can manage own video uploads"
  ON public.video_uploads FOR ALL
  USING (doctor_id = auth.uid() OR public.is_admin());

CREATE POLICY "Service role full access on video_uploads"
  ON public.video_uploads FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Users can manage own upload sessions"
  ON public.upload_sessions FOR ALL
  USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY "Service role full access on upload_sessions"
  ON public.upload_sessions FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Admins can view upload audit logs"
  ON public.upload_audit_logs FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Service role full access on upload_audit_logs"
  ON public.upload_audit_logs FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Authenticated can view video assets"
  ON public.video_assets FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage video assets"
  ON public.video_assets FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on video_assets"
  ON public.video_assets FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_logs / crash_logs / analytics_events / course_lifecycle_logs
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Admins can view all audit logs"
  ON public.audit_logs FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Service role full access on audit_logs"
  ON public.audit_logs FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Users can insert own crash logs"
  ON public.crash_logs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can view all crash logs"
  ON public.crash_logs FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Service role full access on crash_logs"
  ON public.crash_logs FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Users can insert own analytics events"
  ON public.analytics_events FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can view all analytics events"
  ON public.analytics_events FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Service role full access on analytics_events"
  ON public.analytics_events FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Admins can view course lifecycle logs"
  ON public.course_lifecycle_logs FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Service role full access on course_lifecycle_logs"
  ON public.course_lifecycle_logs FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- doctor_earnings_* / doctor_payout_requests / platform_earnings_resets
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Doctors can view own earnings events"
  ON public.doctor_earnings_events FOR SELECT
  USING (doctor_id = auth.uid() OR public.is_admin());

CREATE POLICY "Service role full access on doctor_earnings_events"
  ON public.doctor_earnings_events FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Doctors can view own earnings transactions"
  ON public.doctor_earnings_transactions FOR SELECT
  USING (doctor_id = auth.uid() OR public.is_admin());

CREATE POLICY "Service role full access on doctor_earnings_transactions"
  ON public.doctor_earnings_transactions FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Admins can manage doctor pricing history"
  ON public.doctor_pricing_history FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on doctor_pricing_history"
  ON public.doctor_pricing_history FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Doctors can view own payout requests"
  ON public.doctor_payout_requests FOR SELECT
  USING (doctor_id = auth.uid() OR public.is_admin());

CREATE POLICY "Service role full access on doctor_payout_requests"
  ON public.doctor_payout_requests FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Admins can manage platform earnings resets"
  ON public.platform_earnings_resets FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on platform_earnings_resets"
  ON public.platform_earnings_resets FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- system_config / feature_flags / support_settings / maintenance_whitelist / trash_config
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can read system config"
  ON public.system_config FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage system config"
  ON public.system_config FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on system_config"
  ON public.system_config FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Authenticated can read feature flags"
  ON public.feature_flags FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage feature flags"
  ON public.feature_flags FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on feature_flags"
  ON public.feature_flags FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Authenticated can read support settings"
  ON public.support_settings FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage support settings"
  ON public.support_settings FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on support_settings"
  ON public.support_settings FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Admins can manage maintenance whitelist"
  ON public.maintenance_whitelist FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on maintenance_whitelist"
  ON public.maintenance_whitelist FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Admins can manage trash config"
  ON public.trash_config FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on trash_config"
  ON public.trash_config FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- app_branding / app_pages / course_templates
-- ─────────────────────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can read app branding"
  ON public.app_branding FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage app branding"
  ON public.app_branding FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on app_branding"
  ON public.app_branding FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Authenticated can read published app pages"
  ON public.app_pages FOR SELECT
  USING (is_published = true OR public.is_admin());

CREATE POLICY "Admins can manage app pages"
  ON public.app_pages FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on app_pages"
  ON public.app_pages FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Admins can manage course templates"
  ON public.course_templates FOR ALL
  USING (public.is_admin());

CREATE POLICY "Service role full access on course_templates"
  ON public.course_templates FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- STORAGE BUCKET POLICIES
-- ─────────────────────────────────────────────────────────────────────────────

-- course-images bucket
CREATE POLICY "Authenticated can view course images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'course-images' AND auth.role() = 'authenticated');

CREATE POLICY "Doctors can upload course images"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'course-images'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Doctors can update own course images"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'course-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Doctors can delete own course images"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'course-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- user-avatars bucket
CREATE POLICY "Authenticated can view avatars"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'user-avatars' AND auth.role() = 'authenticated');

CREATE POLICY "Users can upload own avatar"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'user-avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Users can update own avatar"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'user-avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Users can delete own avatar"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'user-avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- lesson-materials bucket
CREATE POLICY "Enrolled users can view lesson materials"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'lesson-materials'
    AND auth.role() = 'authenticated'
  );

CREATE POLICY "Doctors can upload lesson materials"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'lesson-materials'
    AND auth.role() = 'authenticated'
  );

CREATE POLICY "Admins/doctors can delete lesson materials"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'lesson-materials' AND auth.role() = 'authenticated');

-- video-chunks / video-uploads / video-thumbnails: service_role only
CREATE POLICY "Service role manages video chunks"
  ON storage.objects FOR ALL
  USING (bucket_id IN ('video-chunks','video-uploads','video-thumbnails') AND auth.role() = 'service_role');

-- temp-uploads: authenticated users can manage own files
CREATE POLICY "Users can manage own temp uploads"
  ON storage.objects FOR ALL
  USING (
    bucket_id = 'temp-uploads'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
