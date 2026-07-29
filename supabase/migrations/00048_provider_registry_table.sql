
-- ── Provider Registry ─────────────────────────────────────────────────────────
-- Stores configuration and health state for every external service provider.
-- Secrets are NEVER stored here — they live in Supabase Vault / env secrets.

CREATE TABLE IF NOT EXISTS provider_registry (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category         text NOT NULL,        -- 'video' | 'storage' | 'notification' | 'email' | 'sms' | 'payment' | 'auth' | 'analytics' | 'crash' | 'search' | 'ai'
  provider_key     text NOT NULL UNIQUE, -- stable machine key e.g. 'supabase_storage'
  display_name     text NOT NULL,        -- human-readable e.g. 'Supabase Storage'
  is_active        boolean NOT NULL DEFAULT false,
  is_default       boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'unknown', -- 'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'
  status_message   text,
  last_health_check timestamptz,
  version          text,
  config           jsonb NOT NULL DEFAULT '{}',   -- non-secret config (endpoints, region, etc.)
  capabilities     jsonb NOT NULL DEFAULT '[]',   -- list of supported operations
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pr_category  ON provider_registry(category);
CREATE INDEX IF NOT EXISTS idx_pr_is_active ON provider_registry(is_active);

-- ── Seed all providers ────────────────────────────────────────────────────────
INSERT INTO provider_registry (category, provider_key, display_name, is_active, is_default, status, capabilities, config) VALUES
-- Video
('video',        'medacademy_video',     'MedAcademy Video',      true,  true,  'healthy',  '["upload","delete","playback","thumbnail","metadata","drm","streaming"]',          '{"internal_provider":"vdocipher","supports_drm":true,"supports_streaming":true}'),
('video',        'cloudflare_stream',    'Cloudflare Stream',     false, false, 'unknown',  '["upload","delete","playback","thumbnail","metadata","streaming"]',                '{}'),
('video',        'mux',                  'Mux',                   false, false, 'unknown',  '["upload","delete","playback","thumbnail","metadata","streaming","analytics"]',    '{}'),
('video',        'bunny_stream',         'Bunny Stream',          false, false, 'unknown',  '["upload","delete","playback","thumbnail","metadata","streaming"]',                '{}'),
('video',        'aws_mediaconvert',     'AWS MediaConvert',      false, false, 'unknown',  '["upload","delete","transcode","metadata"]',                                       '{}'),
-- Storage
('storage',      'supabase_storage',     'Supabase Storage',      true,  true,  'healthy',  '["upload","delete","move","copy","url","signed_url","metadata","list"]',           '{"bucket":"lesson-materials"}'),
('storage',      'aws_s3',               'AWS S3',                false, false, 'unknown',  '["upload","delete","move","copy","url","signed_url","metadata","list"]',           '{}'),
('storage',      'cloudflare_r2',        'Cloudflare R2',         false, false, 'unknown',  '["upload","delete","move","copy","url","signed_url","metadata","list"]',           '{}'),
('storage',      'gcs',                  'Google Cloud Storage',  false, false, 'unknown',  '["upload","delete","move","copy","url","signed_url","metadata","list"]',           '{}'),
('storage',      'azure_blob',           'Azure Blob Storage',    false, false, 'unknown',  '["upload","delete","move","copy","url","signed_url","metadata"]',                  '{}'),
-- Notification
('notification', 'expo_push',            'Expo Push',             true,  true,  'healthy',  '["send_user","send_topic","broadcast","schedule","cancel"]',                      '{}'),
('notification', 'firebase_fcm',         'Firebase FCM',          false, false, 'unknown',  '["send_user","send_topic","broadcast","schedule","cancel"]',                      '{}'),
('notification', 'onesignal',            'OneSignal',             false, false, 'unknown',  '["send_user","send_topic","broadcast","schedule","cancel"]',                      '{}'),
('notification', 'huawei_push',          'Huawei Push',           false, false, 'unknown',  '["send_user","broadcast"]',                                                        '{}'),
-- Email
('email',        'resend',               'Resend',                false, false, 'unknown',  '["verification","password_reset","announcement","system"]',                        '{}'),
('email',        'sendgrid',             'SendGrid',              false, false, 'unknown',  '["verification","password_reset","announcement","system","template"]',             '{}'),
('email',        'amazon_ses',           'Amazon SES',            false, false, 'unknown',  '["verification","password_reset","announcement","system"]',                        '{}'),
('email',        'mailgun',              'Mailgun',               false, false, 'unknown',  '["verification","password_reset","announcement","system"]',                        '{}'),
-- SMS
('sms',          'twilio',               'Twilio',                false, false, 'unknown',  '["otp","verification","notification"]',                                            '{}'),
('sms',          'vonage',               'Vonage',                false, false, 'unknown',  '["otp","verification","notification"]',                                            '{}'),
('sms',          'egypt_sms',            'Egyptian SMS Gateway',  false, false, 'unknown',  '["otp","verification","notification"]',                                            '{"country":"EG"}'),
-- Payment
('payment',      'paymob',               'Paymob',                false, false, 'unknown',  '["create","refund","webhook","verify","invoice"]',                                 '{"country":"EG"}'),
('payment',      'stripe',               'Stripe',                false, false, 'unknown',  '["create","refund","webhook","verify","invoice","subscription"]',                  '{}'),
('payment',      'paypal',               'PayPal',                false, false, 'unknown',  '["create","refund","webhook","verify"]',                                           '{}'),
('payment',      'fawry',                'Fawry',                 false, false, 'unknown',  '["create","refund","webhook","verify"]',                                           '{"country":"EG"}'),
('payment',      'meeza',                'Meeza',                 false, false, 'unknown',  '["create","refund","verify"]',                                                     '{"country":"EG"}'),
-- Auth
('auth',         'supabase_auth',        'Supabase Auth',         true,  true,  'healthy',  '["login","logout","register","refresh","reset_password","otp","oauth"]',          '{}'),
('auth',         'firebase_auth',        'Firebase Auth',         false, false, 'unknown',  '["login","logout","register","refresh","reset_password","oauth"]',                '{}'),
('auth',         'auth0',                'Auth0',                 false, false, 'unknown',  '["login","logout","register","refresh","reset_password","oauth","sso"]',          '{}'),
('auth',         'clerk',                'Clerk',                 false, false, 'unknown',  '["login","logout","register","refresh","reset_password","oauth","mfa"]',          '{}'),
-- Analytics
('analytics',    'internal_analytics',   'Internal Analytics',    true,  true,  'healthy',  '["track","page","identify","group","alias"]',                                      '{"engine":"supabase"}'),
('analytics',    'firebase_analytics',   'Firebase Analytics',    false, false, 'unknown',  '["track","page","identify","group"]',                                             '{}'),
('analytics',    'posthog',              'PostHog',               false, false, 'unknown',  '["track","page","identify","group","replay","flags"]',                            '{}'),
('analytics',    'mixpanel',             'Mixpanel',              false, false, 'unknown',  '["track","page","identify","group","funnel"]',                                    '{}'),
-- Crash Reporting
('crash',        'internal_crash',       'Internal Logging',      true,  true,  'healthy',  '["capture","breadcrumb","context","flush"]',                                       '{}'),
('crash',        'sentry',               'Sentry',                false, false, 'unknown',  '["capture","breadcrumb","context","performance","replay"]',                      '{}'),
('crash',        'crashlytics',          'Firebase Crashlytics',  false, false, 'unknown',  '["capture","breadcrumb","context"]',                                              '{}'),
-- Search
('search',       'postgres_search',      'PostgreSQL Search',     true,  true,  'healthy',  '["search","suggest","index","filter","rank"]',                                    '{"engine":"postgresql","fts":true}'),
('search',       'meilisearch',          'Meilisearch',           false, false, 'unknown',  '["search","suggest","index","filter","rank","typo_tolerance"]',                   '{}'),
('search',       'typesense',            'Typesense',             false, false, 'unknown',  '["search","suggest","index","filter","rank","typo_tolerance"]',                   '{}'),
('search',       'algolia',              'Algolia',               false, false, 'unknown',  '["search","suggest","index","filter","rank","analytics"]',                        '{}'),
-- AI
('ai',           'internal_ai',          'Internal AI (Stub)',     true,  true,  'healthy',  '["complete","embed","classify","summarize","translate"]',                          '{}'),
('ai',           'openai',               'OpenAI',                false, false, 'unknown',  '["complete","embed","classify","summarize","translate","image","audio"]',         '{}'),
('ai',           'claude',               'Claude (Anthropic)',     false, false, 'unknown',  '["complete","embed","summarize","translate","analysis"]',                         '{}'),
('ai',           'gemini',               'Gemini (Google)',        false, false, 'unknown',  '["complete","embed","summarize","translate","image","multimodal"]',               '{}'),
('ai',           'azure_openai',         'Azure OpenAI',          false, false, 'unknown',  '["complete","embed","classify","summarize"]',                                     '{}')
ON CONFLICT (provider_key) DO NOTHING;

-- ── Provider Audit Log ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key  text NOT NULL,
  category      text NOT NULL,
  operation     text NOT NULL,  -- 'upload' | 'send_notification' | 'create_payment' etc.
  actor_id      uuid REFERENCES profiles(id),
  success       boolean NOT NULL DEFAULT true,
  duration_ms   integer,
  metadata      jsonb,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pal_provider_key ON provider_audit_log(provider_key);
CREATE INDEX IF NOT EXISTS idx_pal_category     ON provider_audit_log(category);
CREATE INDEX IF NOT EXISTS idx_pal_created_at   ON provider_audit_log(created_at DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE provider_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_audit_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='provider_registry' AND policyname='super_admin_provider_registry') THEN
    CREATE POLICY "super_admin_provider_registry" ON provider_registry
      FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='provider_audit_log' AND policyname='super_admin_provider_audit') THEN
    CREATE POLICY "super_admin_provider_audit" ON provider_audit_log
      FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'));
  END IF;
END $$;
