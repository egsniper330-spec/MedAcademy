-- 015: Allow 'app_attest_failed' as a security_events.event_type.
--
-- Purpose: closes the backend event-type allowlist gap for iOS App Attest.
-- The client (src/lib/security.ts runAppAttestCheck) emits
-- event_type='app_attest_failed' when Apple's attestation/assertion verdict
-- fails, but the CHECK constraint introduced by the original schema (and
-- extended by 014) does not include that value — every iOS attestation-failure
-- event would be rejected at the DB level (SQLSTATE 3819), so the backend
-- would never receive the authoritative evidence it needs to enforce policy.
--
-- This event type is used by the security pipeline exactly like
-- 'play_integrity_failed': policy_action + risk_score ride on the event row
-- and the server remains the final authority for any enforcement decision.
--
-- MariaDB-safe and idempotent: DROP CONSTRAINT IF EXISTS, then recreate with
-- the existing allowed types plus 'app_attest_failed'.
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
    'detection_unavailable',
    'app_attest_failed'
  ));
