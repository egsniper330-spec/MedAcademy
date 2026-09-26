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
import {
  MessageCircle, Send, Users, Camera, Hash, Globe, Mail, Phone, Link2,
} from 'lucide-react-native';

// ─── Platform registry (single source of truth) ─────────────────────────────
// One normalized definition per supported contact-link platform. The CMS
// editor, the user-facing Contact Us screen, validation and icon selection all
// read from this registry — platform names/labels are never duplicated in
// unrelated files. `icon` comes from lucide-react-native (already a project
// dependency — no new icon package added).
export type PlatformIconComponent = React.ComponentType<{ size?: number | string; color?: string; strokeWidth?: number | string }>;

export interface PlatformDef {
  key: string;
  /** Default/fallback display label. */
  label: string;
  icon: PlatformIconComponent;
  /** Brand color used for the icon badge on the Contact Us screen. */
  color: string;
  /** Friendly one-liner shown instead of the raw destination (privacy contract). */
  description: string;
}

export const CONTACT_PLATFORMS: Record<string, PlatformDef> = {
  whatsapp:  { key: 'whatsapp',  label: 'WhatsApp',  icon: MessageCircle, color: '#16A34A', description: 'Chat with us on WhatsApp.' },
  telegram:  { key: 'telegram',  label: 'Telegram',  icon: Send,          color: '#2DA8FF', description: 'Message us on Telegram.' },
  facebook:  { key: 'facebook',  label: 'Facebook',  icon: Users,         color: '#1877F2', description: 'Visit our Facebook page.' },
  instagram: { key: 'instagram', label: 'Instagram', icon: Camera,        color: '#E1306C', description: 'Follow us on Instagram.' },
  twitter:   { key: 'twitter',   label: 'X / Twitter', icon: Hash,       color: '#0F172A', description: 'Follow us on X.' },
  website:   { key: 'website',   label: 'Website',   icon: Globe,         color: '#6B7280', description: 'Visit our official website.' },
  email:     { key: 'email',     label: 'Email',     icon: Mail,          color: '#DC2626', description: 'Send us an email.' },
  phone:     { key: 'phone',     label: 'Phone',     icon: Phone,         color: '#0EA5E9', description: 'Call this number.' },
};

export const CONTACT_LINK_PRESETS: Array<{ key: string; label: string }> =
  Object.values(CONTACT_PLATFORMS).map(({ key, label }) => ({ key, label }));

/** Stable preset list for the CMS editor (keeps the registry the only list). */
export const CONTACT_PLATFORM_KEYS = Object.keys(CONTACT_PLATFORMS);

/**
 * Centralized platform icon/label resolution. Unknown/legacy keys degrade to a
 * neutral link icon + the capitalized key — never a crash, never a blank row.
 */
export function platformIcon(platform: string): PlatformIconComponent {
  return CONTACT_PLATFORMS[platform]?.icon ?? Link2;
}

export function platformDef(platform: string): PlatformDef {
  return (
    CONTACT_PLATFORMS[platform] ?? {
      key: platform,
      label: platform.charAt(0).toUpperCase() + platform.slice(1),
      icon: Link2,
      color: '#6B7280',
      description: 'Tap to open.',
    }
  );
}

/**
 * Is this destination safe to hand to Linking.openURL()?
 *
 * Allowed: http(s): for web platforms, mailto: for email, tel: for phone.
 * Everything else — javascript:, data:, file:, intent:, unknown schemes — is
 * refused so a stored CMS value can never execute or deep-link into anything
 * unintended. (mailto:/tel: are ADDED client-side by contactLinkHref(); an
 * admin never types a scheme.)
 */
export function isSafeContactHref(href: string): boolean {
  return /^(https?:\/\/|mailto:|tel:)/i.test(href);
}

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

/**
 * Outcome of a branding fetch — lets UI distinguish a real server failure
 * (→ error state with Retry) from "no data" (→ defaults/empty state), so no
 * screen can ever hang on a spinner or mislabel a network problem as content.
 */
export type BrandingFetchStatus = 'ok' | 'error';

export type BrandingFetchResult = {
  branding: Branding;
  status: BrandingFetchStatus;
};

/**
 * Fetch branding. NEVER throws. On failure returns the last cached (or
 * default) branding with status 'error' so the caller can show a retry state
 * — the values remain renderable either way.
 */
export async function fetchBrandingSafe(force = false): Promise<BrandingFetchResult> {
  if (!force && cache !== null && (Date.now() - cacheAt) < TTL_MS) {
    return { branding: cache, status: 'ok' };
  }
  try {
    const { data, error } = await apiFetch<{ branding: unknown }>('/platform/branding');
    if (!error && data?.branding) {
      cache = normalizeBranding(data.branding);
      cacheAt = Date.now();
      return { branding: cache, status: 'ok' };
    }
    // A structured API error (4xx/5xx with body) — server reachable, request failed.
    return { branding: cachedBranding(), status: 'error' };
  } catch {
    // keep the previous/default identity — branding must never break a screen
    return { branding: cachedBranding(), status: 'error' };
  }
}

export function invalidateBranding(): void {
  cache = null;
  cacheAt = 0;
}

/**
 * React hook for UI consumers (landing, About, Contact, Branding screen).
 *
 * Returns the branding object plus a fetch status so callers can render an
 * error+retry state instead of silently showing defaults. `refresh()` forces
 * a re-fetch (the Retry action). The branding value ALWAYS stays renderable —
 * a failure falls back to cached/defaults, never an exception.
 */
export function useBranding(): { branding: Branding; status: BrandingFetchStatus; refresh: () => void } {
  const [branding, setBranding] = useState<Branding>(cachedBranding);
  const [status, setStatus] = useState<BrandingFetchStatus>('ok');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    void fetchBrandingSafe(tick > 0).then((next) => {
      if (!alive) return;
      setBranding(next.branding);
      setStatus(next.status);
    });
    return () => { alive = false; };
  }, [tick]);
  return {
    branding,
    status,
    refresh: () => setTick((t) => t + 1),
  };
}
