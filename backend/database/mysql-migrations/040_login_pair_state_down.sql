-- ============================================================================
-- 040_login_pair_state_down.sql — rollback for 040_login_pair_state.sql
--
-- Drops ONLY the pair-throttle state. Login then relies on the per-IP limiter
-- alone, exactly as before this change. No user, session or login-history data
-- is touched.
-- ============================================================================

DROP TABLE IF EXISTS `login_pair_state`;
