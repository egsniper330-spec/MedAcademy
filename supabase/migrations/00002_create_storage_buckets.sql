
-- Storage Buckets
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES
  ('avatars', 'avatars', true, 5242880, ARRAY['image/jpeg','image/png','image/webp']),
  ('course-images', 'course-images', true, 5242880, ARRAY['image/jpeg','image/png','image/webp']),
  ('lesson-pdfs', 'lesson-pdfs', false, 52428800, ARRAY['application/pdf']),
  ('app-assets', 'app-assets', true, 10485760, ARRAY['image/jpeg','image/png','image/webp','image/svg+xml']);

-- Storage RLS Policies
CREATE POLICY "avatars_select" ON storage.objects FOR SELECT USING (bucket_id = 'avatars');
CREATE POLICY "avatars_insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "avatars_update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "avatars_delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "course_images_select" ON storage.objects FOR SELECT USING (bucket_id = 'course-images');
CREATE POLICY "course_images_insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'course-images');
CREATE POLICY "course_images_update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'course-images');
CREATE POLICY "course_images_delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'course-images');

CREATE POLICY "lesson_pdfs_select" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'lesson-pdfs');
CREATE POLICY "lesson_pdfs_insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'lesson-pdfs');
CREATE POLICY "lesson_pdfs_delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'lesson-pdfs');

CREATE POLICY "app_assets_select" ON storage.objects FOR SELECT USING (bucket_id = 'app-assets');
CREATE POLICY "app_assets_insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'app-assets');
