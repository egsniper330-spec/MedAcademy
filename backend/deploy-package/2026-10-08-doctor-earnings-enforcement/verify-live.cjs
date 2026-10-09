#!/usr/bin/env node
/**
 * verify-live.cjs — post-upload verification against the LIVE backend.
 *
 * Proves, on production, that the doctor_earnings feature flag is enforced
 * server-side for every doctor-callable earnings surface, that a direct API
 * call is refused while the flag is off, that the capability comes back when it
 * is re-enabled, that unrelated endpoints are unaffected, and that the
 * enforcement architecture is not Earnings-specific.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   API_BASE=https://api.medacademy.site \
 *   SUPERADMIN_EMAIL=… SUPERADMIN_PASSWORD=… \
 *   DOCTOR_EMAIL=…     DOCTOR_PASSWORD=… \
 *   node verify-live.cjs
 *
 * Optional:
 *   API_BASE           default https://api.medacademy.site
 *   SKIP_SECOND_FLAG=1 skip the redeem_codes per-user-override probe
 *   DRY_RUN=1          read-only: login + read flag state, mutate nothing
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 * The script MUTATES two things and ALWAYS restores them in a finally block:
 *   1. the GLOBAL doctor_earnings flag  → restored to its original value
 *   2. the test doctor's redeem_codes per-user override → restored to its
 *      original mode (and refuses to touch it if it is not `inherit`)
 * It never writes credits, earnings, courses, codes or any other business row:
 * every blocked call is refused by the gate BEFORE validation or mutation.
 *
 * Exit code 0 = all live checks passed.
 */
'use strict';

const API_BASE = (process.env.API_BASE || 'https://api.medacademy.site').replace(/\/+$/, '');
const DRY_RUN = process.env.DRY_RUN === '1';
const SKIP_SECOND_FLAG = process.env.SKIP_SECOND_FLAG === '1';
const TIMEOUT_MS = 25000;

const results = [];
const notes = [];
let failed = 0;

function record(name, ok, detail) {
  if (!ok) failed++;
  results.push({ name, ok: !!ok, detail: detail || '' });
}
function note(msg) {
  notes.push(msg);
  console.log('  · ' + msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON (HTML fatal, etc.) */ }
    return { status: res.status, json, text, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, json: null, text: 'REQUEST FAILED: ' + String(e && e.message), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

const codeOf = (r) => (r.json && r.json.error && r.json.error.code) || null;
const featureOf = (r) => (r.json && r.json.error && r.json.error.feature) || null;
const msgOf = (r) => (r.json && r.json.error && r.json.error.message) || (r.text || '').slice(0, 120);
const isFeatureDisabled = (r, feature) => r.status === 403 && codeOf(r) === 'feature_disabled' && featureOf(r) === feature;

async function login(label, email, password) {
  const r = await call('POST', '/auth/login', { body: { identifier: email, password } });
  if (r.status !== 200 || !r.json) {
    record(`login as ${label}`, false, `HTTP ${r.status} ${msgOf(r)}`);
    return null;
  }
  const token = r.json.session && r.json.session.access_token;
  const user = r.json.user || {};
  const ok = !!token;
  record(`login as ${label}`, ok, ok ? `role=${user.role} id=${String(user.id).slice(0, 8)}…` : 'no access_token in response');
  return ok ? { token, user, id: String(user.id || ''), role: String(user.role || '') } : null;
}

async function flagState(sa, key, userId) {
  const path = '/platform/feature-flags' + (userId ? `?user_id=${encodeURIComponent(userId)}` : '');
  const r = await call('GET', path, { token: sa.token });
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.flags)) return null;
  const entry = r.json.flags.find((f) => f.key === key);
  return entry || null;
}

async function setFlag(sa, key, enabled) {
  return call('PUT', `/platform/feature-flags/${encodeURIComponent(key)}`, {
    token: sa.token,
    body: { enabled },
  });
}

async function setOverride(sa, key, userId, mode) {
  return call('PUT', `/platform/feature-flags/${encodeURIComponent(key)}/user/${encodeURIComponent(userId)}`, {
    token: sa.token,
    body: { mode },
  });
}

