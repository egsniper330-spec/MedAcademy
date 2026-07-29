-- ============================================================
-- MedAcademy — Development Seed Data
-- ============================================================
-- IMPORTANT: This file is for LOCAL DEVELOPMENT ONLY.
-- Never run this against staging or production.
-- Seeds: default system config values and permission templates.
-- Does NOT seed real users or production data.
-- ============================================================

-- ── System Configuration defaults ────────────────────────────
INSERT INTO system_config (key, value, description) VALUES
  ('max_devices_per_user',    '2',     'Maximum trusted devices allowed per user account'),
  ('activation_code_length',  '12',    'Character length of generated activation codes'),
  ('credit_expiry_days',      '365',   'Number of days before unused credits expire'),
  ('video_watermark_enabled', 'true',  'Whether video watermark overlay is active'),
  ('maintenance_mode',        'false', 'Set to true to display maintenance page to users'),
  ('max_login_attempts',      '5',     'Failed login attempts before temporary lockout'),
  ('lockout_duration_minutes','15',    'Minutes an account is locked after max failed attempts')
ON CONFLICT (key) DO NOTHING;

-- ── Default course categories ─────────────────────────────────
INSERT INTO categories (name, slug, description) VALUES
  ('Internal Medicine',    'internal-medicine',    'Internal medicine courses'),
  ('Surgery',              'surgery',              'Surgical procedures and techniques'),
  ('Pediatrics',           'pediatrics',           'Child health and development'),
  ('Cardiology',           'cardiology',           'Heart and cardiovascular system'),
  ('Neurology',            'neurology',            'Nervous system disorders'),
  ('Radiology',            'radiology',            'Medical imaging and diagnostics'),
  ('Pharmacology',         'pharmacology',         'Drug therapy and clinical pharmacology'),
  ('Emergency Medicine',   'emergency-medicine',   'Emergency and critical care'),
  ('Dermatology',          'dermatology',          'Skin, hair and nail conditions'),
  ('Psychiatry',           'psychiatry',           'Mental health and behavioral medicine')
ON CONFLICT (slug) DO NOTHING;
