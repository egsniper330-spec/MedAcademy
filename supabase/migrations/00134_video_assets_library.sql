
-- ── video_assets: one row per physical VdoCipher upload ──────────────────────
CREATE TABLE IF NOT EXISTS video_assets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id           uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  provider_video_id   text NOT NULL,
  title               text NOT NULL DEFAULT '',
  duration_seconds    integer,
  file_size_bytes     bigint,
  thumbnail_url       text,
  status              text NOT NULL DEFAULT 'processing'
                        CHECK (status IN ('processing','ready','failed','missing')),
  upload_id           uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS video_assets_doctor_provider_uniq
  ON video_assets (doctor_id, provider_video_id);

CREATE INDEX IF NOT EXISTS video_assets_doctor_idx ON video_assets (doctor_id);

-- ── Add video_asset_id FK to lessons ─────────────────────────────────────────
ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS video_asset_id uuid REFERENCES video_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS lessons_video_asset_id_idx ON lessons (video_asset_id);

-- ── updated_at trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS video_assets_updated_at ON video_assets;
CREATE TRIGGER video_assets_updated_at
  BEFORE UPDATE ON video_assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE video_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "video_assets_select" ON video_assets FOR SELECT
  USING (
    doctor_id = auth.uid()
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','super_admin'))
  );

CREATE POLICY "video_assets_insert" ON video_assets FOR INSERT
  WITH CHECK (
    doctor_id = auth.uid()
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','super_admin'))
  );

CREATE POLICY "video_assets_update" ON video_assets FOR UPDATE
  USING (
    doctor_id = auth.uid()
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','super_admin'))
  );

CREATE POLICY "video_assets_delete" ON video_assets FOR DELETE
  USING (
    doctor_id = auth.uid()
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','super_admin'))
  );

-- ── Helper: usage of an asset across lessons ─────────────────────────────────
CREATE OR REPLACE FUNCTION get_video_asset_usage(p_asset_id uuid)
RETURNS TABLE (
  lesson_id    uuid,
  lesson_title text,
  course_id    uuid,
  course_title text
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT l.id, l.title, c.id, c.title
  FROM lessons l
  JOIN courses c ON c.id = l.course_id
  WHERE l.video_asset_id = p_asset_id;
$$;

-- ── Backfill: insert one asset per distinct (doctor, provider_video_id) ───────
INSERT INTO video_assets (doctor_id, provider_video_id, title, duration_seconds, thumbnail_url, status)
SELECT DISTINCT
  c.doctor_id,
  l.video_id,
  COALESCE(l.video_title, l.title, 'Untitled Video'),
  l.video_duration_seconds,
  l.video_thumbnail_url,
  CASE
    WHEN l.video_status = 'ready'         THEN 'ready'
    WHEN l.video_status = 'failed'        THEN 'failed'
    WHEN l.video_status = 'video_missing' THEN 'missing'
    ELSE 'processing'
  END
FROM lessons l
JOIN courses c ON c.id = l.course_id
WHERE l.video_id IS NOT NULL
  AND l.video_id <> ''
  AND l.video_type = 'vdocipher'
ON CONFLICT (doctor_id, provider_video_id) DO NOTHING;

-- ── Wire backfilled assets onto lesson rows ───────────────────────────────────
UPDATE lessons
SET video_asset_id = va.id
FROM video_assets va,
     courses c
WHERE lessons.course_id = c.id
  AND c.doctor_id = va.doctor_id
  AND va.provider_video_id = lessons.video_id
  AND lessons.video_asset_id IS NULL;
