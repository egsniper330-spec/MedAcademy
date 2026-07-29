
-- 1. Add missing notification_type enum values
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'admin_broadcast';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'announcement';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'maintenance';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'broadcast';

-- 2. Add Telegram / WhatsApp / YouTube / Website to app_branding (replacing twitter/linkedin)
ALTER TABLE app_branding
  ADD COLUMN IF NOT EXISTS telegram_url text,
  ADD COLUMN IF NOT EXISTS whatsapp_url text,
  ADD COLUMN IF NOT EXISTS youtube_url  text,
  ADD COLUMN IF NOT EXISTS website_url  text;
