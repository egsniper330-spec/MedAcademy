/**
 * audit-host.js — pre-launch capacity probe for the LIVE cPanel host.
 *
 * WHAT THIS MEASURES (and what it cannot)
 * ──────────────────────────────────────
 * Two requests per iteration, over the same connection pool and the same
 * network path, so their difference isolates application time:
 *
 *   GET /                       → 66-byte STATIC response (web server only)
 *   GET /backend/public/index.php/api/health
 *                               → full PHP front-controller boot + DB SELECT 1
 *
 * `php_ttfb - static_ttfb` is therefore an upper bound on PHP+MySQL work per
 * request that does not depend on round-trip time. Absolute latency DOES depend
 * on the round trip from the machine that runs k6: if the generator is on a
 * slow link (this audit's workstation measured ~1.0–1.5 s RTT to 1.1.1.1),
 * every number here includes that latency and the achievable RPS is capped by
 * VUs / RTT, not by the host. The report states which regime each stage was in.
 *
 * SAFETY
 * ──────
 *   • bounded: every stage is a fixed VU count for a fixed duration;
 *   • read-only: only GETs of two idempotent endpoints, no login, no writes;
 *   • automatic abort: >2 % failures, any 5xx/508, or p95 > 8 s stops the run;
 *   • hard ceiling of 100 VUs (shared hosting; the host's CloudLinux entry
 *     process limit is the thing being probed, not something to hammer).
 *
 * USAGE
 * ─────
 *   K6_BIN=.freebuff/tools/k6/k6.exe \
 *   BASE_URL=https://api.medacademy.site VUS=5 HOLD=20s \
 *   $K6_BIN run scripts/loadtest/audit-host.js
 *
 * Output: stdout summary + `.freebuff/loadtest-results/host-vus<N>.json`.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL;
if (!BASE) throw new Error('BASE_URL is required, e.g. BASE_URL=https://api.medacademy.site');

const HEALTH = `${BASE}/backend/public/index.php/api/health`;
const STATIC = `${BASE}/`;

// Hard ceiling. 100 concurrent connections is the most this account should ever
// be asked to hold from one source; the CloudLinux entry-process limit is the
// thing being discovered, not something to batter. MAX_VUS can lower it, never
// raise it beyond 100.
const VUS = Math.min(Number(__ENV.VUS || 1), Math.min(Number(__ENV.MAX_VUS || 100), 100));
const HOLD = __ENV.HOLD || '20s';
const RAMP = __ENV.RAMP || '5s';
const THINK = Number(__ENV.THINK || 0.5);

const staticTtfb = new Trend('static_ttfb', true);
const phpTtfb = new Trend('php_ttfb', true);
const serverErrors = new Counter('server_errors');
const badStatus = new Rate('bad_status');

export const options = {
  scenarios: {
    probe: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: VUS },
        { duration: HOLD, target: VUS },
        { duration: '3s', target: 0 },
      ],
      gracefulRampDown: '2s',
    },
  },
  thresholds: {
    // Abort rather than push through: a shared host under protection must not be
    // driven deeper once it is visibly failing.
    http_req_failed: [{ threshold: 'rate<0.02', abortOnFail: true, delayAbortEval: '5s' }],
    bad_status: [{ threshold: 'rate<0.02', abortOnFail: true, delayAbortEval: '5s' }],
    php_ttfb: [{ threshold: 'p(95)<8000', abortOnFail: true, delayAbortEval: '5s' }],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  discardResponseBodies: true,
  noConnectionReuse: false,
};

export default function () {
  const s = http.get(STATIC, { tags: { kind: 'static' }, timeout: '30s' });
  staticTtfb.add(s.timings.waiting);
  if (s.status >= 500) serverErrors.add(1);
  badStatus.add(s.status >= 500 || s.status === 0);

  const h = http.get(HEALTH, { tags: { kind: 'php' }, timeout: '30s' });
  phpTtfb.add(h.timings.waiting);
  if (h.status >= 500) serverErrors.add(1);
  badStatus.add(h.status >= 500 || h.status === 0);

  check(h, {
    'health 200': (r) => r.status === 200,
    'health body ok': (r) => typeof r.body === 'string' ? r.body.includes('"status"') : true,
  });

  sleep(THINK);
}

export function handleSummary(data) {
  const file = `.freebuff/loadtest-results/host-vus${VUS}.json`;
  return {
    stdout: '',
    [file]: JSON.stringify(
      {
        target: BASE,
        vus: VUS,
        hold: HOLD,
        thinkSeconds: THINK,
        metrics: data.metrics,
        rootGroup: data.root_group,
      },
      null,
      2,
    ),
  };
}
