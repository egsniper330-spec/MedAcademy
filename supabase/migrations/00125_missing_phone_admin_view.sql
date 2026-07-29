
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: missing_phone_admin_view
--
-- Provides a fast way for Super Admins to identify accounts that still lack
-- a phone number. These accounts should be contacted to update their details.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW admin_missing_phone AS
SELECT
  p.id,
  p.full_name,
  p.email,
  p.profile_email,
  p.role,
  p.status,
  p.watermark_id,
  p.created_at,
  -- Whether the auth.users record has phone metadata we could backfill
  CASE
    WHEN (u.raw_user_meta_data->>'phone') IS NOT NULL
     AND (u.raw_user_meta_data->>'phone') <> ''
    THEN true
    ELSE false
  END AS meta_has_phone,
  u.raw_user_meta_data->>'phone' AS meta_phone
FROM profiles p
JOIN auth.users u ON u.id = p.id
WHERE p.phone_e164 IS NULL
  -- Exclude synthetic internal test / seed accounts
  AND p.email NOT LIKE '%@medacademy.internal'
ORDER BY p.created_at DESC;

-- RLS: only super_admin and admin can query this view
-- (The view uses SECURITY INVOKER by default; wrap access via RLS on underlying tables)
COMMENT ON VIEW admin_missing_phone IS
  'Lists all real user accounts that have no phone_e164. Use for admin follow-up.';
