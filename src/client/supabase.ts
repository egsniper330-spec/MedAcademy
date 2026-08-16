import { createClient } from '@supabase/supabase-js';
import 'expo-sqlite/localStorage/install';
import * as SecureStore from 'expo-secure-store';

const supabaseUrl: string = process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseAnonKey: string = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'placeholder';

// ─── iOS JSC fetch fix ────────────────────────────────────────────────────────
// @supabase/supabase-js accepts a custom fetch via `global.fetch`.
// When omitted, the internal `resolveFetch()` helper falls back to a bare
// `fetch` identifier captured at CJS bundle evaluation time. On iOS with the
// custom JSC engine (@react-native-community/javascriptcore), that bare
// identifier can resolve before React Native's whatwg-fetch polyfill is
// installed on `global`, causing every auth/postgrest/storage network call to
// throw "Network request failed" — while Android (Hermes) and Web work fine.
//
// Fix: explicitly bind globalThis.fetch and pass it via `global.fetch` so
// supabase-js always uses the same reference that medo-guard has patched.
// The lambda is typed as the supabase-js `Fetch` alias (= typeof fetch), which
// in its typings is `(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>`.
// We cast to `typeof fetch` (which resolves to that same signature here) to
// satisfy the SupabaseClientOptions type without a per-overload union juggle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _resolvedFetch = ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as any;


// Supabase requires a synchronous storage adapter. expo-secure-store is
// async-only on native; localStorage (injected by expo-sqlite) works
// synchronously on Web. We implement the LargeSecureStore pattern:
// - On Web: delegate directly to localStorage (synchronous, already injected)
// - On iOS/Android: use SecureStore with synchronous-compatible adapter
//   (Supabase calls getItem synchronously but handles a thenable return)
//
// expo-secure-store has a 2 KB per-key size limit. Supabase stores
// the entire session JSON (~1-3 KB) under one key. We chunk if needed.
const CHUNK_SIZE = 1800; // bytes — conservative, leaves room for base64 overhead

function chunkKey(key: string, i: number) { return `${key}_chunk_${i}`; }

const ExpoSecureStoreAdapter = {
  getItem(key: string): string | null {
    if (process.env.EXPO_OS === 'web') return localStorage.getItem(key);
    const raw = SecureStore.getItem(key);
    // If the stored value is a pure integer it is a chunk-count sentinel.
    // Reassemble all chunks synchronously and return the full value.
    if (raw !== null && /^\d+$/.test(raw)) {
      const count = parseInt(raw, 10);
      let result = '';
      for (let i = 0; i < count; i++) {
        const part = SecureStore.getItem(chunkKey(key, i));
        if (part === null) return null; // incomplete chunk set — treat as missing
        result += part;
      }
      return result;
    }
    return raw;
  },
  setItem(key: string, value: string): void {
    if (process.env.EXPO_OS === 'web') { localStorage.setItem(key, value); return; }
    if (value.length <= CHUNK_SIZE) {
      SecureStore.setItem(key, value);
      SecureStore.deleteItemAsync(chunkKey(key, 0)).catch(() => {}); // clean up old chunks if any
      return;
    }
    // Value too large for one slot — split into chunks
    const chunks = Math.ceil(value.length / CHUNK_SIZE);
    for (let i = 0; i < chunks; i++) {
      SecureStore.setItem(chunkKey(key, i), value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
    }
    SecureStore.setItem(key, String(chunks)); // sentinel: number of chunks
  },
  removeItem(key: string): void {
    if (process.env.EXPO_OS === 'web') { localStorage.removeItem(key); return; }
    const sentinel = SecureStore.getItem(key);
    if (sentinel && /^\d+$/.test(sentinel)) {
      const chunks = parseInt(sentinel, 10);
      for (let i = 0; i < chunks; i++) SecureStore.deleteItemAsync(chunkKey(key, i)).catch(() => {});
    }
    SecureStore.deleteItemAsync(key).catch(() => {});
  },
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage:              ExpoSecureStoreAdapter,
    autoRefreshToken:     true,
    persistSession:       true,
    detectSessionInUrl:   false,
  },
  global: {
    // iOS JSC fix: pass fetch explicitly so every supabase-js subsystem
    // (auth, postgrest, storage, functions) uses globalThis.fetch, which is
    // the medo-guard-patched version and is guaranteed to be initialized by
    // the time this module evaluates.  Without this, @supabase/auth-js falls
    // back to a bare `fetch` identifier captured in its own CJS scope, which
    // on iOS JSC (custom @react-native-community/javascriptcore engine) can
    // resolve to an uninitialized reference → "Network request failed".
    fetch: _resolvedFetch,
  },
});
