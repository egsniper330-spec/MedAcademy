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
