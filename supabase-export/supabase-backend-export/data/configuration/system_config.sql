-- MedAcademy Config Data: system_config (10 rows)
INSERT INTO public.system_config (id, key, value, updated_at) VALUES
  ('c107f21c-d3b7-460d-a63a-40c4f6ff6861','app_name','"MedAcademy"','2026-07-14 00:22:45.022650+00'),
  ('8a1d634a-a366-494d-bad9-d33657b4dc38','activation_code_price','{"amount": 100, "currency": "EGP"}','2026-07-25 06:36:33.921000+00'),
  ('ba63e2e8-8f59-4113-8693-35a7533f353a','credit_price','{"amount": 100, "currency": "EGP"}','2026-07-25 06:36:33.610000+00'),
  ('17637994-14dc-4c51-802a-2649c0d8a374','low_credit_threshold','{"amount": 10}','2026-07-14 17:59:32.589872+00'),
  ('7d02f769-9885-4779-b27f-077d69826403','maintenance_enabled','false','2026-07-30 14:48:30.316000+00'),
  ('8ff08a48-e4b2-4494-bec1-cf3852f0213a','maintenance_message','"Test"','2026-07-30 14:44:53.205000+00'),
  ('52420d37-4a2e-4334-b5f1-725be71ca3c6','maintenance_mode','false','2026-07-14 00:22:45.022650+00'),
  ('0346c8b8-d790-49f6-8162-9400f91f13b5','platform_currency','{"code": "EGP", "name": "Egyptian Pound", "symbol": "ج.م", "decimals": 0, "position": "after"}','2026-07-14 14:43:05.128886+00'),
  ('2bab83bd-02e4-435e-8463-28e851a80a6e','security_policy','{"block_vpn": true, "block_root": true, "block_emulator": true}','2026-07-14 14:40:06.183000+00'),
  ('0e12dade-7e91-4a4f-a443-3532a9f43053','video_provider','"vdocipher"','2026-07-14 00:22:45.022650+00')
ON CONFLICT (id) DO NOTHING;
