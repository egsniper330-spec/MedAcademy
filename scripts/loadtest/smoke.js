/**
 * MedAcademy — smoke test (run this immediately after installing k6).
 *
 * Purpose: prove the toolchain and the credentials work before any load is
 * applied. 1 virtual user, 5 iterations, strict thresholds.
 *
 *   BASE_URL=http://127.0.0.1:8090 \
 *   LOADTEST_STUDENT_EMAIL=loadtest.student@example.invalid \
 *   LOADTEST_STUDENT_PASSWORD=... \
 *   k6 run scripts/loadtest/smoke.js
 *
 * Read-only: GET /api/health, POST /auth/login, GET /auth/me, GET /courses.
 * No fixture data is created, modified or deleted.
 */

import { check } from 'k6';
import { authHeaders, getJson, joinUrl, login, requireEnv } from './lib/config.js';
import http from 'k6/http';

export const options = {
  vus: 1,
  iterations: 5,
  thresholds: {
    // A smoke test must be near-perfect; anything else means the stack or the
    // fixture is wrong, not that the service is under load.
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<2500'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const health = http.get(joinUrl('/api/health'), {
    tags: { name: 'GET /api/health' },
    timeout: '15s',
  });
  check(health, {
    'health: status is 200': (r) => r.status === 200,
    'health: reports database ok': (r) => {
      try {
        return r.json('services.database') === 'ok';
      } catch (e) {
        return false;
      }
    },
  });

  const token = login(requireEnv('LOADTEST_STUDENT_EMAIL'), requireEnv('LOADTEST_STUDENT_PASSWORD'), 'smoke');

  const me = http.get(joinUrl('/auth/me'), { ...authHeaders(token), tags: { name: 'GET /auth/me' } });
  check(me, { 'me: status is 200': (r) => r.status === 200 });

  getJson('/courses', token, 200, '/courses');
}
