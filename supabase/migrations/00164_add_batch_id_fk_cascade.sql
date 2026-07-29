
-- Add FK from activation_codes.batch_id → code_batches(id) with ON DELETE CASCADE.
-- This ensures DB-level cascade as defense-in-depth (EF will still delete codes
-- explicitly first, but if anything bypasses the EF this constraint cleans up).
ALTER TABLE public.activation_codes
  ADD CONSTRAINT activation_codes_batch_id_fkey
  FOREIGN KEY (batch_id)
  REFERENCES public.code_batches(id)
  ON DELETE CASCADE;
