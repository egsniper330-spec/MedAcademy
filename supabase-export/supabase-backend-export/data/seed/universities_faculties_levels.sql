-- MedAcademy Seed Data: universities (1), faculties (3), academic_levels (15)
INSERT INTO public.universities (id, name, is_active, created_at) VALUES
  ('fede8d1f-47e3-4053-9793-7d15b151e0ed','Horus University',true,'2026-07-14 14:52:43.157443+00')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.faculties (id, university_id, name, is_active) VALUES
  ('720d0ff6-63f6-4558-9000-a4eacaa6d73b','fede8d1f-47e3-4053-9793-7d15b151e0ed','Engineering',true),
  ('53fbff51-1d71-4601-a0e0-e26e3b5d2ff9','fede8d1f-47e3-4053-9793-7d15b151e0ed','Medicine',true),
  ('440f6568-313d-4249-bb41-c16316ae8bdf','fede8d1f-47e3-4053-9793-7d15b151e0ed','Pharmacy',true)
ON CONFLICT (id) DO NOTHING;

-- Pharmacy levels
INSERT INTO public.academic_levels (id, faculty_id, name, display_order, is_active) VALUES
  ('698911e8-aaa9-4736-b65f-95a05280a9f1','440f6568-313d-4249-bb41-c16316ae8bdf','Level One',1,true),
  ('45b45bc8-6ad0-4a2a-a3d4-e02fcb26d2ce','440f6568-313d-4249-bb41-c16316ae8bdf','Level Two',2,true),
  ('515dc724-2615-4b5b-932a-879376e833e9','440f6568-313d-4249-bb41-c16316ae8bdf','Level Three',3,true),
  ('9a19086f-6897-48e0-950f-1682ec8a07e4','440f6568-313d-4249-bb41-c16316ae8bdf','Level Four',4,true),
  ('e2f41154-37c4-4d1d-ad3f-d1229ac6539a','440f6568-313d-4249-bb41-c16316ae8bdf','Level Five',5,true),
-- Medicine levels
  ('a1c2d596-b703-4398-a784-dbd8bf03cc42','53fbff51-1d71-4601-a0e0-e26e3b5d2ff9','Level One',1,true),
  ('350e7da5-fb81-4999-ae2b-c9f47056d29e','53fbff51-1d71-4601-a0e0-e26e3b5d2ff9','Level Two',2,true),
  ('3284e607-57e6-4945-a984-d96baf616a7d','53fbff51-1d71-4601-a0e0-e26e3b5d2ff9','Level Three',3,true),
  ('cccf6d23-5aae-4d96-8573-bce66f26d9d0','53fbff51-1d71-4601-a0e0-e26e3b5d2ff9','Level Four',4,true),
  ('13a60664-6230-43af-a7a1-6ff749f53c01','53fbff51-1d71-4601-a0e0-e26e3b5d2ff9','Level Five',5,true),
-- Engineering levels
  ('7284f26b-6bdc-4976-af76-2cb89893c8cf','720d0ff6-63f6-4558-9000-a4eacaa6d73b','Level One',1,true),
  ('8bf56b8d-b404-4d85-bab4-6be9f7051216','720d0ff6-63f6-4558-9000-a4eacaa6d73b','Level Two',2,true),
  ('4de73097-4011-4840-8389-4ebf64096d1e','720d0ff6-63f6-4558-9000-a4eacaa6d73b','Level Three',3,true),
  ('91441d78-3932-4004-9d71-6d37fc025dcb','720d0ff6-63f6-4558-9000-a4eacaa6d73b','Level Four',4,true),
  ('0623b8ae-d921-445e-8194-0369e0d7f0cc','720d0ff6-63f6-4558-9000-a4eacaa6d73b','Level Five',5,true)
ON CONFLICT (id) DO NOTHING;
