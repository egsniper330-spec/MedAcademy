-- Add push_token column to devices table for per-device Expo Push Token storage.
-- Nullable: devices registered before this migration have no token until next login.
-- Index for fast lookup when broadcasting push notifications.
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS push_token TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_devices_push_token
  ON public.devices (push_token)
  WHERE push_token IS NOT NULL;

COMMENT ON COLUMN public.devices.push_token IS
  'Expo Push Token (ExponentPushToken[...]) for this device. '
  'Updated on every login and after reinstall. Cleared on logout. '
  'NULL means the device has not granted notification permission or token registration failed.';