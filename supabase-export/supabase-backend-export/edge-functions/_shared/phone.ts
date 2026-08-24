// supabase/functions/_shared/phone.ts
// Shared phone normalization — mirrors src/lib/identifier.ts normalizePhoneE164
// Normalizes to E.164 for Egyptian numbers by default.
// Handles: +201020182886, 01020182886, 201020182886, 00201020182886

export function normalizePhoneE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.replace(/\s|-/g, '').trim();
  if (!raw) return null;

  // Already E.164
  if (/^\+[1-9]\d{6,14}$/.test(raw)) return raw;
  // 00-prefix international
  if (/^00[1-9]\d{6,14}$/.test(raw)) return '+' + raw.slice(2);
  // Egypt: local 01xxxxxxxxx (10 digits after 0)
  if (/^0[1-9]\d{9}$/.test(raw)) return '+20' + raw.slice(1);
  // Egypt: 201xxxxxxxxx (country code without +)
  if (/^20[1-9]\d{9}$/.test(raw)) return '+' + raw;
  // Bare national (9 digits for EG)
  if (/^[1-9]\d{8,9}$/.test(raw)) return '+20' + raw;

  return null;
}