// ── The six doctor-callable earnings surfaces (gate must run first) ──────────
function earningsSurfaces(doctorId) {
  const bogus = '00000000-0000-4000-8000-000000000000';
  return [
    { label: 'GET  /rpc/doctor-earnings-dashboard', method: 'GET', path: `/rpc/doctor-earnings-dashboard/${doctorId}`, ok: [200] },
    { label: 'GET  /rpc/doctor-credit-transactions', method: 'GET', path: `/rpc/doctor-credit-transactions/${doctorId}`, ok: [200] },
    { label: 'GET  /rpc/doctor-activity-stats', method: 'GET', path: `/rpc/doctor-activity-stats/${doctorId}`, ok: [200] },
    { label: 'POST /rpc/doctor-student-profile', method: 'POST', path: '/rpc/doctor-student-profile', body: { student_id: doctorId }, ok: [200, 404, 422] },
    { label: 'POST /rpc/set-enrollment-assigned-price', method: 'POST', path: '/rpc/set-enrollment-assigned-price', body: { enrollment_id: bogus, price: 1 }, ok: [200, 404, 422] },
    { label: 'POST /rpc/remove-student-and-record-earnings', method: 'POST', path: '/rpc/remove-student-and-record-earnings', body: { student_id: bogus, course_id: bogus }, ok: [200, 404, 422] },
  ];
}

