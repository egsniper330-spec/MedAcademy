
-- Per-course doctor revenue price (NULL = inherit doctor's global price)
ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS doctor_revenue_price numeric DEFAULT NULL;

-- Doctor can update revenue price on their own courses
DROP POLICY IF EXISTS courses_doctor_update_revenue ON courses;
CREATE POLICY courses_doctor_update_revenue ON courses
  FOR UPDATE
  USING (doctor_id = auth.uid())
  WITH CHECK (doctor_id = auth.uid());
