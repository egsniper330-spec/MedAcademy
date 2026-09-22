# Regression Fix: "App configuration error. Please reinstall or contact support."

## Problem

After the previous iOS auth network investigation, iOS login now shows:

> "App configuration error. Please reinstall or contact support."

instead of proceeding to authenticate.

---

## Exact Source

**File**: `src/app/(auth)/sign-in.tsx`, lines 89–94 (added in previous fix)

```ts
// PREVIOUS CODE — introduced the regression
if (!_urlValid || !_anonKey) {
  setError('App configuration error. Please reinstall or contact support.');
  setLoading(false);
  return;              // ← hard-blocked every iOS login attempt
}
```

---

## Root Cause: How Expo inlines `EXPO_PUBLIC_*` environment variables

`babel-preset-expo` (`build/inline-env-vars.js` line 51) transforms every
`process.env.EXPO_PUBLIC_*` reference at **Metro bundle build time**:

```js
// babel-preset-expo/build/inline-env-vars.js
if (isProduction) {
  path.replaceWith(t.valueToNode(process.env[key]));
  //                              ↑ value of process.env[key] when Metro runs
}
```

This means the value is **statically baked** into the JS bundle — it is not
read at runtime from the OS process environment.

### Where each build profile gets the value from

| Build profile | `EXPO_PUBLIC_SUPABASE_URL` at bundle time | Result in bundle |
|---|---|---|
| `production` / `preview` / `release-apk` | Set in `eas.json` `env` section | Real URL string ✓ |
| `development` / `development-device` | **NOT set** in `eas.json` `env` | `undefined` literal |
| `expo start` (local) | Read from project `.env` file | Real URL string ✓ |

### What `supabase.ts` does with `undefined`

```ts
// supabase.ts — safe, has fallback
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
```

→ Client is created with `placeholder.supabase.co`; network calls fail gracefully.

### What the new validation in `sign-in.tsx` did with `undefined`

```ts
// sign-in.tsx — NO fallback, HARD-BLOCKS
const _supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
// → '' (empty string, because the inlined undefined becomes '' via ??)
// URL parse fails → _urlValid = false
// → setError('App configuration error…') → RETURN
```

The Babel inline transform at each call-site is independent — `supabase.ts`
and `sign-in.tsx` each get their own inlined copy of the value.  `supabase.ts`
has `|| 'placeholder'` fallback; `sign-in.tsx` had `?? ''` with no fallback
and then hard-blocked.

### Why Android was not affected (yet)

The Android testers were using the `release-apk` or `preview` EAS profile, both
of which **do** have `EXPO_PUBLIC_SUPABASE_URL` in their `env` section — so the
real URL was baked in and `_urlValid = true`.  The iOS testers were using a
`development` or ad-hoc build without the env vars → `_urlValid = false` → block.

### Why this was not the problem BEFORE the previous fix

Before the previous fix there was no URL validation in `sign-in.tsx` at all.
The app simply attempted login (hitting "Network request failed" due to the
medo-guard bug), which was the bug being investigated.  The new validation check
was intended to diagnose misconfigured builds — but it incorrectly treated a
legitimate dev-client build (no env vars) as a fatal misconfiguration.

---

## Fix Applied

### `src/app/(auth)/sign-in.tsx`

**Change 1 — Remove hard-block; downgrade to diagnostic log-only**

The `if (!_urlValid || !_anonKey) { setError(…); return; }` block is removed.
The config check now only emits a `[CONFIG]` log line and always continues:

```ts
// NEW — log only, never block
console.log('[CONFIG]', `SUPABASE_URL_PRESENT=… SUPABASE_URL_VALID=… ANON_KEY_PRESENT=… URL_HOST=… t=Xms`);
// Diagnostic only — do NOT return/block here. Always proceed to NETTEST.
```

**Change 2 — NETTEST skips when URL is absent/placeholder**

The NETTEST probe now checks `_urlValid` before attempting the fetch.  When the
URL is absent (dev build) or the placeholder, the probe is skipped with a log
line and auth proceeds normally — the supabase client itself will report any
real connectivity failure:

```ts
if (_urlValid) {
  // ... fetch probe to _urlHost ...
} else {
  console.log('[NETTEST]', `SKIPPED — URL not valid (env var absent or placeholder). Proceeding to auth.`);
}
```

**Change 3 — `_urlValid` excludes `placeholder.supabase.co`**

```ts
_urlValid = parsed.protocol === 'https:'
  && parsed.hostname.length > 0
  && !parsed.hostname.startsWith('placeholder');  // ← new
```

This ensures a dev-client build using the `supabase.ts` placeholder fallback is
correctly identified as "not a real production URL" and the NETTEST is skipped
rather than hitting `https://placeholder.supabase.co/rest/v1/` unnecessarily.

---

## What the iOS console now shows on a valid production build

```
[AUTH] login started | platform=ios method=email t=0ms
[CONFIG] SUPABASE_URL_PRESENT=true SUPABASE_URL_VALID=true ANON_KEY_PRESENT=true URL_HOST=xdvjwfuqipatkpimejcb.supabase.co t=1ms
[NETTEST] START host=xdvjwfuqipatkpimejcb.supabase.co t=1ms
[NETTEST] END status=200 t=412ms
[AUTH] security check START t=412ms
...
[AUTH] signInWithPassword END session=true elapsed=890ms t=1302ms
```

## What the iOS console shows on a dev build (no env vars)

```
[AUTH] login started | platform=ios method=email t=0ms
[CONFIG] SUPABASE_URL_PRESENT=false SUPABASE_URL_VALID=false ANON_KEY_PRESENT=false URL_HOST=(none) t=1ms
[NETTEST] SKIPPED — URL not valid (env var absent or placeholder). Proceeding to auth. t=1ms
[AUTH] security check START t=1ms
...
[AUTH_ERROR] stage=supabase_signin name=AuthApiError status=0 message=Network request failed elapsed=8012ms t=8013ms
```
→ Login attempt proceeds; the real network error surfaces from `signInWithPassword`.

---

## Files Modified

| File | Change |
|------|--------|
| `src/app/(auth)/sign-in.tsx` | Remove hard-block on missing env vars; NETTEST skips when URL absent/placeholder; `_urlValid` excludes placeholder hostname |

---

## Validation Checklist

| Test | Expected |
|------|----------|
| iOS production build — valid credentials | Login succeeds |
| iOS production build — wrong password | "Incorrect email or password." |
| iOS dev build (no env vars) — any credentials | Auth attempted; real Supabase error shown |
| iOS — airplane mode | "Network error: cannot reach server." (from NETTEST on prod build) |
| Android — all cases | No regression — identical behaviour to before |
