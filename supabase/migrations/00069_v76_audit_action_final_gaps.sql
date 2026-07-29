
-- ══════════════════════════════════════════════════════════════════════════════
-- v76 — Final audit_action gaps discovered by full EF code scan
-- ══════════════════════════════════════════════════════════════════════════════
-- These strings are written directly by Edge Functions but were missing:

-- restore-account EF
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'account_restored';

-- delete-user EF (self-verification step)
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'deletion_verification_failed';

-- impersonate EF
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'impersonation_started';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'impersonation_ended';

-- activation-codes EF
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'code_deleted';

-- vdocipher-otp EF (video play event logged to audit)
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'video_play';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'video_play_failed';

-- Proactive: credit/subscription lifecycle
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'credit_refunded';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'credit_expired';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'subscription_created';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'subscription_removed';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'subscription_restored';

-- Proactive: profile/settings
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'profile_updated';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'avatar_updated';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'settings_changed';

-- Verify count
SELECT count(*) AS total FROM pg_enum WHERE enumtypid = 'public.audit_action'::regtype;
