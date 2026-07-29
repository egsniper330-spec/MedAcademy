
-- Add prefix and max_uses to code_batches
ALTER TABLE code_batches
  ADD COLUMN IF NOT EXISTS prefix   text,
  ADD COLUMN IF NOT EXISTS max_uses integer;

-- Add max_uses to activation_codes (per-code redemption limit)
ALTER TABLE activation_codes
  ADD COLUMN IF NOT EXISTS max_uses    integer,
  ADD COLUMN IF NOT EXISTS uses_count  integer NOT NULL DEFAULT 0;
