/**
 * subscribeContact.ts — ONE support-contact resolver for every "Subscribe" flow.
 *
 * ── Why this module exists (root cause) ─────────────────────────────────────
 * The Subscribe sheet was implemented TWICE, with two different behaviours:
 *
 *   • Explore (courses list) resolved the contact through `use_default_contact`
 *     — the doctor's profile contacts when the course uses the default, the
 *     course's own columns otherwise — and rendered `SubscribeSheet`.
 *   • Course details rendered the LEGACY `ContactSheet` straight off
 *     `course.whatsapp / course.telegram / course.phone` (the course-LEVEL
 *     columns) and never looked at `use_default_contact` at all. For a course
 *     that uses the doctor's default contacts those columns are irrelevant, so
 *     the sheet showed a stale/incorrect number or nothing ("only a phone number
 *     and another incorrect number"), and `getCourseById()` did not even select
 *     the doctor's contact_* fields.
 *
 * Both screens now call `resolveCourseContact()` here and render the SAME
 * component, so the two flows cannot drift apart again.
 *
 * ── Fallback ────────────────────────────────────────────────────────────────
 * When neither the doctor nor the course exposes a usable contact, the sheet
 * falls back to the Super Admin support contacts (`/support/contact`, the same
 * public list the security screen uses). Contacts are NEVER invented and no
 * number is hardcoded here.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 * `contactUrl()` only ever produces `https://…`, `tel:` or `mailto:`. A stored
 * value can never smuggle another scheme into `Linking.openURL`.
 */

/** Contact channels a Subscribe sheet can offer (Superset of the doctor/course columns). */
export type SubscribeContactKey =
  | 'whatsapp' | 'telegram' | 'phone' | 'email' | 'x' | 'website' | 'facebook' | 'instagram';

export interface SubscribeContact {
  whatsapp?:  string | null;
  telegram?:  string | null;
  phone?:     string | null;
  email?:     string | null;
  x?:         string | null;
  website?:   string | null;
  facebook?:  string | null;
  instagram?: string | null;
}

/** Stable render order (WhatsApp → Telegram → Call → Email → social → website). */
export const SUBSCRIBE_CONTACT_ORDER: SubscribeContactKey[] = [
  'whatsapp', 'telegram', 'phone', 'email', 'x', 'website', 'facebook', 'instagram',
];

const LABELS: Record<SubscribeContactKey, string> = {
  whatsapp:  'WhatsApp',
  telegram:  'Telegram',
  phone:     'Call',
  email:     'Email',
  x:         'X (Twitter)',
  website:   'Website',
  facebook:  'Facebook',
  instagram: 'Instagram',
};

export function contactLabel(key: SubscribeContactKey): string {
  return LABELS[key] ?? key;
}

/** Trim, treat whitespace-only as absent. */
function clean(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return v.length ? v : null;
}

/** A course payload may arrive with the doctor relation as an array (PostgREST) or an object. */
function doctorOf(course: any): any {
  const doc = course?.doctor;
  if (!doc) return null;
  return Array.isArray(doc) ? (doc[0] ?? null) : doc;
}

/**
 * THE course/doctor contact rule (shared by Explore and course details):
 *   use_default_contact !== false → the DOCTOR's profile contacts
 *   use_default_contact === false → the COURSE's own contacts
 * Mirrors the product rule documented on `CourseContactPayload` in lib/api.ts.
 */
export function resolveCourseContact(course: any): SubscribeContact {
  if (!course) return {};
  const useDefault = course.use_default_contact !== false; // null/undefined ⇒ default
  if (useDefault) {
    const doc = doctorOf(course);
    return {
      whatsapp: clean(doc?.contact_whatsapp),
      telegram: clean(doc?.contact_telegram),
      phone:    clean(doc?.contact_phone),
    };
  }
  return {
    whatsapp: clean(course.whatsapp),
    telegram: clean(course.telegram),
    phone:    clean(course.phone),
  };
}

export function hasAnyContact(contact: SubscribeContact | null | undefined): boolean {
  if (!contact) return false;
  return SUBSCRIBE_CONTACT_ORDER.some((key) => !!contactUrl(key, contact[key]));
}

/**
 * Build the ONLY acceptable destination for a stored contact value.
 * Returns null for empty/invalid values so a broken value renders nothing
 * instead of opening a dead or unsafe URL.
 */
export function contactUrl(key: SubscribeContactKey, rawValue: string | null | undefined): string | null {
  const value = clean(rawValue);
  if (!value) return null;

  switch (key) {
    case 'whatsapp': {
      // wa.me takes the international number WITHOUT a leading '+' or zeros.
      const digits = value.replace(/[^\d]/g, '');
      return digits.length >= 6 ? `https://wa.me/${digits}` : null;
    }
    case 'telegram': {
      const direct = httpUrl(value);
      if (direct) return direct;
      const handle = value.replace(/^@/, '').replace(/^(?:t\.me|telegram\.me)\//i, '').replace(/\/+$/, '');
      return /^[A-Za-z0-9_]{3,}$/.test(handle) ? `https://t.me/${handle}` : null;
    }
    case 'phone': {
      const num = value.replace(/[^\d+]/g, '');
      return num.replace(/\D/g, '').length >= 4 ? `tel:${num}` : null;
    }
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? `mailto:${value}` : null;
    case 'x': {
      const direct = httpUrl(value);
      if (direct) return direct;
      const handle = value.replace(/^@/, '').replace(/^(?:x\.com|twitter\.com)\//i, '').replace(/\/+$/, '');
      return /^[A-Za-z0-9_]{2,}$/.test(handle) ? `https://x.com/${handle}` : null;
    }
    case 'facebook': {
      const direct = httpUrl(value);
      if (direct) return direct;
      const handle = value.replace(/^@/, '').replace(/^(?:facebook\.com|fb\.com|fb\.me)\//i, '').replace(/\/+$/, '');
      return handle ? `https://facebook.com/${handle}` : null;
    }
    case 'instagram': {
      const direct = httpUrl(value);
      if (direct) return direct;
      const handle = value.replace(/^@/, '').replace(/^instagram\.com\//i, '').replace(/\/+$/, '');
      return handle ? `https://instagram.com/${handle}` : null;
    }
    case 'website': {
      const direct = httpUrl(value);
      if (direct) return direct;
      const host = value.replace(/^\/+/, '');
      return host.includes('.') ? `https://${host}` : null;
    }
    default:
      return null;
  }
}

/** Only http/https pass through verbatim — never `javascript:`, `data:` or a bare scheme. */
function httpUrl(value: string): string | null {
  return /^https?:\/\/\S+$/i.test(value) ? value : null;
}

/** Map the Super-Admin public support list onto the same key space. */
export function supportPlatformKey(platform: string): SubscribeContactKey | null {
  const p = (platform ?? '').trim().toLowerCase();
  return (SUBSCRIBE_CONTACT_ORDER as string[]).includes(p) ? (p as SubscribeContactKey) : null;
}

/**
 * Safe destination for a backend-built support URL. The public endpoint returns
 * a ready `url`; it is accepted only when it is http(s)/tel/mailto (never
 * trusted blindly, never rewritten).
 */
export function safeSupportUrl(url: string | null | undefined): string | null {
  const v = clean(url);
  if (!v) return null;
  return /^(https?:\/\/\S+|tel:[+\d][\d\s-]*|mailto:\S+@\S+)$/i.test(v) ? v : null;
}
