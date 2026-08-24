-- MedAcademy Config Data: support_settings (3 rows)
INSERT INTO public.support_settings (key, value, label, enabled) VALUES
  ('phone','','Phone Support',false),
  ('telegram','','Telegram Support',false),
  ('whatsapp','','WhatsApp Support',false)
ON CONFLICT (key) DO NOTHING;
