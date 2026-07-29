
-- ═══════════════════════════════════════════════════════════════
-- Migration 00017: Enterprise Admin Panel V2
-- ═══════════════════════════════════════════════════════════════

-- ── 1. App Branding ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_branding (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_name       text NOT NULL DEFAULT 'MedAcademy',
  logo_url       text,
  splash_logo_url text,
  primary_color  text NOT NULL DEFAULT '#1565C0',
  secondary_color text NOT NULL DEFAULT '#0D47A1',
  contact_email  text DEFAULT 'support@medacademy.app',
  contact_phone  text,
  facebook_url   text,
  twitter_url    text,
  instagram_url  text,
  linkedin_url   text,
  support_email  text DEFAULT 'support@medacademy.app',
  updated_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_branding (id) VALUES ('00000000-0000-0000-0000-000000000001')
  ON CONFLICT (id) DO NOTHING;

ALTER TABLE app_branding ENABLE ROW LEVEL SECURITY;

CREATE POLICY "SA can manage branding" ON app_branding
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin')
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin')
  );

CREATE POLICY "Anyone can read branding" ON app_branding
  FOR SELECT USING (true);

-- ── 2. CMS / App Pages ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_pages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text UNIQUE NOT NULL,
  title       text NOT NULL,
  content     text NOT NULL DEFAULT '',
  published   boolean NOT NULL DEFAULT true,
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_pages (key, title, content) VALUES
('about_us', 'About Us',
'# About MedAcademy

MedAcademy is an enterprise-grade medical education platform designed to connect medical professionals with students worldwide.

## Our Mission
We believe every medical student deserves access to world-class educational content from the best doctors and medical professionals.

## Our Platform
- Secure video-based learning with DRM protection
- Structured courses by university, faculty, and academic level
- Direct interaction between doctors and students
- Comprehensive progress tracking'),
('contact_us', 'Contact Us',
'# Contact Us

We would love to hear from you.

## Support
- Email: support@medacademy.app
- Response time: Within 24 hours

## Technical Support
For technical issues, please include your device type, OS version, and a description of the problem.'),
('privacy_policy', 'Privacy Policy',
'# Privacy Policy

Last updated: January 2025

## Information We Collect
We collect information you provide directly, including name, email, phone number, and educational institution details.

## Data Security
We implement industry-standard security measures including encryption, secure authentication, and regular security audits.'),
('terms_conditions', 'Terms & Conditions',
'# Terms & Conditions

Last updated: January 2025

## Acceptance of Terms
By accessing MedAcademy, you agree to these terms of service.

## Use of Service
- You must be at least 18 years old or have parental consent
- You are responsible for maintaining account security
- Unauthorized sharing of course content is prohibited')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE app_pages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin can manage pages" ON app_pages
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','super_admin'))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','super_admin'))
  );

CREATE POLICY "Anyone can read published pages" ON app_pages
  FOR SELECT USING (published = true);

-- ── 3. Feature Flags ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text UNIQUE NOT NULL,
  label       text NOT NULL,
  description text,
  enabled     boolean NOT NULL DEFAULT true,
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO feature_flags (key, label, description, enabled) VALUES
('registration',      'User Registration',   'Allow new users to register on the platform', true),
('login',             'User Login',          'Allow users to log in to the platform', true),
('credits',           'Credit System',       'Enable the credit-based course access system', true),
('activation_codes',  'Activation Codes',    'Allow students to redeem activation codes', true),
('subscriptions',     'Subscriptions',       'Enable subscription-based access (future)', false),
('course_creation',   'Course Creation',     'Allow doctors to create new courses', true),
('notifications',     'Notifications',       'Enable push and in-app notifications', true),
('maintenance_mode',  'Maintenance Mode',    'Put the platform into maintenance mode', false),
('video_uploads',     'Video Uploads',       'Allow doctors to upload videos', true)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "SA can manage feature flags" ON feature_flags
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin')
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin')
  );

CREATE POLICY "Authenticated can read flags" ON feature_flags
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- ── 4. Maintenance Whitelist ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS maintenance_whitelist (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  added_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE maintenance_whitelist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "SA can manage whitelist" ON maintenance_whitelist
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin')
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin')
  );

CREATE POLICY "Anyone can check own whitelist status" ON maintenance_whitelist
  FOR SELECT USING (user_id = auth.uid());

-- ── 5. Pricing Settings in system_config ─────────────────────────
INSERT INTO system_config (key, value) VALUES
('credit_price',          '{"amount": 10, "currency": "USD"}'),
('activation_code_price', '{"amount": 25, "currency": "USD"}'),
('maintenance_enabled',   'false'),
('maintenance_message',   '"We are currently performing maintenance. Please check back soon."')
ON CONFLICT (key) DO NOTHING;

-- ── 6. Extended notifications for broadcast/targeting ────────────
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS target_type          text DEFAULT 'individual',
  ADD COLUMN IF NOT EXISTS target_role          text,
  ADD COLUMN IF NOT EXISTS target_university_id uuid REFERENCES universities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS target_faculty_id    uuid REFERENCES faculties(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS target_level_id      uuid REFERENCES academic_levels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sent_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sent_at              timestamptz DEFAULT now();

-- ── 7. Device stats view ──────────────────────────────────────────
CREATE OR REPLACE VIEW device_stats AS
  SELECT
    COUNT(*)                AS total_devices,
    COUNT(DISTINCT user_id) AS users_with_devices
  FROM devices;

-- ── 8. Credits summary view ───────────────────────────────────────
CREATE OR REPLACE VIEW credits_summary AS
  SELECT
    COALESCE(SUM(allocated), 0)              AS total_credits,
    COALESCE(SUM(consumed), 0)               AS used_credits,
    COALESCE(SUM(allocated - consumed), 0)   AS remaining_credits
  FROM credits;

-- ── 9. Activation codes summary view ─────────────────────────────
CREATE OR REPLACE VIEW activation_codes_summary AS
  SELECT
    COUNT(*) FILTER (WHERE status = 'active'      AND (expires_at IS NULL OR expires_at > now())) AS active_codes,
    COUNT(*) FILTER (WHERE status = 'used')                                                        AS used_codes,
    COUNT(*) FILTER (WHERE status = 'deactivated')                                                 AS disabled_codes,
    COUNT(*) FILTER (WHERE status = 'active'      AND expires_at IS NOT NULL AND expires_at <= now()) AS expired_codes,
    COUNT(*)                                                                                        AS total_codes
  FROM activation_codes;
