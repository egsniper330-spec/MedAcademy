
-- Seed platform currency config into existing system_config table.
-- Stored as JSON so Super Admin can update symbol/code/name/position/decimals
-- without any schema change.
INSERT INTO system_config (key, value)
VALUES (
  'platform_currency',
  '{"name":"Egyptian Pound","code":"EGP","symbol":"ج.م","decimals":0,"position":"after"}'::jsonb
)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = now();

-- Migrate existing credit_price / activation_code_price from USD → EGP
UPDATE system_config
SET value = jsonb_set(value::jsonb, '{currency}', '"EGP"'),
    updated_at = now()
WHERE key IN ('credit_price', 'activation_code_price');
