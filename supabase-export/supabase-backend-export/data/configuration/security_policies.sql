-- MedAcademy Config Data: security_policies (15 rows)
INSERT INTO public.security_policies (id, detection_type, action, enabled) VALUES
  ('62dfb3ff-e2c5-4835-a99f-1f5eb0f1ecd1','root_jailbreak','block_login',true),
  ('4f6c1980-b28e-489a-a4cc-279f8820f5cd','vpn','block_login',true),
  ('e3c71f3b-22cb-43d1-b28b-c1377311d9d5','proxy','block_login',true),
  ('32d86676-a6ae-46dd-bc0a-e5f2150523a4','ssl_pinning','block_login',true),
  ('ac5cd982-e5d3-4293-af58-643d627be53a','debug','block_login',true),
  ('bb0e3231-4a49-40e2-8f34-55d35edb1cf5','screenshot','warn_only',true),
  ('8500c25c-2bb3-4529-926c-090633d355ae','screen_recording','block_video',true),
  ('760ce817-f566-478f-a65b-74fdadd8fe2b','app_integrity','block_login',true),
  ('e3e6b36c-a912-42a8-93bb-9fe373dc77a6','developer_options','block_login',true),
  ('cf4f0316-4d99-4b1f-a494-5aa9d803edc8','frida','block_login',true),
  ('950eeb97-c19a-4c08-b29a-2651cd0c12ee','xposed','block_login',true),
  ('9e8b4d5c-3059-47d7-99a1-e4b87333e370','magisk','block_login',true),
  ('674935c6-cee7-411b-9015-dca56bdcd3f9','overlay','block_video',true),
  ('3de2b258-5c1e-4d13-b9e9-1cc514f250c6','tamper','block_login',true),
  ('3de60149-f7c4-4202-a435-e6ff583b6eaf','play_integrity','block_login',true)
ON CONFLICT (id) DO NOTHING;
