/**
 * CMS CONTENT — server-managed informational / legal pages.
 *
 * ─── Content format (deliberately small and safe) ────────────────────────────
 * Page bodies are PLAIN TEXT. There is no HTML, no markdown engine and no code
 * execution anywhere in this path — a stored body can never inject markup or
 * script into the app. The only structure honoured is:
 *
 *   "## Heading"  (or "# Heading")   → a section heading
 *   any other non-empty line         → a paragraph
 *   empty line                       → paragraph separator
 *
 * ─── Fallback contract ───────────────────────────────────────────────────────
 * An EMPTY stored body means "render the text bundled in the app". That is why
 * seeding never replaces the published Terms/Privacy copy with a stub, and why
 * clearing the body in the CMS screen restores the built-in text. A failed or
 * slow request also resolves to the built-in text — app startup and screen
 * rendering never depend on CMS availability.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/client/backendClient';

export type CmsSection = { heading: string; body: string };
export type CmsPage = {
  key: string;
  title: string;
  content: string;
  published: boolean;
  using_builtin: boolean;
};

const TTL_MS = 60_000;

let cache: CmsPage[] | null = null;
let cacheAt = 0;
let inflight: Promise<CmsPage[]> | null = null;

/** Parse a stored body into sections. Returns [] for blank/whitespace bodies. */
export function parseCmsBody(content: string): CmsSection[] {
  const text = typeof content === 'string' ? content.replace(/\r\n/g, '\n') : '';
  if (text.trim() === '') return [];

  const sections: CmsSection[] = [];
  let heading = '';
  let paragraph: string[] = [];

  const flush = () => {
    const body = paragraph.join('\n').trim();
    if (body !== '' || heading !== '') {
      sections.push({ heading, body });
    }
    paragraph = [];
    heading = '';
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const headingMatch = /^#{1,3}\s+(.*)$/.exec(line);
    if (headingMatch) {
      flush();
      heading = headingMatch[1].trim();
      continue;
    }
    if (line === '') {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return sections;
}

/** Never throws — resolves to [] (callers then use their built-in text). */
export async function fetchCmsPages(force = false): Promise<CmsPage[]> {
  if (!force && cache !== null && (Date.now() - cacheAt) < TTL_MS) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const { data, error } = await apiFetch<{ pages: CmsPage[] }>('/platform/pages');
      if (!error && Array.isArray(data?.pages)) {
        cache = data.pages.filter((p) => p && typeof p.key === 'string');
        cacheAt = Date.now();
      }
    } catch {
      // keep the previous content / built-in fallback
    } finally {
      inflight = null;
    }
    return cache ?? [];
  })();

  return inflight;
}

export function invalidateCmsPages(): void {
  cache = null;
  cacheAt = 0;
}

/**
 * Sections for one page: server content when a body has been written,
 * otherwise the app's built-in text. Never throws, never blocks rendering.
 */
export function useCmsSections(pageKey: string, fallback: CmsSection[]): CmsSection[] {
  const [sections, setSections] = useState<CmsSection[]>(fallback);

  useEffect(() => {
    let alive = true;
    void fetchCmsPages().then((pages) => {
      if (!alive) return;
      const page = pages.find((p) => p.key === pageKey);
      if (!page || page.published === false) return;
      const parsed = parseCmsBody(page.content ?? '');
      if (parsed.length > 0) setSections(parsed);
    });
    return () => { alive = false; };
  }, [pageKey]);

  return sections;
}
