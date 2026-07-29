
-- Step 1: Add new enum values (must be committed before use)
DO $$ BEGIN
  ALTER TYPE credit_transaction_type ADD VALUE IF NOT EXISTS 'expiry';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE credit_transaction_type ADD VALUE IF NOT EXISTS 'adjustment';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE credit_transaction_type ADD VALUE IF NOT EXISTS 'grant_super_admin';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE credit_transaction_type ADD VALUE IF NOT EXISTS 'grant_admin';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE credit_transaction_type ADD VALUE IF NOT EXISTS 'transfer';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE activation_code_status ADD VALUE IF NOT EXISTS 'disabled';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE activation_code_status ADD VALUE IF NOT EXISTS 'deleted';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE activation_code_status ADD VALUE IF NOT EXISTS 'reserved';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
