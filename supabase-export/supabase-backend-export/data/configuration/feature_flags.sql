-- MedAcademy Config Data: feature_flags (9 rows)
INSERT INTO public.feature_flags (id, key, label, description, enabled, updated_at) VALUES
  ('014d9af1-1290-4ab1-8d90-849bc97ee8d5','activation_codes','Activation Codes','Allow students to redeem activation codes',true,'2026-07-14 12:54:27.370586+00'),
  ('57cc5166-9535-4124-9185-daaf6b2669f8','course_creation','Course Creation','Allow doctors to create new courses',true,'2026-07-14 12:54:27.370586+00'),
  ('a61b98e2-c121-4665-8640-8895785a30ea','credits','Credit System','Enable the credit-based course access system',true,'2026-07-14 12:54:27.370586+00'),
  ('c3691b8b-a617-4f47-9d6b-ccb2a5018e10','login','User Login','Allow users to log in to the platform',true,'2026-07-14 12:54:27.370586+00'),
  ('c320dc45-b2b2-4d31-bccd-df0ba3996604','maintenance_mode','Maintenance Mode','Put the platform into maintenance mode',false,'2026-07-14 12:54:27.370586+00'),
  ('48697e92-0531-4a7a-87bb-bd6550ce8762','notifications','Notifications','Enable push and in-app notifications',true,'2026-07-14 12:54:27.370586+00'),
  ('752bcbe4-8aa3-42b2-9c46-c0b593f16125','registration','User Registration','Allow new users to register on the platform',true,'2026-07-14 12:54:27.370586+00'),
  ('18c071d7-d9c2-4474-9af8-e48b3ad9ec69','subscriptions','Subscriptions','Enable subscription-based access (future)',false,'2026-07-14 23:52:56.550000+00'),
  ('8d7a42ea-f8c4-410e-87cb-e4bffe01cbc8','video_uploads','Video Uploads','Allow doctors to upload videos',true,'2026-07-14 12:54:27.370586+00')
ON CONFLICT (id) DO NOTHING;
