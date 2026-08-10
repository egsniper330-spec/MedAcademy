import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ── English-digit enforcement ─────────────────────────────────────────────────
// Arabic-locale Android/iOS devices render toLocaleString() / Intl.NumberFormat
// with Eastern Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) instead of Latin digits (0-9).
// Every numeric display in the app MUST go through one of these helpers so the
// device locale can never bleed through.

const EN = 'en-US' as const;

/**
 * Convert any string that may contain Arabic-Indic digits (٠-٩) to ASCII (0-9).
 * Safe to call on already-ASCII strings — it's a no-op in that case.
 */
export function toEnglishDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/**
 * Format an integer with thousands separators using English digits.
 * fmtInt(12500) → "12,500"
 */
export function fmtInt(n: number): string {
  return n.toLocaleString(EN, { maximumFractionDigits: 0 });
}

/**
 * Format a decimal number with up to `decimals` fraction digits using English digits.
 * fmtNum(9.5, 2) → "9.50"
 */
export function fmtNum(n: number, decimals = 2): string {
  return n.toLocaleString(EN, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/**
 * Format a Date or ISO string as a short date using English digits.
 * fmtDate('2024-03-15') → "Mar 15, 2024"
 */
export function fmtDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString(EN, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Format a Date or ISO string as a short date (no year) using English digits.
 * fmtDateShort('2024-03-15') → "Mar 15"
 */
export function fmtDateShort(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString(EN, { month: 'short', day: 'numeric' });
}

/**
 * Format a Date or ISO string as "DD Mon YYYY" (en-GB style) using English digits.
 * fmtDateGB('2024-03-15') → "15 Mar 2024"
 */
export function fmtDateGB(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString(EN, { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Format a Date or ISO string as date + time using English digits.
 * fmtDateTime('2024-03-15T14:30:00') → "Mar 15, 2024, 02:30 PM"
 */
export function fmtDateTime(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString(EN, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/**
 * Format a Date or ISO string as "DD Mon YYYY  HH:MM:SS AM/PM" using English digits.
 * fmtDateTimeGB('2024-03-15T14:30:00') → "15 Mar 2024  02:30:00 PM"
 */
export function fmtDateTimeGB(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const datePart = date.toLocaleDateString(EN, { day: '2-digit', month: 'short', year: 'numeric' });
  const timePart = date.toLocaleTimeString(EN, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  return `${datePart}  ${timePart}`;
}

/**
 * Format a time as "HH:MM AM/PM" using English digits.
 * fmtTime(new Date()) → "02:30 PM"
 */
export function fmtTime(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleTimeString(EN, { hour: '2-digit', minute: '2-digit', hour12: true });
}

/**
 * Format a time with seconds as "HH:MM:SS AM/PM" using English digits.
 */
export function fmtTimeSec(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleTimeString(EN, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
}

// Honorific prefixes to strip before extracting the first name.
const HONORIFIC_RE = /^(dr\.?|doctor|prof\.?|professor|mr\.?|mrs\.?|ms\.?)\s+/i;

/**
 * Returns the user's first name from a full_name string.
 * - Strips common honorific prefixes (Dr., Prof., Mr., Mrs., Ms., …)
 * - Trims leading/trailing whitespace
 * - Returns only the first remaining word
 * - Returns '' if the input is empty or only contained a prefix
 *
 * Examples:
 *   "Ahmed Abdelfattah"    → "Ahmed"
 *   "Dr. Ahmed Ali"        → "Ahmed"
 *   "Prof. Mohamed Salah"  → "Mohamed"
 *   "Ahmed"                → "Ahmed"
 *   ""  / null / undefined → ""
 */
export function getFirstName(fullName?: string | null): string {
  if (!fullName) return '';
  const stripped = fullName.trim().replace(HONORIFIC_RE, '').trim();
  return stripped.split(/\s+/)[0] ?? '';
}
