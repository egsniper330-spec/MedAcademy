/**
 * i18n core — device locale detection, translation function, and RTL wiring.
 *
 * DESIGN
 * ──────
 * • The PURE rules (tag → locale, interpolation, fallback chain) live in
 *   ./detect.ts with NO React Native imports, so they can be unit-tested in
 *   plain Node and cannot depend on device runtime state.
 *
 * • The device half lives here: `getLocales()` from expo-localization, the
 *   active-locale store, `I18nManager` RTL, and the React provider.
 *
 * • `t(key, params)` reads the module-level active locale. This keeps call
 *   sites trivial (`t('auth.signIn')`) and lets non-React code (the tab
 *   registry, services) translate too. React components re-render on language
 *   change via `useTranslation()`, which subscribes to the module store.
 *
 * • Fallback chain: active locale → English → the key itself. A missing key
 *   NEVER throws and NEVER renders a raw key to the user as long as English has
 *   it (the completeness test enforces that both languages have the same keys).
 *
 * • LANGUAGE PREFERENCE (in-app selector): the language follows the DEVICE by
 *   default, but the user may pin `ar` or `en` from the settings UI. The stored
 *   override is resolved FIRST (precedence: stored preference → device tags →
 *   English), it survives restarts, and choosing "system" deletes the stored
 *   override so device-language detection resumes on the next foreground. With
 *   no override, the provider re-detects on every return to the foreground (no
 *   restart, no session loss for the text layer). The persistence contract
 *   lives in ./preferenceStore.ts (pure, storage injected here).
 *
 * • RTL: React Native mirrors layout only after `I18nManager.forceRTL()` takes
 *   effect, which requires the native UI to be re-created. We therefore detect
 *   the direction at startup and apply it immediately; the FIRST launch after
 *   switching to Arabic picks up mirrored layout on the next launch (the app
 *   keeps running with Arabic text in the previous direction until then — no
 *   forced reload that would drop navigation or the session). `needsRestart` is
 *   exposed through the provider so a caller can explain this if desired. Web
 *   flips `document.dir` immediately and needs no reload.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { AppState, I18nManager, Platform } from 'react-native';
import { getLocales } from 'expo-localization';
import {
  DEFAULT_LOCALE,
  isRTLLocale,
  resolveLocale,
  translate,
  translateCount,
  type Locale,
  type TranslationParams,
} from './detect';
import {
  effectiveLocale,
  type LanguagePreference,
} from './preference';
import {
  createPreferenceStore,
  type PreferenceStorageLike,
} from './preferenceStore';

export {
  effectiveLocale,
  LANGUAGE_PREFERENCES,
  LANGUAGE_PREFERENCE_STORAGE_KEY,
  parsePreference,
  type LanguagePreference,
} from './preference';
export {
  createPreferenceStore,
  type PreferenceStorageLike,
  type PreferenceStore,
} from './preferenceStore';

export {
  LOCALES,
  NON_TRANSLATABLE_KEYS,
  RESOURCES,
  ar,
  en,
  interpolate,
  isArabicTag,
  isRTLLocale,
  pluralCategory,
  resolveLocale,
  translate,
  translateCount,
  type Locale,
  type PluralCategory,
  type TranslationParams,
} from './detect';
export { DEFAULT_LOCALE };

/* ───────────────────────── device language detection ───────────────────── */

/** Read the device's preferred language tags safely (never throws). */
export function getDeviceLanguageTags(): string[] {
  try {
    const locales = getLocales?.() ?? [];
    const tags: string[] = [];
    for (const l of locales) {
      // Prefer the full tag; fall back to the base language code.
      const tag = l?.languageTag || l?.languageCode || null;
      if (tag) tags.push(tag);
    }
    return tags;
  } catch {
    // Native module missing (tests / web / unlinked) → English.
    return [];
  }
}

/** Detect the device locale. Pure w.r.t. its input; falls back to English. */
export function detectDeviceLocale(): Locale {
  return resolveLocale(getDeviceLanguageTags());
}

/* ─────────────────────── app language preference ────────────────────────── */

