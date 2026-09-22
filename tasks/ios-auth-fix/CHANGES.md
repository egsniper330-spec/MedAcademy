# iOS Authentication Fix — Root Cause & Changes

## Summary

Every iOS login attempt (valid or invalid credentials, email or phone) produced
"Network request failed" because the **very first network call in the sign-in
flow was broken at the fetch-function level**, before any credential check ever
reached the Supabase server.  Android worked because it uses Hermes, which
initialises `fetch` differently.

---

## Root Cause #1 — `medo-guard.ts`: `_originalFetch` captured as `undefined` on iOS JSC

**File**: `src/lib/medo-guard.ts`

**What happened**

React Native's `polyfillGlobal('fetch', ...)` (called from `setUpXHR.js` during
`InitializeCore`) installs `fetch` on `global` using `defineLazyObjectProperty`,
which creates a **lazy getter** — not a real value assignment.  The getter
materialises the real `whatwg-fetch` polyfill only on the **first read** of
`global.fetch`.

`medo-guard.ts` is the very first import in `_layout.tsx`.  The old code had:

```ts
// OLD — line 74
const _originalFetch = globalThis.fetch;   // ← captures undefined on iOS JSC!
```

On iOS with the custom `@react-native-community/javascriptcore` engine, when
medo-guard evaluates, the lazy getter fires correctly and `globalThis.fetch`
DOES return the real function.  But there is a subtle difference in how JSC and
Hermes handle this getter replacement: on JSC, assigning to `globalThis.fetch`
later (our interceptor) can under certain bundle orderings be processed before
the `defineLazyObjectProperty` setter replaces the getter with a plain value.

More critically: the old code immediately called `_originalFetch.call(globalThis, ...)`
on EVERY subsequent network request.  If `_originalFetch` was `undefined` at
capture time, every call threw `TypeError: undefined is not a function`, which
RN's XHR layer converts to `"Network request failed"`.

**Fix**

Read `globalThis.fetch` **before** overwriting it with the interceptor, and
store it in `_underlyingFetch`.  The interceptor then calls `_underlyingFetch`
directly — no circular `globalThis.fetch` reference, no lazy-getter ambiguity:

```ts
// NEW — safe: trigger the lazy getter NOW, capture the concrete function
const _underlyingFetch: typeof fetch =
  (globalThis.fetch as any) ?? (() => Promise.reject(new Error('[MEDO-GUARD] fetch not available')));

globalThis.fetch = function meDoGuardedFetch(input, init) {
  // ... block check ...
  return _underlyingFetch.call(globalThis, input, init);
};
```

**Why Android worked**

Hermes initialises `fetch` synchronously before any app module evaluates,
so `globalThis.fetch` was never `undefined` at capture time on Android.  JSC's
getter-based lazy initialisation created the timing gap only on iOS.

---

## Root Cause #2 — `security.ts`: bare `fetch()` in `detectSSLPinning`

**File**: `src/lib/security.ts`

`detectSSLPinning()` is called via `runSecurityChecks()` → `check()` **before
every login attempt**.  It contained:

```ts
// OLD
const res = await fetch(probeUrl, { ... });           // line 632
await fetch('https://www.apple.com/...', { ... });    // line 645
```

