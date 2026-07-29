
-- Part A: add enum value only (must commit before use)
ALTER TYPE user_status ADD VALUE IF NOT EXISTS 'trashed';
