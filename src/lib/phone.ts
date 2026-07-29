/**
 * lib/phone.ts — E.164 phone system: country data, parsing, display.
 *
 * Design:
 *  - STORE:   always E.164 (+201020182886)
 *  - DISPLAY: national format per country (01020182886 for Egypt)
 *  - INPUT:   country picker + national number field; combine on submit
 */

// ─── Country catalogue ────────────────────────────────────────────────────────
// Add more countries here; no code change required elsewhere.

export interface Country {
  /** ISO 3166-1 alpha-2 code */
  iso: string;
  /** Human-readable name */
  name: string;
  /** ITU calling code with + prefix */
  callingCode: string;
  /** Flag emoji */
  flag: string;
  /** Regex that the national portion (digits only, no leading 0) must match */
  nationalPattern: RegExp;
  /** Whether local numbers are written with a leading 0 that must be stripped */
  hasLeadingZero: boolean;
}

export const COUNTRIES: Country[] = [
  {
    iso: 'EG', name: 'Egypt', callingCode: '+20', flag: '🇪🇬',
    // Egyptian mobiles: 010, 011, 012, 015 → 10 digits after stripping leading 0
    nationalPattern: /^[1-9][0-9]{8,9}$/,
    hasLeadingZero: true,
  },
  {
    iso: 'SA', name: 'Saudi Arabia', callingCode: '+966', flag: '🇸🇦',
    nationalPattern: /^[1-9][0-9]{8}$/,
    hasLeadingZero: false,
  },
  {
    iso: 'AE', name: 'UAE', callingCode: '+971', flag: '🇦🇪',
    nationalPattern: /^[1-9][0-9]{7,8}$/,
    hasLeadingZero: false,
  },
  {
    iso: 'JO', name: 'Jordan', callingCode: '+962', flag: '🇯🇴',
    nationalPattern: /^[1-9][0-9]{7,8}$/,
    hasLeadingZero: false,
  },
  {
    iso: 'KW', name: 'Kuwait', callingCode: '+965', flag: '🇰🇼',
    nationalPattern: /^[1-9][0-9]{7}$/,
    hasLeadingZero: false,
  },
  {
    iso: 'QA', name: 'Qatar', callingCode: '+974', flag: '🇶🇦',
    nationalPattern: /^[1-9][0-9]{7}$/,
    hasLeadingZero: false,
  },
  {
    iso: 'LB', name: 'Lebanon', callingCode: '+961', flag: '🇱🇧',
    nationalPattern: /^[1-9][0-9]{6,7}$/,
    hasLeadingZero: false,
  },
  {
    iso: 'LY', name: 'Libya', callingCode: '+218', flag: '🇱🇾',
    nationalPattern: /^[1-9][0-9]{8}$/,
    hasLeadingZero: false,
  },
  {
    iso: 'SD', name: 'Sudan', callingCode: '+249', flag: '🇸🇩',
    nationalPattern: /^[1-9][0-9]{8}$/,
    hasLeadingZero: false,
  },
  {
    iso: 'IQ', name: 'Iraq', callingCode: '+964', flag: '🇮🇶',
    nationalPattern: /^[1-9][0-9]{8,9}$/,
    hasLeadingZero: false,
  },
  {
    iso: 'SY', name: 'Syria', callingCode: '+963', flag: '🇸🇾',
    nationalPattern: /^[1-9][0-9]{7,8}$/,
    hasLeadingZero: false,
  },
  {
    iso: 'MA', name: 'Morocco', callingCode: '+212', flag: '🇲🇦',
    nationalPattern: /^[1-9][0-9]{8}$/,
    hasLeadingZero: false,
  },
  {
    iso: 'TN', name: 'Tunisia', callingCode: '+216', flag: '🇹🇳',
    nationalPattern: /^[1-9][0-9]{7}$/,
    hasLeadingZero: false,
  },
  {
    iso: 'DZ', name: 'Algeria', callingCode: '+213', flag: '🇩🇿',
    nationalPattern: /^[1-9][0-9]{8}$/,
    hasLeadingZero: false,
  },
  {
    iso: 'GB', name: 'United Kingdom', callingCode: '+44', flag: '🇬🇧',
    nationalPattern: /^[1-9][0-9]{9}$/,
    hasLeadingZero: true,
  },
  {
    iso: 'US', name: 'United States', callingCode: '+1', flag: '🇺🇸',
    nationalPattern: /^[2-9][0-9]{9}$/,
    hasLeadingZero: false,
  },
  {
    iso: 'DE', name: 'Germany', callingCode: '+49', flag: '🇩🇪',
    nationalPattern: /^[1-9][0-9]{6,12}$/,
    hasLeadingZero: false,
  },
  {
    iso: 'FR', name: 'France', callingCode: '+33', flag: '🇫🇷',
    nationalPattern: /^[1-9][0-9]{8}$/,
    hasLeadingZero: false,
  },
];

