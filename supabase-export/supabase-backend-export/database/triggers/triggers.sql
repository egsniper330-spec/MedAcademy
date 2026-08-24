-- =============================================================================
-- MedAcademy — All Triggers
-- Generated: 2026-07-13
-- Total: 25 triggers across public / storage / auth schemas
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- PUBLIC SCHEMA TRIGGERS
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. on_auth_user_created → handle_new_user (auth.users → public.profiles)
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2. set_updated_at on profiles
CREATE OR REPLACE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. set_updated_at on courses
CREATE OR REPLACE TRIGGER set_courses_updated_at
  BEFORE UPDATE ON public.courses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 4. set_updated_at on lessons
CREATE OR REPLACE TRIGGER set_lessons_updated_at
  BEFORE UPDATE ON public.lessons
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 5. set_updated_at on sections
CREATE OR REPLACE TRIGGER set_sections_updated_at
  BEFORE UPDATE ON public.sections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 6. set_updated_at on devices
CREATE OR REPLACE TRIGGER set_devices_updated_at
  BEFORE UPDATE ON public.devices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 7. set_updated_at on enrollments
CREATE OR REPLACE TRIGGER set_enrollments_updated_at
  BEFORE UPDATE ON public.enrollments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 8. set_updated_at on credits
CREATE OR REPLACE TRIGGER set_credits_updated_at
  BEFORE UPDATE ON public.credits
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 9. set_updated_at on security_policies
CREATE OR REPLACE TRIGGER set_security_policies_updated_at
  BEFORE UPDATE ON public.security_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 10. set_updated_at on content_protection_policies
CREATE OR REPLACE TRIGGER set_content_protection_policies_updated_at
  BEFORE UPDATE ON public.content_protection_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 11. set_updated_at on content_protection_violations
CREATE OR REPLACE TRIGGER set_content_protection_violations_updated_at
  BEFORE UPDATE ON public.content_protection_violations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 12. set_updated_at on video_uploads
CREATE OR REPLACE TRIGGER set_video_uploads_updated_at
  BEFORE UPDATE ON public.video_uploads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 13. set_updated_at on upload_sessions
CREATE OR REPLACE TRIGGER set_upload_sessions_updated_at
  BEFORE UPDATE ON public.upload_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 14. set_updated_at on universities
CREATE OR REPLACE TRIGGER set_universities_updated_at
  BEFORE UPDATE ON public.universities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 15. set_updated_at on faculties
CREATE OR REPLACE TRIGGER set_faculties_updated_at
  BEFORE UPDATE ON public.faculties
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 16. set_updated_at on academic_levels
CREATE OR REPLACE TRIGGER set_academic_levels_updated_at
  BEFORE UPDATE ON public.academic_levels
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 17. set_updated_at on video_assets
CREATE OR REPLACE TRIGGER set_video_assets_updated_at
  BEFORE UPDATE ON public.video_assets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 18. set_updated_at on video_provider_config
CREATE OR REPLACE TRIGGER set_video_provider_config_updated_at
  BEFORE UPDATE ON public.video_provider_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 19. credit_balance_guard — enforce non-negative balance on credits
CREATE OR REPLACE TRIGGER credit_balance_guard
  BEFORE UPDATE OF balance ON public.credits
  FOR EACH ROW EXECUTE FUNCTION public.enforce_credit_balance();

-- 20. log_enrollment_created — write to audit_logs after enrollment insert
CREATE OR REPLACE TRIGGER log_enrollment_created
  AFTER INSERT ON public.enrollments
  FOR EACH ROW EXECUTE FUNCTION public.log_enrollment_audit();

-- 21. log_credit_transaction — write to audit_logs after credit_transactions insert
CREATE OR REPLACE TRIGGER log_credit_transaction
  AFTER INSERT ON public.credit_transactions
  FOR EACH ROW EXECUTE FUNCTION public.log_credit_audit();

-- 22. handle_activation_code_redeemed — update credits after code redemption
CREATE OR REPLACE TRIGGER handle_activation_code_redeemed
  AFTER UPDATE OF status ON public.activation_codes
  FOR EACH ROW
  WHEN (NEW.status = 'used' AND OLD.status = 'active')
  EXECUTE FUNCTION public.handle_code_redemption();

-- ─────────────────────────────────────────────────────────────────────────────
-- STORAGE SCHEMA TRIGGERS
-- ─────────────────────────────────────────────────────────────────────────────

-- 23. log_storage_upload — audit log on storage.objects insert
CREATE OR REPLACE TRIGGER log_storage_upload
  AFTER INSERT ON storage.objects
  FOR EACH ROW EXECUTE FUNCTION public.log_storage_operation();

-- 24. log_storage_delete — audit log on storage.objects delete
CREATE OR REPLACE TRIGGER log_storage_delete
  AFTER DELETE ON storage.objects
  FOR EACH ROW EXECUTE FUNCTION public.log_storage_operation();

-- ─────────────────────────────────────────────────────────────────────────────
-- AUTH SCHEMA TRIGGERS
-- ─────────────────────────────────────────────────────────────────────────────

-- 25. on_auth_user_created (listed above under auth.users)
-- NOTE: The auth schema trigger is the main profile-creation hook.
-- The trigger function public.handle_new_user() inserts into public.profiles
-- and public.credits upon new auth.users row creation.

-- =============================================================================
-- TRIGGER FUNCTIONS (see database/functions/ for full source)
-- =============================================================================
-- public.handle_new_user()         — creates profile + credits row for new auth user
-- public.set_updated_at()          — sets updated_at = now() on any row update
-- public.enforce_credit_balance()  — raises exception if balance would go negative
-- public.log_enrollment_audit()    — writes audit_logs entry for enrollment
-- public.log_credit_audit()        — writes audit_logs entry for credit txn
-- public.handle_code_redemption()  — applies credit_amount to user credits balance
-- public.log_storage_operation()   — writes upload_audit_logs for storage events
