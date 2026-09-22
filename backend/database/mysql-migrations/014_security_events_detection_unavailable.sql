-- 014: Allow 'detection_unavailable' as a security_events.event_type.
--
-- Purpose: P4 of the security hardening — clients distinguish
--   confirmed threat / confirmed clean / DETECTION UNAVAILABLE / unsupported.
-- A native module failure previously became indistinguishable from
-- "everything is safe". With this migration, devices report
-- event_type='detection_unavailable' (metadata carries which detector failed)
-- so admins can see coverage gaps instead of an all-green dashboard.
-- This event type is observability-only: SecurityService.processViolation
-- treats it like any logged event; it never escalates strikes by itself.
--
-- MariaDB-safe and idempotent:
-- - Uses DROP CONSTRAINT (not DROP CHECK).
-- - Uses IF EXISTS so a partially-applied migration can be safely rerun.
-- - Recreates the constraint with the existing allowed event types plus
--   'detection_unavailable'.
--
-- NOTE: ALTER TABLE is DDL and is not transactional. Each ALTER is atomic,
-- but the two statements are separate. If the second statement fails, the
-- constraint will be absent and this migration should be rerun after fixing
-- the underlying data/schema issue.

ALTER TABLE `security_events`
  DROP CONSTRAINT IF EXISTS `chk_security_events_event_type`;

ALTER TABLE `security_events`
  ADD CONSTRAINT `chk_security_events_event_type`
  CHECK (`event_type` IN (
    'root_detected',
    'jailbreak_detected',
    'vpn_detected',
    'proxy_detected',
    'ssl_pinning_failure',
    'screenshot_detected',
    'screen_recording_detected',
    'debug_detected',
    'frida_detected',
    'xposed_detected',
    'app_integrity_compromised',
    'developer_options_enabled',
    'adb_enabled',
    'debugger_attached',
    'magisk_detected',
    'overlay_detected',
    'signature_invalid',
    'tamper_detected',
    'play_integrity_failed',
    'play_integrity_passed',
    'detection_unavailable'
  ));