export const DEFAULT_COUNTRY = COUNTRIES[0]; // Egypt

/** Find a Country by ISO code (case-insensitive). */
export function findCountryByIso(iso: string): Country | undefined {
  return COUNTRIES.find(c => c.iso.toLowerCase() === iso.toLowerCase());
}

/** Find a Country by its calling code (e.g. '+20'). Returns first match. */
export function findCountryByCallingCode(code: string): Country | undefined {
  const norm = code.startsWith('+') ? code : '+' + code;
  // Sort by code length desc so +966 wins over +9 etc.
  return [...COUNTRIES]
    .sort((a, b) => b.callingCode.length - a.callingCode.length)
    .find(c => c.callingCode === norm);
}

// ─── Building E.164 from country + national input ────────────────────────────

/**
 * Combine a Country record + a national number string (as the user typed it)
 * into an E.164 string.
 *
 * Strips any leading 0 if the country has `hasLeadingZero`.
 * Returns null if the result fails the country's nationalPattern.
 */
export function buildE164(country: Country, nationalInput: string): string | null {
  let digits = nationalInput.replace(/[\s\-\.\(\)]/g, '').replace(/\D/g, '');
  // Strip leading 0 for countries where the national display has one
  if (country.hasLeadingZero && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  if (!country.nationalPattern.test(digits)) return null;
  return country.callingCode + digits;
}

/**
 * Validate a national number string for a given country.
 * Returns an error message, or null if valid.
 */
export function validateNationalNumber(country: Country, input: string): string | null {
  const digits = input.replace(/[\s\-\.\(\)]/g, '').replace(/\D/g, '');
  const stripped = country.hasLeadingZero && digits.startsWith('0') ? digits.slice(1) : digits;
  if (!stripped) return 'Phone number is required.';
  if (!country.nationalPattern.test(stripped)) {
    return `Invalid ${country.name} phone number.`;
  }
  return null;
}

// ─── Display helpers ─────────────────────────────────────────────────────────

/**
 * Format an E.164 number for display in the national format of its country.
 *
 * +201020182886  →  01020182886  (Egypt)
 * +441234567890  →  01234567890  (UK)
 * +12125551234   →  2125551234   (US — no leading 0)
 */
export function displayPhoneNational(e164: string | null | undefined): string {
  if (!e164) return '';
  // Find longest matching calling code
  const country = [...COUNTRIES]
    .sort((a, b) => b.callingCode.length - a.callingCode.length)
    .find(c => e164.startsWith(c.callingCode));
  if (!country) return e164; // unknown country — return as-is
  const national = e164.slice(country.callingCode.length);
  return country.hasLeadingZero ? '0' + national : national;
}

/**
 * Parse an E.164 number and return the matching Country + national portion.
 * Returns null if no known country matches.
 */
export function parseE164(e164: string): { country: Country; national: string } | null {
  const country = [...COUNTRIES]
    .sort((a, b) => b.callingCode.length - a.callingCode.length)
    .find(c => e164.startsWith(c.callingCode));
  if (!country) return null;
  const national = e164.slice(country.callingCode.length);
  return { country, national: country.hasLeadingZero ? '0' + national : national };
}
