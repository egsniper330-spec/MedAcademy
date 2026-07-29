import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