/**
 * The stored preference: `'system'` (default, follow the device) or an
 * explicit `'ar'` / `'en'` override. The module value is the source of truth;
 * React reads it through `useSyncExternalStore(subscribe, getPreference)`.
 */
let activePreference: LanguagePreference = 'system';

/** Current app-language preference. `'system'` = following the device. */
export function getPreference(): LanguagePreference {
  return activePreference;
}

/**
 * The real storage backend. Required lazily so this module can still be
 * imported by plain-Node test builds, where AsyncStorage is unavailable — in
 * that case every operation degrades to "follow the device" / "not saved".
 */
function defaultStorage(): PreferenceStorageLike | null {
  try {
    const mod = require('@react-native-async-storage/async-storage');
    const storage = mod?.default ?? mod;
    return storage && typeof storage.getItem === 'function' ? storage : null;
  } catch {
    return null;
  }
}

let preferenceStore = createPreferenceStore(defaultStorage());

/**
 * Replace the persistence backend. Used by tests (in-memory storage) and by
 * callers that need to re-resolve storage availability. Pass `null` to disable
 * persistence entirely (load → 'system', save → false).
 */
export function setLanguageStorage(storage: PreferenceStorageLike | null): void {
  preferenceStore = createPreferenceStore(storage);
}

/** Notify every subscriber of a store change (locale or preference). */
function notifyListeners(): void {
  for (const l of Array.from(listeners)) {
    try {
      l();
    } catch {
      /* a bad subscriber must not break the rest */
    }
  }
}

/**
 * Resolve the effective locale for a preference and publish it.
 * Precedence: explicit override → device tags → English (see ./preference.ts).
 */
function publishEffectiveLocale(pref: LanguagePreference): Locale {
  const next = effectiveLocale(pref, getDeviceLanguageTags());
  setLocale(next);
  return next;
}

export interface LanguageChangeResult {
  /** What is now in effect (and what was written to storage). */
  preference: LanguagePreference;
  /** The locale that was applied for this session. */
  locale: Locale;
  /**
   * `false` when the preference could NOT be written — the session shows the
   * chosen language, but it will not survive a restart. Callers must tell the
   * user instead of failing silently.
   */
  persisted: boolean;
  /** True when native RTL still needs a relaunch to mirror the layout. */
  rtlNeedsRestart: boolean;
}

/**
 * Load the stored preference (startup, and after storage becomes available).
 * Missing / invalid / unreadable storage all resolve to `'system'`, i.e. the
 * device language — a broken store never traps the app in a language.
 */
export async function loadLanguagePreference(): Promise<LanguagePreference> {
  const pref = await preferenceStore.load();
  const changed = pref !== activePreference;
  activePreference = pref;
  const locale = publishEffectiveLocale(pref);
  applyRTL(locale);
  if (changed) notifyListeners();
  return pref;
}

/**
 * Persist (or clear) the preference and apply it immediately.
 *
 * Order matters: the write is attempted FIRST so the language we display is
 * exactly the language we store — we never display `ar` while `en` (or
 * nothing) is persisted. On a storage failure the new language still applies
 * for this session and `persisted: false` is returned so the caller can say
 * so; nothing throws.
 */
export async function setLanguagePreference(pref: LanguagePreference): Promise<LanguageChangeResult> {
  const persisted = await preferenceStore.save(pref);
  activePreference = pref;
  const locale = publishEffectiveLocale(pref);
  const rtl = applyRTL(locale);
  notifyListeners();
  return { preference: pref, locale, persisted, rtlNeedsRestart: rtl.needsRestart };
}

/* ───────────────────────── active-locale store ─────────────────────────── */

type Listener = () => void;

let activeLocale: Locale = DEFAULT_LOCALE;
const listeners = new Set<Listener>();

/** Current active locale (read by `t()`). */
export function getLocale(): Locale {
  return activeLocale;
}

/** True when the active locale is laid out right-to-left. */
export function isRTL(locale: Locale = activeLocale): boolean {
  return isRTLLocale(locale);
}

/**
 * Set the active locale and notify subscribers. Idempotent — setting the same
 * locale is a no-op (no re-render storm).
 */
