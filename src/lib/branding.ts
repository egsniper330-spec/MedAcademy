/**
 * BRANDING — platform identity made Super-Admin-configurable.
 *
 * ─── What is server-configurable ─────────────────────────────────────────────
 *   app_name (UI display name), logo/splash URLs, primary & secondary colours,
 *   contact/support email, phone, website and social links.
 *
 * ─── What stays BUILD-TIME (on purpose) ──────────────────────────────────────
 *   The native application name shown under the icon, the bundle identifier,
 *   package name, URL schemes, signing identities and the API domain are part
 *   of the compiled binary / store record. Changing them at runtime is
 *   impossible on iOS and unsafe on Android, so they are intentionally NOT part
 *   of this feature. (`app_name` here is the name the APP RENDERS — headers,
 *   landing screen, About, contact — not the OS-level label.)
 *
 * ─── Failure behaviour ───────────────────────────────────────────────────────
 *   Reads never throw: a failed request falls back to `DEFAULT_BRANDING`
 *   (identical to the server's own defaults), so no screen can break or render
 *   "unavailable" because branding could not be fetched. Cached with a short
 *   TTL and invalidated after a save.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/client/backendClient';

/**
 * One entry of the server-managed Contact Us link list.
 *
 * `platform` is a stable machine key (not display text), so new link types can
 * be added server-side without migrating stored rows. `url` is the RAW
 * destination: http(s) for web platforms, a bare email address for `email`, a
 * bare phone number for `phone` — see contactLinkHref() for how it is opened.
 */
export type ContactLink = {
  platform: string;
  label: string;
  url: string;
  enabled: boolean;
};

/** Supported presets (mirror of PlatformController::CONTACT_LINK_PLATFORMS). */
export const CONTACT_LINK_PRESETS: Array<{ key: string; label: string }> = [
  { key: 'whatsapp',  label: 'WhatsApp' },
  { key: 'telegram',  label: 'Telegram' },
  { key: 'facebook',  label: 'Facebook' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'twitter',   label: 'X / Twitter' },
  { key: 'website',   label: 'Website' },
  { key: 'email',     label: 'Email' },
  { key: 'phone',     label: 'Phone' },
];

/**
 * Parse a stored contact_links value (array, or JSON string from the DB) into
 * a safe list. NEVER throws and silently drops malformed entries so a bad row
 * can never break the Contact Us screen.
 */
export function parseContactLinks(raw: unknown): ContactLink[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  const out: ContactLink[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const platform = typeof row.platform === 'string' ? row.platform.toLowerCase().trim() : '';
    const url      = typeof row.url === 'string' ? row.url.trim() : '';
    if (platform === '' || url === '') continue;
    const label = typeof row.label === 'string' && row.label.trim() !== ''
      ? row.label.trim()
      : platform.charAt(0).toUpperCase() + platform.slice(1);
    out.push({
      platform,
      label,
      url,
      enabled: row.enabled === undefined ? true : !!row.enabled,
    });
  }
  return out;
}

/**
 * Build the URL handed to Linking.openURL(). `mailto:`/`tel:` are added here,
 * NOT typed by the admin, so a `javascript:`/`data:` destination can never be
 * produced by the editor.
 */
export function contactLinkHref(link: ContactLink): string {
  if (link.platform === 'email') {
    return /^mailto:/i.test(link.url) ? link.url : `mailto:${link.url}`;
  }
  if (link.platform === 'phone') {
    return /^tel:/i.test(link.url) ? link.url : `tel:${link.url.replace(/[^0-9+]/g, '')}`;
  }
  return link.url;
}

export type Branding = {
  id?: string;
  app_name: string;
  logo_url: string;
  splash_logo_url: string;
  primary_color: string;
  secondary_color: string;
  contact_email: string;
  contact_phone: string;
  support_email: string;
  website_url: string;
  facebook_url: string;
  instagram_url: string;
  youtube_url: string;
  telegram_url: string;
  whatsapp_url: string;
  twitter_url: string;
  linkedin_url: string;
  contact_links: ContactLink[];
  updated_at?: string | null;
};

/** Mirror of PlatformController::BRANDING_DEFAULTS. */
export const DEFAULT_BRANDING: Branding = {
  app_name: 'MedAcademy',
  logo_url: '',
  splash_logo_url: '',
  primary_color: '#1565C0',
  secondary_color: '#0D47A1',
  contact_email: 'support@medacademy.app',
  contact_phone: '',
  support_email: 'support@medacademy.app',
  website_url: '',
  facebook_url: '',
  instagram_url: '',
  youtube_url: '',
  telegram_url: '',
  whatsapp_url: '',
  twitter_url: '',
  linkedin_url: '',
  contact_links: [],
};

const TTL_MS = 60_000;

let cache: Branding | null = null;
let cacheAt = 0;

/** Fill missing/blank fields from the defaults so consumers always render. */
export function normalizeBranding(raw: unknown): Branding {
  const row = (raw ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_BRANDING } as Branding;
  if (typeof row.id === 'string') out.id = row.id;
  if ('updated_at' in row) out.updated_at = (row.updated_at as string | null) ?? null;
  for (const key of Object.keys(DEFAULT_BRANDING) as Array<keyof Branding>) {
    const value = row[key as string];
    if (typeof value === 'string' && value.trim() !== '') {
      (out as Record<string, unknown>)[key as string] = value;
    }
  }
  // Structured list: arrives as an array (or a JSON string straight from the
  // DB). Parsed defensively so one malformed entry cannot break a screen.
  out.contact_links = parseContactLinks(row.contact_links);
  return out;
}

export function cachedBranding(): Branding {
  return cache ?? DEFAULT_BRANDING;
}

/** Never throws — falls back to the built-in defaults on any failure. */
export async function fetchBrandingSafe(force = false): Promise<Branding> {
  if (!force && cache !== null && (Date.now() - cacheAt) < TTL_MS) {
    return cache;
  }
  try {
    const { data, error } = await apiFetch<{ branding: unknown }>('/platform/branding');
    if (!error && data?.branding) {
      cache = normalizeBranding(data.branding);
      cacheAt = Date.now();
      return cache;
    }
  } catch {
    // keep the previous/default identity — branding must never break a screen
  }
  return cachedBranding();
}

export function invalidateBranding(): void {
  cache = null;
  cacheAt = 0;
}

/** React hook for UI consumers (landing, About, Contact, Branding screen). */
export function useBranding(): Branding {
  const [branding, setBranding] = useState<Branding>(cachedBranding);
  useEffect(() => {
    let alive = true;
    void fetchBrandingSafe().then((next) => { if (alive) setBranding(next); });
    return () => { alive = false; };
  }, []);
  return branding;
}