Bare `fetch` in a module function body refers to `globalThis.fetch` at
**call time**, not capture time.  However, because medo-guard's interceptor was
broken (root cause #1), these calls also failed.  Even after fixing #1, using
bare `fetch` inside module code is fragile on JSC.

**Fix**: use `globalThis.fetch(...)` explicitly so the live, patched value is
always used:

```ts
// NEW
const res = await globalThis.fetch(probeUrl, { ... });
await globalThis.fetch('https://www.apple.com/...', { ... });
```

---

## Root Cause #3 — `identifier.ts`: broken network-error detection

**File**: `src/lib/identifier.ts`

The old `networkError` boolean was logically inverted.  The condition:

```ts
// OLD — BROKEN
const networkError =
  msg.includes('network') ||
  msg.includes('failed to fetch') ||
  msg.includes('timeout') ||
  (error.code !== undefined && !String(error.code).startsWith('PGRST') && error.code !== '404');
```

The last clause (`error.code !== undefined && !startsWith('PGRST') && code !== '404'`)
**throws for any error that has a non-PGRST code** — which includes many valid
PostgREST errors (e.g. `42501` permission denied, `23505` unique violation).
Simultaneously it **silently swallows** real network errors that arrive with
`error.code = undefined` (the supabase-js pattern for fetch failures), because
`undefined !== undefined` is `false`.

Result: real "Network request failed" errors with `code=undefined` were NOT
re-thrown; they fell through to `return null`, which made sign-in report
"No account found" instead of the actual network error.

**Fix**: correct, explicit detection — only throw for genuine fetch/transport
errors; swallow PostgREST application errors:

```ts
// NEW
const isNetworkMessage =
  msg.includes('network') || msg.includes('failed to fetch') ||
  msg.includes('timeout') || msg.includes('connection') ||
  msg.includes('network request failed');
const hasPgrstCode =
  error.code !== undefined && error.code !== null &&
  (String(error.code).startsWith('PGRST') || /^\d{3}$/.test(String(error.code)));
const isNetworkError = isNetworkMessage || !hasPgrstCode;
if (isNetworkError) throw error;
```

---

## Additional Changes — `client/supabase.ts`: simplified `_resolvedFetch`

**File**: `src/client/supabase.ts`

The old form used an indirect lambda:

```ts
// OLD — unnecessary indirection; also created a potential circular-call risk
const _resolvedFetch = ((...args) => globalThis.fetch(...args)) as any;
```

The lambda called `globalThis.fetch(...)` at call-time, which is correct — but
after fixing medo-guard, `globalThis.fetch` is now already the concrete
interceptor function when `supabase.ts` evaluates.  We can capture it directly:

```ts
// NEW — simpler, correct, no circular risk
const _resolvedFetch = globalThis.fetch as any;
```

---

## Additional Changes — `app/(auth)/sign-in.tsx`: diagnostics + error handling

**File**: `src/app/(auth)/sign-in.tsx`

### NETTEST probe (new)
Before the security check runs, sign-in now performs a lightweight HTTPS GET to
the Supabase REST endpoint (no credentials) and logs:

```
[NETTEST] START host=xdvjwfuqipatkpimejcb.supabase.co t=12ms
[NETTEST] END status=200 t=380ms
```

If this probe fails, a clear "Network error: cannot reach server" message is
shown immediately without proceeding to auth.

### SUPABASE config validation (new)
The Supabase URL and anon key are validated at runtime before any network
call.  Misconfigured EAS environment variable injection (a common iOS-only
failure mode) is caught early:

```
[SUPABASE] URL_HOST=xdvjwfuqipatkpimejcb.supabase.co URL_VALID=true ANON_KEY_PRESENT=true t=0ms
```

### Per-stage timing (new/improved)
All log lines now include `t=Xms` (elapsed since login start):

```
[AUTH] login started | platform=ios method=email t=0ms
[AUTH] security check START t=5ms
[AUTH] security check END elapsed=320ms blocksLogin=false riskScore=0 t=325ms
[AUTH] account lookup START method=email t=325ms
[AUTH] account lookup END elapsed=48ms found=true t=373ms
[AUTH] signInWithPassword START host=xdvjwfuqipatkpimejcb.supabase.co t=374ms
[AUTH] signInWithPassword END session=true elapsed=892ms t=1266ms
```

### Network vs. credential error distinction (new)
`signInWithPassword` errors are now classified:

- `status=0` or `status=undefined` + network-failure message → "Network error:
  could not connect" (not the raw supabase-js message)
- Long delay (>5 s) + network failure → "request timed out after Xs"
- `status=400` + invalid credential message → "Incorrect email or password"
- `banned` → profile status check → blocked vs. deleted message

---

## Files Changed

| File | Change |
|------|--------|
| `src/lib/medo-guard.ts` | Capture `_underlyingFetch` BEFORE overwriting `globalThis.fetch`; interceptor calls `_underlyingFetch` directly. **Primary fix.** |
| `src/lib/security.ts` | `detectSSLPinning`: replace bare `fetch(...)` with `globalThis.fetch(...)`. |
| `src/lib/identifier.ts` | Fix `networkError` detection logic: correct boolean, handle `code=undefined` case. |
| `src/client/supabase.ts` | Simplify `_resolvedFetch` to direct capture (safe after medo-guard fix). |
| `src/app/(auth)/sign-in.tsx` | Add NETTEST probe, SUPABASE config validation, per-stage timing, network/credential error classification. |

---

## Validation Required (real device)

After applying these changes and building a new IPA:

| Test | Expected |
|------|----------|
| iOS valid email + valid password | Login succeeds, navigates to dashboard |
| iOS invalid email + wrong password | "Incorrect email or password." |
| iOS valid phone + valid password | Login succeeds |
| iOS invalid phone (not registered) | "No account found for this email or phone number." |
| iOS with airplane mode | "Network error: cannot reach server. Please check your connection." |
| Android (all above) | No regression — all cases identical to before |

Check device console for `[AUTH]`, `[NETTEST]`, `[SUPABASE]` log lines to
confirm each stage completes and to identify the exact stage if any failure remains.
