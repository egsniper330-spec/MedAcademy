
-- ─── Phase 2 Security Hardening — Enum Extensions + Nonce Table ──────────────

-- 1. Add new values to security_detection_type enum
ALTER TYPE security_detection_type ADD VALUE IF NOT EXISTS 'developer_options';
ALTER TYPE security_detection_type ADD VALUE IF NOT EXISTS 'frida';
ALTER TYPE security_detection_type ADD VALUE IF NOT EXISTS 'xposed';
ALTER TYPE security_detection_type ADD VALUE IF NOT EXISTS 'magisk';
ALTER TYPE security_detection_type ADD VALUE IF NOT EXISTS 'overlay';
ALTER TYPE security_detection_type ADD VALUE IF NOT EXISTS 'tamper';
ALTER TYPE security_detection_type ADD VALUE IF NOT EXISTS 'play_integrity';

-- 2. Add new values to security_event_type enum
ALTER TYPE security_event_type ADD VALUE IF NOT EXISTS 'developer_options_enabled';
ALTER TYPE security_event_type ADD VALUE IF NOT EXISTS 'adb_enabled';
ALTER TYPE security_event_type ADD VALUE IF NOT EXISTS 'debugger_attached';
ALTER TYPE security_event_type ADD VALUE IF NOT EXISTS 'magisk_detected';
ALTER TYPE security_event_type ADD VALUE IF NOT EXISTS 'overlay_detected';
ALTER TYPE security_event_type ADD VALUE IF NOT EXISTS 'signature_invalid';
ALTER TYPE security_event_type ADD VALUE IF NOT EXISTS 'tamper_detected';
ALTER TYPE security_event_type ADD VALUE IF NOT EXISTS 'play_integrity_failed';
ALTER TYPE security_event_type ADD VALUE IF NOT EXISTS 'play_integrity_passed';

-- 3. Nonce table for Play Integrity API (single-use, 5-min TTL)
CREATE TABLE IF NOT EXISTS play_integrity_nonces (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce      text        NOT NULL UNIQUE,
  user_id    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_play_integrity_nonces_nonce
  ON play_integrity_nonces (nonce);

CREATE INDEX IF NOT EXISTS idx_play_integrity_nonces_expires
  ON play_integrity_nonces (expires_at);

ALTER TABLE play_integrity_nonces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access_nonces" ON play_integrity_nonces;
CREATE POLICY "service_role_full_access_nonces"
  ON play_integrity_nonces
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 4. Performance indexes on security_events
CREATE INDEX IF NOT EXISTS idx_security_events_event_type
  ON security_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_events_user_recent
  ON security_events (user_id, created_at DESC);
