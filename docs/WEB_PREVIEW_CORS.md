# Web preview login fails with "Network error: could not connect to the server"

**Symptom (browser / Expo web only — never on a native build):**

```
Access to fetch at 'https://api.medacademy.site/backend/public/index.php/auth/login'
from origin 'http://127.0.0.1:8081' has been blocked by CORS policy:
Response to preflight request doesn't pass access control check:
No 'Access-Control-Allow-Origin' header is present on the requested resource.

[AUTH_STATE] AUTH_NETWORK_FAILURE — Failed to fetch
```

and the sign-in screen shows *"Network error: could not connect to the server. Please
check your connection."*

## Why it happens

The API is **not down**. Check it yourself — the same request succeeds outside a browser:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://api.medacademy.site/backend/public/index.php/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"nobody@example.com","password":"x"}'   # → 401
```

The difference is the browser:

- A **native** build sends no `Origin` header, so CORS never applies. That is why the
  app works on Android/iOS.
- The **web** preview is a real page (`http://127.0.0.1:8081`). The browser sends an
  `OPTIONS` preflight for `POST … application/json` and refuses to hand the response to
  JavaScript unless it carries `Access-Control-Allow-Origin`.

`backend/src/Middleware/CorsMiddleware.php` implements this correctly, but it only
answers origins listed in the server's `CORS_ALLOWED_ORIGINS` environment variable. On a
server where that variable is missing or does not list the dev origin, the preflight
falls through to the router and returns:

```
HTTP/1.1 404 Not Found
{"error":{"message":"Route not found: OPTIONS /auth/login","code":"not_found"}}
```

→ the browser blocks every call, and the app reports it as a connection failure.

## Two fixes

### 1. Permanent (server-side, one env var)

In `backend/.env` on the host:

```dotenv
CORS_ALLOWED_ORIGINS=https://medacademy.site,http://localhost:8081,http://127.0.0.1:8081
```

No code change and no migration. Native clients are unaffected (they send no `Origin`).
Remove the loopback origins if you never intend to serve the web build from a dev machine.

### 2. Local only (no server access needed)

`scripts/dev-api-proxy.cjs` is a loopback CORS bridge: it forwards bytes to the real API,
answers the preflight itself and adds the headers a browser needs. It does not mock or
alter a single response, and it binds `127.0.0.1` only.

```bash
# terminal 1 — the bridge (defaults to the production API on :8788)
node scripts/dev-api-proxy.cjs

# terminal 2 — the web preview pointed at it
EXPO_PUBLIC_PHP_API_URL=http://127.0.0.1:8788/backend/public/index.php \
  npx expo start --web --port 8081
```

`EXPO_PUBLIC_PHP_API_URL` is set for that process only (a shell variable wins over
`.env.local`), so a native build from the same checkout keeps using the real API.

Env knobs: `DEV_API_TARGET` (upstream base), `DEV_API_PORT` (default `8788`),
`DEV_API_LOG=0` (quiet).

## Verifying that it is really fixed

The proxy log should show a real status, not a CORS failure:

```
OPTIONS /backend/public/index.php/auth/pre-login-check → 204 (preflight answered locally)
POST /backend/public/index.php/auth/pre-login-check → 200 (257ms)
```

In the browser console the `AUTH_NETWORK_FAILURE — Failed to fetch` line is gone, and a
wrong account now produces a real backend answer ("No account found for this email or
phone number.") instead of a connection error.

## Do not "fix" this in the client

Widening `fetch` mode, disabling the security checks, or hard-coding a different API base
hides a genuine server configuration gap and breaks production. The `/security/policies`,
`/app/version` and `/platform/branding` probes are intentionally authenticated/limited —
a `401` from them is expected and unrelated to CORS.
