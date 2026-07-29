-- Add price_egp column (numeric, nullable, default 0)
ALTER TABLE courses ADD COLUMN IF NOT EXISTS price_egp numeric(10,2) DEFAULT 0;

-- Migrate existing credits_required to price_egp (1 credit = 100 EGP)
-- Only migrate where price_egp hasn't been set yet (= 0) and credits_required > 0
UPDATE courses
SET price_egp = credits_required * 100
WHERE credits_required IS NOT NULL
  AND credits_required > 0
  AND (price_egp IS NULL OR price_egp = 0);

-- Add a comment
COMMENT ON COLUMN courses.price_egp IS 'Course price in Egyptian Pounds. 0 = Free.';