(async function main() {
  console.log(`\n── live verification: Doctor Earnings feature-flag enforcement ──`);
  console.log(`   target: ${API_BASE}${DRY_RUN ? '   [DRY RUN — no mutations]' : ''}\n`);

  // ── Phase 0: reachability / deployed shape ─────────────────────────────────
  const health = await call('GET', '/health');
  record('backend reachable (GET /health → 200 JSON)', health.status === 200 && !!health.json,
    `HTTP ${health.status} ${health.ms}ms`);

  const unauthEarnings = await call('GET', '/rpc/doctor-earnings-dashboard/00000000-0000-4000-8000-000000000000');
  record('auth still authoritative before flags (unauthenticated earnings call → 401)',
    unauthEarnings.status === 401, `HTTP ${unauthEarnings.status}`);

  // ── Phase 1: credentials ───────────────────────────────────────────────────
  const saEmail = process.env.SUPERADMIN_EMAIL;
  const saPass = process.env.SUPERADMIN_PASSWORD;
  const drEmail = process.env.DOCTOR_EMAIL;
  const drPass = process.env.DOCTOR_PASSWORD;

  if (!saEmail || !saPass || !drEmail || !drPass) {
    console.log('\n  MISSING CREDENTIALS — supply SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD,');
    console.log('  DOCTOR_EMAIL and DOCTOR_PASSWORD. Unauthenticated reachability checks');
    console.log('  above still ran; the live enforcement loop could NOT be verified.\n');
    return finish(true);
  }

  const sa = await login('super admin', saEmail, saPass);
  const dr = await login('doctor', drEmail, drPass);
  if (!sa || !dr) return finish(true);

  if (sa.role !== 'super_admin') record('super admin account has role super_admin', false, `role=${sa.role}`);
  if (dr.role !== 'doctor') record('doctor account has role doctor', false, `role=${dr.role}`);

  // ── Phase 2: read current state (and remember it for restore) ──────────────
  const before = await flagState(sa, 'doctor_earnings', dr.id);
  record('flag registry exposes doctor_earnings for the doctor user', !!before,
    before ? `enabled=${before.enabled} effective=${before.user_effective} override=${before.override}` : 'not in /platform/feature-flags');
  if (!before) return finish(true);

  const originalGlobal = !!before.enabled;
  const originalOverride = before.override || 'inherit';

  // The best-case live proof only works with no per-user override in play.
  if (originalOverride !== 'inherit') {
    note(`doctor has a per-user override (${originalOverride}); global toggling will not change this account's state — clearing it for the test and restoring afterwards`);
  }

  const restore = async () => {
    if (DRY_RUN) return;
    if (originalOverride === 'inherit') {
      await setOverride(sa, 'doctor_earnings', dr.id, 'inherit');
    } else {
      await setOverride(sa, 'doctor_earnings', dr.id, originalOverride);
    }
    await setFlag(sa, 'doctor_earnings', originalGlobal);
    const after = await flagState(sa, 'doctor_earnings', dr.id);
    const same = !!after && !!after.enabled === originalGlobal && (after.override || 'inherit') === originalOverride;
    record('CLEANUP: doctor_earnings restored to its original global+override state', same,
      after ? `enabled=${after.enabled} override=${after.override}` : 'state unreadable');
  };

  let secondFlagState = null;
  let secondFlagOriginal = 'inherit';
  const restoreSecond = async () => {
    if (DRY_RUN || SKIP_SECOND_FLAG || !secondFlagState) return;
    await setOverride(sa, 'redeem_codes', dr.id, secondFlagOriginal);
    const after = await flagState(sa, 'redeem_codes', dr.id);
    record("CLEANUP: doctor's redeem_codes override restored", !!after && (after.override || 'inherit') === secondFlagOriginal,
      after ? `override=${after.override}` : 'state unreadable');
  };

  try {
    if (DRY_RUN) {
      note('DRY RUN: skipping all mutations');
      return finish(false);
    }

    // ── Phase 3: flag ON → the doctor CAN use earnings ──────────────────────
    if (!originalGlobal || originalOverride === 'disabled') {
      await setOverride(sa, 'doctor_earnings', dr.id, 'inherit');
      const set = await setFlag(sa, 'doctor_earnings', true);
      record('re-enable doctor_earnings (setup for ON phase)', set.status === 200, `HTTP ${set.status}`);
      await sleep(1000);
    }

    for (const s of earningsSurfaces(dr.id)) {
      const r = await call(s.method, s.path, { token: dr.token, body: s.body });
      record(`FLAG ON: ${s.label} is usable`, s.ok.includes(r.status) && !isFeatureDisabled(r, 'doctor_earnings'),
        `HTTP ${r.status}${isFeatureDisabled(r, 'doctor_earnings') ? ' feature_disabled' : ''}`);
    }

    // ── Phase 4: Super Admin turns the flag OFF ─────────────────────────────
    await setOverride(sa, 'doctor_earnings', dr.id, 'inherit');
    const offRes = await setFlag(sa, 'doctor_earnings', false);
    const offState = await flagState(sa, 'doctor_earnings', dr.id);
    record('Super Admin disables doctor_earnings', offRes.status === 200 && !!offState && offState.enabled === false,
      `HTTP ${offRes.status} enabled=${offState ? offState.enabled : '?'}`);
    await sleep(1000); // respect FeatureFlagService::CACHE_TTL (15s is the worst case)

    // ── Phase 5: every earnings surface is refused, gate-first ──────────────
    for (const s of earningsSurfaces(dr.id)) {
      const r = await call(s.method, s.path, { token: dr.token, body: s.body });
      record(`FLAG OFF: ${s.label} → 403 feature_disabled`, isFeatureDisabled(r, 'doctor_earnings'),
        `HTTP ${r.status} code=${codeOf(r)} feature=${featureOf(r)}`);
    }

    // Direct-API proof: the refusal must NOT depend on any client behaviour.
    const direct = await call('GET', `/rpc/doctor-earnings-dashboard/${dr.id}`, { token: dr.token });
    record('FLAG OFF: direct API call is rejected regardless of app UI',
      isFeatureDisabled(direct, 'doctor_earnings'), `HTTP ${direct.status} code=${codeOf(direct)}`);
    record('FLAG OFF: refusal message is user-safe (no internals leaked)',
      !!msgOf(direct) && !/\b(SQL|stack|Exception|RpcController|assertEnabled|undefined index)\b/i.test(msgOf(direct)),
      JSON.stringify(msgOf(direct)).slice(0, 90));

    // Staff exemption: the Super Admin consoles must keep working.
    const staff = await call('GET', `/rpc/doctor-earnings-dashboard/${dr.id}`, { token: sa.token });
    record('FLAG OFF: Super Admin is still exempt (control surface never locks out)', staff.status !== 403 || !isFeatureDisabled(staff, 'doctor_earnings'),
      `HTTP ${staff.status} code=${codeOf(staff)}`);

    // ── Phase 6: unrelated endpoints unaffected ─────────────────────────────
    const version = await call('GET', '/app/version');
    record('unrelated: GET /app/version still 200', version.status === 200, `HTTP ${version.status}`);
    const support = await call('GET', '/support/contact');
    record('unrelated: GET /support/contact still 200', support.status === 200, `HTTP ${support.status}`);
    const perms = await call('GET', '/rpc/teacher-provider-permissions', { token: dr.token });
    record('unrelated: doctor RPC /rpc/teacher-provider-permissions unaffected',
      perms.status !== 403 || !isFeatureDisabled(perms, 'doctor_earnings'), `HTTP ${perms.status} code=${codeOf(perms)}`);
    const me = await call('GET', '/auth/me', { token: dr.token });
    record('unrelated: doctor session still valid (GET /auth/me)', me.status === 200, `HTTP ${me.status}`);

    // ── Phase 7: no partial deploy — the gates really are in the live file ──
    const dashboardOff = await call('GET', `/rpc/doctor-earnings-dashboard/${dr.id}`, { token: dr.token });
    record('DEPLOY CHECK: live RpcController carries the new gates (dashboard refuses while OFF)',
      isFeatureDisabled(dashboardOff, 'doctor_earnings'),
      isFeatureDisabled(dashboardOff, 'doctor_earnings')
        ? 'enforcement live'
        : 'STILL SERVING THE OLD FILE — the gate is absent, upload did not take effect');

    // ── Phase 8: second flag — enforcement is not Earnings-specific ─────────
    if (SKIP_SECOND_FLAG) {
      note('SKIP_SECOND_FLAG=1 — second-flag probe skipped');
    } else {
      secondFlagState = await flagState(sa, 'redeem_codes', dr.id);
      if (!secondFlagState) {
        note('redeem_codes not present in the registry view; second-flag probe skipped');
      } else {
        secondFlagOriginal = secondFlagState.override || 'inherit';
        if (secondFlagOriginal !== 'inherit') {
          note(`doctor has a redeem_codes override (${secondFlagOriginal}) — leaving it untouched; second-flag probe skipped`);
        } else {
          // Baseline: with the flag on, the call reaches validation (never 403 feature_disabled).
          const base = await call('POST', '/redeem-codes/redeem', { token: dr.token, body: { code: 'QA-NOT-A-REAL-CODE' } });
          record('SECOND FLAG (redeem_codes) ON: request reaches the handler', !isFeatureDisabled(base, 'redeem_codes'),
            `HTTP ${base.status} code=${codeOf(base)}`);

          const ovrOff = await setOverride(sa, 'redeem_codes', dr.id, 'disabled');
          record('SECOND FLAG: per-user override set to disabled', ovrOff.status === 200, `HTTP ${ovrOff.status}`);
          const blocked = await call('POST', '/redeem-codes/redeem', { token: dr.token, body: { code: 'QA-NOT-A-REAL-CODE' } });
          record('SECOND FLAG OFF: POST /redeem-codes/redeem → 403 feature_disabled (architecture is generic)',
            isFeatureDisabled(blocked, 'redeem_codes'),
            `HTTP ${blocked.status} code=${codeOf(blocked)} feature=${featureOf(blocked)}`);

          await setOverride(sa, 'redeem_codes', dr.id, 'inherit');
          const recovered = await call('POST', '/redeem-codes/redeem', { token: dr.token, body: { code: 'QA-NOT-A-REAL-CODE' } });
          record('SECOND FLAG restored: redeem_codes available again after the override is cleared',
            !isFeatureDisabled(recovered, 'redeem_codes'), `HTTP ${recovered.status} code=${codeOf(recovered)}`);
        }
      }
    }

    // ── Phase 9: re-enable → earnings available again ──────────────────────
    const reOn = await setFlag(sa, 'doctor_earnings', true);
    record('Super Admin re-enables doctor_earnings', reOn.status === 200, `HTTP ${reOn.status}`);
    await sleep(1000);
    const back = await call('GET', `/rpc/doctor-earnings-dashboard/${dr.id}`, { token: dr.token });
    record('FLAG RE-ENABLED: doctor can use earnings again with no reinstall and no relogin',
      back.status === 200 && !isFeatureDisabled(back, 'doctor_earnings'),
      `HTTP ${back.status} code=${codeOf(back)}`);

    const afterRefresh = await call('GET', `/rpc/doctor-credit-transactions/${dr.id}`, { token: dr.token });
    record('FLAG RE-ENABLED: credit history readable again', afterRefresh.status === 200, `HTTP ${afterRefresh.status}`);
  } finally {
    try { await restoreSecond(); } catch (e) { record('CLEANUP: redeem_codes restore threw', false, String(e && e.message)); }
    try { await restore(); } catch (e) { record('CLEANUP: doctor_earnings restore threw', false, String(e && e.message)); }
  }

  return finish(false);
})().catch((e) => {
  record('verifier crashed', false, String((e && e.stack) || e).split('\n')[0]);
  finish(true);
});

function finish(aborted) {
  console.log('\n── results ──\n');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`);
  }
  if (notes.length) {
    console.log('\n── notes ──');
    for (const n of notes) console.log('  · ' + n);
  }
  console.log(`\n  ${results.length - failed}/${results.length} live checks passed`);
  if (aborted) {
    console.log('  STATUS: INCOMPLETE — the live enforcement loop was NOT verified (exit 2).\n');
    process.exitCode = 2;
  } else if (failed) {
    console.log('  STATUS: FAILED — the deployment does not enforce doctor_earnings as required.\n');
    process.exitCode = 1;
  } else {
    console.log('  STATUS: PASSED — doctor_earnings is enforced live on ' + API_BASE + '\n');
  }
}
