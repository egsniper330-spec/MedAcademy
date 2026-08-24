-- MedAcademy Seed Data: categories (12 rows)
INSERT INTO public.categories (id, name, created_at) VALUES
  ('6b9740a6-c276-4081-ad3f-3e5a75622090','Anatomy','2026-07-14 00:22:45.022650+00'),
  ('924e7f51-7915-4ea6-9faf-e3aa79587c71','Cardiology','2026-07-14 00:22:45.022650+00'),
  ('0586d0d2-72ab-4f8b-b025-390c5cd1e275','Emergency Medicine','2026-07-14 00:22:45.022650+00'),
  ('251fd950-20ab-4d69-8b58-f9950e0955b1','Internal Medicine','2026-07-14 00:22:45.022650+00'),
  ('7b930368-7ea8-44fc-babe-54e3b538c1dd','Obstetrics & Gynecology','2026-07-14 00:22:45.022650+00'),
  ('9f644da7-80de-42ba-97e2-833d71f414f1','Pathology','2026-07-14 00:22:45.022650+00'),
  ('a43c632f-5b9f-457b-a964-65ef45243f2b','Pediatrics','2026-07-14 00:22:45.022650+00'),
  ('60f87a0b-b509-42db-a363-dfbb0633ffd3','Pharmacology','2026-07-14 00:22:45.022650+00'),
  ('193e5b88-91ca-4545-96a1-04c36e5f51ca','Physiology','2026-07-14 00:22:45.022650+00'),
  ('7bbc008d-dd85-4021-9fd1-3e13aae8e5f8','Psychiatry','2026-07-14 00:22:45.022650+00'),
  ('2969d08a-468c-4639-b531-1a183b677739','Radiology','2026-07-14 00:22:45.022650+00'),
  ('a1806811-55e5-4a5e-8bff-cbeafacc031b','Surgery','2026-07-14 00:22:45.022650+00')
ON CONFLICT (id) DO NOTHING;
