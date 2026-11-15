# Test Results

Run: 2026-11-01

## Automated

```
cd portal
npm test
```

```
Test Files  3 passed (3)
Tests       13 passed (13)
```

| Suite | Covers |
| --- | --- |
| `tests/permissions.test.ts` | Staff-role allow-list, students rejected from every route, Doctor/Admin/SA route matrix, Admin cannot manage Admin/SA |
| `tests/api-login.test.ts` | Student response rejected with no token stored, Doctor/Admin/SA sessions accepted, nested PHP error message surfaced |
| `tests/backend-contract.test.ts` | Portal login route + role gate before session issue, Admin privilege guards incl. bulk and trash |

Type/build:

```
npm run build   # tsc -b && vite build — pass
npm run lint    # 0 errors, 16 warnings (hook deps / fast-refresh advisories)
```

Final bundle: `index-CEBWdA7L.js`, `index-B0vpgb9N.css`.

## Live deployment checks

| Check | Result |
| --- | --- |
| `https://portal.medacademy.site/` | 200, correct HTML |
| CSP, HSTS, nosniff, frame-deny headers | Present |
| `index.html` cache | `no-cache, no-store, must-revalidate` |
| Hashed CSS cache | `public, max-age=31536000, immutable` |
| `/users` direct deep link | 200 HTML |
| `/assets/` directory listing | 403 |
| `.map` request | 403 |
| API preflight from portal origin | 204 |
| Portal login with bad credentials | 401, friendly message in UI |
| Mobile `/auth/login` with bad credentials | 401 (unchanged) |
| Unauthenticated `/auth/me` | 401 |
| Logged-out protected route | Redirects to `/login` |
| Logged-in deep-link refresh | Preserved route after auth restore |
| Arabic / RTL | `dir=rtl`, Arabic headings, layout mirrors |
| Doctor live session | Dashboard, courses, students, credits, videos, notifications, profile loaded; no Admin links |
| Super Admin live session | Users (real rows), analytics (real totals), branding (loaded values), app updates, security policies loaded; no console errors |

No production writes were performed during verification. No test student or staff
account was created.

## Not executed

- A live Admin-role session (only Doctor and Super Admin sessions were available
  in the browser).
- A live student sign-in rejection request (no student credentials were used).
- Destructive course/student/user operations against production.
- Chunked video upload (not implemented in this portal).

These are reported as limitations, not passes.
