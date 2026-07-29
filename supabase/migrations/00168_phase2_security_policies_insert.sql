
-- Insert Phase 2 policies (enum values now exist)
INSERT INTO security_policies (detection_type, action, enabled)
VALUES
  ('developer_options', 'block_login', true),
  ('frida',             'block_login', true),
  ('xposed',            'block_login', true),
  ('magisk',            'block_login', true),
  ('overlay',           'block_video', true),
  ('tamper',            'block_login', true),
  ('play_integrity',    'block_login', true)
ON CONFLICT (detection_type) DO UPDATE
  SET action  = EXCLUDED.action,
      enabled = EXCLUDED.enabled;
