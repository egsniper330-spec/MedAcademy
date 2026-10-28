#!/usr/bin/env node
/**
 * stub-api.cjs — a tiny stand-in API for validating the LOAD-TEST HARNESS.
 *
 * NOT A CAPACITY TEST, EVER.
 * ─────────────────────────
 * This answers the same read-only routes the journey calls with canned JSON, so
 * the harness (per-VU sessions, endpoint metrics, stage runner, stop conditions,
 * report files) can be exercised without a database, without PHP, and without
 * pointing at any real environment. A number measured against this stub says
 * something about k6 and the generator — nothing about MedAcademy.
 *
 * WHY IT IS WORTH HAVING
 * ──────────────────────
 * The old suite's ceiling was invisible from the outside: with `MAX_VUS=50` it
 * threw, with anything larger than the default it silently ran 10. A stub makes
 * "did the generator really create N concurrent users?" observable: it counts
 * distinct bearer tokens and peak in-flight requests, and `reportedVus` in the
 * final summary can be compared with the k6 `vus_max` metric.
 *
 * USAGE
 *   node scripts/loadtest/stub-api.cjs --port=8099
 *   # then, in another shell:
 *   BASE_URL=http://127.0.0.1:8099 LOADTEST_APPROVED=1 \
 *   LOADTEST_TOKEN_POOL_FILE=scripts/loadtest/.tokens.json \
 *   node scripts/loadtest/run-stages.cjs --stages=12 --stage-ramp=3 --stage-hold=6
 *
 * `GET /__stub/stats` returns what the stub observed (never used by the journey).
 */
'use strict';

const http = require('http');

const args = {};
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith('--')) continue;
  const [k, v] = arg.slice(2).split('=');
  args[k] = v === undefined ? true : v;
}

const port = Number(args.port || 8099);
const latencyMs = Number(args.latency || 0); // optional artificial delay

const tokens = new Set();
let inFlight = 0;
let peakInFlight = 0;
let requests = 0;
const perRoute = new Map();

const courses = Array.from({ length: 12 }, (_, i) => ({
  id: `course-${i + 1}`,
  title: `Stub Course ${i + 1}`,
  status: 'published',
}));

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function routeOf(url) {
  const path = url.split('?')[0];
  if (/^\/courses\/[^/]+\/lessons$/.test(path)) return 'GET /courses/{id}/lessons';
  if (/^\/courses\/[^/]+$/.test(path)) return 'GET /courses/{id}';
  return `GET ${path}`;
}

const server = http.createServer((req, res) => {
  requests += 1;
  inFlight += 1;
  if (inFlight > peakInFlight) peakInFlight = inFlight;

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token) tokens.add(token);

  const route = routeOf(req.url || '/');
  perRoute.set(route, (perRoute.get(route) || 0) + 1);

  const finish = () => {
    inFlight -= 1;
    const path = (req.url || '/').split('?')[0];

    if (path === '/__stub/stats') {
      return json(res, 200, {
        requests,
        peakInFlight,
        distinctTokens: tokens.size,
        perRoute: Object.fromEntries([...perRoute.entries()].filter(([k]) => !k.startsWith('GET /__stub'))),
      });
    }
    if (path === '/api/health' || path === '/health') {
      return json(res, 200, { status: 'ok', services: { database: 'ok' } });
    }
    if (path === '/app/version') return json(res, 200, { version: '0.0.0-stub', minimumVersionCode: 0 });
    if (path === '/maintenance') return json(res, 200, { enabled: false });
    if (path === '/support/contact') return json(res, 200, { contacts: [] });
    if (path === '/auth/login') return json(res, 200, { session: { access_token: 'stub-login-token' } });
    if (path === '/auth/me') return json(res, 200, { user: { id: 'stub-user', role: 'student' } });
    if (path === '/courses') return json(res, 200, { courses });
    if (/^\/courses\/[^/]+\/lessons$/.test(path)) return json(res, 200, { lessons: [] });
    if (/^\/courses\/[^/]+$/.test(path)) return json(res, 200, { course: courses[0] });
    if (path === '/notifications') return json(res, 200, { notifications: [] });
    if (path === '/credits/me') return json(res, 200, { balance: 0 });
    if (path === '/security/policies') return json(res, 200, { policies: {} });
    if (path === '/platform/branding') return json(res, 200, { branding: {} });
    if (path === '/platform/feature-flags') return json(res, 200, { flags: {} });

    return json(res, 404, { error: { code: 'not_found', message: `stub has no route for ${path}` } });
  };

  if (latencyMs > 0) setTimeout(finish, latencyMs);
  else finish();
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`stub API listening on http://127.0.0.1:${port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