export function setLocale(locale: Locale): void {
  if (locale === activeLocale) return;
  activeLocale = locale;
  notifyListeners();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/* ────────────────────────────── translation ───────────────────────────── */

/** The primary translation function. Reads the active locale. */
export function t(key: string, params?: TranslationParams): string {
  return translate(activeLocale, key, params);
}

/**
 * Translate a count-bearing string with correct plural forms.
 * Arabic needs 0/1/2/3–10/11–99/100+ forms, so `{count} ملفات` is wrong for 2 —
 * use `tCount('lesson.fileCount', n)` instead of a hand-built ternary.
 */
export function tCount(key: string, count: number, params?: TranslationParams): string {
  return translateCount(activeLocale, key, count, params);
}

/* ─────────────────────────────── RTL wiring ───────────────────────────── */

export interface RtlInitResult {
  /** The direction currently applied by the platform after this call. */
  appliedRTL: boolean;
  /** True when the platform needs an app RELOAD to honour the new direction. */
  needsRestart: boolean;
  /** The locale that drove this decision. */
  locale: Locale;
}

/**
 * Apply the RTL direction for `locale`.
 *
 * Native (iOS/Android): `I18nManager.forceRTL()` only takes effect after the
 * app's native UI is re-created, so we record that a restart is required. We
 * deliberately do NOT force-restart here (that would drop navigation/session
 * state); the caller decides when to reload.
 *
 * Web: `document.dir` flips immediately.
 *
 * Idempotent and safe on every foreground resume — it compares against the
 * platform's CURRENT direction before touching anything.
 */
export function applyRTL(locale: Locale = activeLocale): RtlInitResult {
  const shouldBeRTL = isRTLLocale(locale);

  // Web: mirror immediately, no reload required.
  if (Platform.OS === 'web') {
    try {
      const doc = (globalThis as { document?: { documentElement?: { dir?: string; lang?: string } } }).document;
      if (doc?.documentElement) {
        doc.documentElement.dir = shouldBeRTL ? 'rtl' : 'ltr';
        doc.documentElement.lang = locale;
      }
    } catch {
      /* SSR / test environments have no document */
    }
    return { appliedRTL: shouldBeRTL, needsRestart: false, locale };
  }

  // Native: only touch I18nManager when a change is actually needed.
  //
  // allowRTL(true) is a GLOBAL capability switch and must stay ON: setting it
  // to false while the app is in English would disable RTL for a later Arabic
  // launch on the same install. Direction is controlled exclusively by
  // forceRTL (§ the only supported per-locale mechanism).
  try {
    I18nManager.allowRTL(true);
  } catch {
    /* unlinked / web-fallback */
  }

  const alreadyCorrect = I18nManager.isRTL === shouldBeRTL;
  if (alreadyCorrect) {
    return { appliedRTL: I18nManager.isRTL, needsRestart: false, locale };
  }

  try {
    I18nManager.forceRTL(shouldBeRTL);
  } catch {
    /* unlinked / web-fallback — direction simply stays LTR */
  }

  // I18nManager.isRTL reflects the CURRENT session, not the pending value, so
  // a change always implies the next launch must pick it up.
  return {
    appliedRTL: I18nManager.isRTL,
    needsRestart: I18nManager.isRTL !== shouldBeRTL,
    locale,
  };
}

/**
 * Initialize language + direction from the device. Called once at startup
 * (root layout). Safe to call multiple times.
 */
export function initI18n(localeOverride?: Locale): Locale {
  const locale = localeOverride ?? detectDeviceLocale();
  setLocale(locale);
  applyRTL(locale);
  return locale;
}

/* ─────────────────────────── React integration ────────────────────────── */

interface I18nContextValue {
  locale: Locale;
  isRTL: boolean;
  t: (key: string, params?: TranslationParams) => string;
  /** Plural-aware translation: `tCount('lesson.fileCount', 3)`. */
  tCount: (key: string, count: number, params?: TranslationParams) => string;
  setLocale: (locale: Locale) => void;
  /** The stored/active app-language choice ('system' follows the device). */
  preference: LanguagePreference;
  /** Persist + apply a new language choice. Never throws; reports persistence. */
  setPreference: (preference: LanguagePreference) => Promise<LanguageChangeResult>;
  /** True only on the launch that applied a new native direction. */
  rtlNeedsRestart: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Provider — seeds the active locale from the device on mount and exposes the
 * translation context. Kept intentionally thin: the locale itself lives in the
 * module store so non-React callers share the same source of truth.
 *
 * Device-language changes while installed are picked up on foreground resume.
 * The printed text switches immediately; native layout mirroring follows on the
 * next launch (see applyRTL) — never a forced restart that would lose the
 * authenticated session.
 */
export function I18nProvider({
  children,
  initialLocale,
}: {
  children: React.ReactNode;
  initialLocale?: Locale;
}): React.ReactElement {
  // Seed the module store BEFORE the first child render so any `t()` called
  // during render (including in the tab registry) already sees the language.
  // Device-based for the very first paint; the stored override (if any) is
  // applied as soon as it loads, which is a sub-second async read.
  useState<Locale>(() => {
    const start = initialLocale ?? detectDeviceLocale();
    activeLocale = start;
    return start;
  });

  const [rtlNeedsRestart, setRtlNeedsRestart] = useState(false);

  // Single source of truth: the module store. Every provider/consumer reads
  // these, so an external setLanguagePreference() repaints the whole tree.
  const storeLocale = useSyncExternalStore(subscribe, getLocale);
  const storePreference = useSyncExternalStore(subscribe, getPreference);

  // Direction follows the effective locale (mount + every change, including
  // changes made from the settings screen outside this provider). Native may
  // require a relaunch; we surface that instead of forcing it here.
  useEffect(() => {
    const result = applyRTL(storeLocale);
    setRtlNeedsRestart(result.needsRestart);
  }, [storeLocale]);

  // Load the stored preference once. Precedence (stored → device → English)
  // is applied inside loadLanguagePreference(); if there is no override this
  // is a no-op that re-publishes the device locale.
  useEffect(() => {
    // Storage read resolves to 'system' on any failure, so this can neither
    // reject nor leave the app in an unknown language.
    void loadLanguagePreference();
  }, []);

  // Re-check on foreground return: with NO override a device-language change
  // is honoured without a restart (and without touching the session); with an
  // explicit override the device language is deliberately ignored.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (getPreference() !== 'system') return; // explicit choice wins
      const next = initialLocale ?? detectDeviceLocale();
      if (next !== activeLocale) setLocale(next);
    });
    return () => sub.remove();
  }, [initialLocale]);

  const changeLocale = useCallback((next: Locale) => {
    setLocale(next);
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale: storeLocale,
      isRTL: isRTLLocale(storeLocale),
      t: (key: string, params?: TranslationParams) => translate(storeLocale, key, params),
      tCount: (key: string, count: number, params?: TranslationParams) =>
        translateCount(storeLocale, key, count, params),
      setLocale: changeLocale,
      preference: storePreference,
      setPreference: setLanguagePreference,
      rtlNeedsRestart,
    }),
    [storeLocale, storePreference, changeLocale, rtlNeedsRestart],
  );

  return React.createElement(I18nContext.Provider, { value }, children);
}

/**
 * `useTranslation()` — the hook components use.
 *
 * Falls back to a store-backed default when no provider is mounted (e.g. unit
 * tests, or a component rendered outside the tree), so `t` is never undefined.
 */
export function useTranslation(): I18nContextValue {
  const ctx = useContext(I18nContext);
  const storeLocale = useSyncExternalStore(subscribe, getLocale);
  const storePreference = useSyncExternalStore(subscribe, getPreference);

  const fallback = useMemo<I18nContextValue>(
    () => ({
      locale: storeLocale,
      isRTL: isRTLLocale(storeLocale),
      t: (key: string, params?: TranslationParams) => translate(storeLocale, key, params),
      tCount: (key: string, count: number, params?: TranslationParams) =>
        translateCount(storeLocale, key, count, params),
      setLocale,
      preference: storePreference,
      setPreference: setLanguagePreference,
      rtlNeedsRestart: false,
    }),
    [storeLocale, storePreference],
  );

  return ctx ?? fallback;
}
