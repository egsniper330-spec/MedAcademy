/**
 * preferenceStore.ts — persistence for the app-language preference.
 *
 * PURE: no `react-native` / AsyncStorage import, so the whole persistence
 * contract (load, save, invalid values, storage failures, returning to the
 * system default) is executable in plain Node tests. The real AsyncStorage is
 * injected by ./index.ts at runtime.
 *
 * FAILURE MODEL (documented behaviour, pinned by tests):
 *  - load: any error, a missing key or an unparseable value → `'system'`
 *    (follow the device). A broken store must never trap the app in a language.
 *  - save('system'): REMOVES the stored key — clearing the override is the
 *    only way "follow the device" can resume detecting device changes.
 *  - save('ar'|'en'): writes the value and reports whether it persisted, so
 *    the UI can tell the user when the choice could not be stored instead of
 *    silently displaying one language while another will load next launch.
 */

import {
  LANGUAGE_PREFERENCE_STORAGE_KEY,
  parsePreference,
  type LanguagePreference,
} from './preference';

/** The slice of AsyncStorage this module needs (also faked in tests). */
export interface PreferenceStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface PreferenceStore {
  /** Stored preference, or `'system'` when absent / invalid / unavailable. */
  load(): Promise<LanguagePreference>;
  /**
   * Persist the preference. `'system'` clears the stored override.
   * Resolves `false` when the write failed — the caller decides how to report it.
   */
  save(preference: LanguagePreference): Promise<boolean>;
  /** The storage key this store reads and writes. */
  readonly key: string;
}

/**
 * Build a store over the given storage (`null` simulates a missing/unavailable
 * storage module — every operation degrades to "follow the device" / "not saved").
 */
export function createPreferenceStore(storage: PreferenceStorageLike | null): PreferenceStore {
  return {
    key: LANGUAGE_PREFERENCE_STORAGE_KEY,

    async load(): Promise<LanguagePreference> {
      if (!storage) return 'system';
      try {
        const raw = await storage.getItem(LANGUAGE_PREFERENCE_STORAGE_KEY);
        // Missing key → 'system'; invalid/legacy value → 'system'.
        return parsePreference(raw) ?? 'system';
      } catch {
        // Storage threw (permissions, quota, corrupted backend): never crash,
        // never guess a language the user did not choose.
        return 'system';
      }
    },

    async save(preference: LanguagePreference): Promise<boolean> {
      if (!storage) return false;
      try {
        if (preference === 'system') {
          await storage.removeItem(LANGUAGE_PREFERENCE_STORAGE_KEY);
        } else {
          await storage.setItem(LANGUAGE_PREFERENCE_STORAGE_KEY, preference);
        }
        return true;
      } catch {
        return false;
      }
    },
  };
}
