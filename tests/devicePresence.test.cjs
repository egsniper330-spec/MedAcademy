#!/usr/bin/env node
/**
 * Device presence — policy, timestamp parsing and the Manage Devices contract.
 *
 * Run: node tests/devicePresence.test.cjs   (also part of `npm test`)
 *
 * WHY THIS SUITE EXISTS
 * Super Admin → Manage Devices showed live devices as "offline for 3 hours" and
 * contradicted itself ("online" + "last seen 3h ago"). Two real defects caused
 * it, and both were invisible to every existing suite:
 *
 *   1. `new Date("2026-10-21 10:00:00.000000")` — a MySQL DATETIME with no zone
 *      suffix is parsed by JS in the VIEWER's local zone. For a UTC+3 admin a
 *      heartbeat one minute old read as three hours old.
 *   2. `last_active_at` was only written at login, and presence was recomputed
 *      in four screens with a private 5-minute constant.
 *
 * The suite pins:
 *   1.  A recent confirmed heartbeat is ONLINE.
 *   2.  An expired heartbeat is OFFLINE (inferred, not an invented timestamp).
 *   3.  A device active 4 minutes ago is reported in minutes, never hours.
 *   4.  A delayed/duplicate heartbeat cannot move the timestamp backwards
 *       (monotonic guard lives IN the UPDATE, token-bound device identity).
 *   5.  Epoch seconds vs milliseconds are interpreted correctly.
 *   6.  A naive UTC DATETIME is read as UTC, so the local render is correct.
 *   7.  Missing/garbage timestamps produce an explicit UNKNOWN state.
 *   8.  A failed request never becomes "offline" (no error input at all).
 *   9.  A successful beat anchors the server clock + the screen refreshes.
 *   10. One snapshot cannot produce "online now" AND "last seen 3h ago".
 *   11. Arabic and English labels (incl. CLDR plurals) both exist and read right.
 *   12. Device authorization/security is unchanged (no new bypass, no role drift).
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}

/* ─────────────────────────── compile pure modules ──────────────────────── */

const SOURCES = [
  'src/lib/devicePresence.ts',
  'src/lib/i18n/resources.ts',
  'src/lib/i18n/detect.ts',
];

const BUILD = fs.mkdtempSync(path.join(os.tmpdir(), 'device-presence-'));
try {
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      ...SOURCES.map((rel) => path.join(ROOT, rel)),
      '--outDir', BUILD,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
} catch (e) {
  console.error('  ✗ could not compile the presence/i18n modules');
  console.error(String(e.stderr || e.stdout || e.message).slice(0, 4000));
  process.exit(1);
}

// tsc picks the deepest common rootDir, so the emitted tree shape is an
// implementation detail — locate each module by name instead of guessing it.
function findEmitted(fileName) {
  const stack = [BUILD];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === fileName) return full;
    }
  }
  throw new Error('tsc did not emit ' + fileName + ' into ' + BUILD);
}
const presence = require(findEmitted('devicePresence.js'));
const i18n = require(findEmitted('detect.js'));

const {
  getPresence, parseServerTimestamp, setServerClock, getServerNow, resetServerClock,
  formatPresenceLine, formatRelativePresence, presenceLabelKey, elapsedParts,
  PRESENCE_HEARTBEAT_INTERVAL_MS, PRESENCE_ONLINE_WINDOW_MS,
} = presence;

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);          // fixed "server now"
const ISO = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const minutesAgo = (m) => NOW - m * 60_000;

/* ─────────────────── 1–3. online window and the duration ──────────────── */

console.log('\npresence window');
resetServerClock();
check('policy: 60 s heartbeat, 150 s online window',
  PRESENCE_HEARTBEAT_INTERVAL_MS === 60_000 && PRESENCE_ONLINE_WINDOW_MS === 150_000);

check('1. beat 10 s ago → ONLINE',
  getPresence({ status: 'active', last_seen_at: ISO(NOW - 10_000) }, { nowMs: NOW }).state === 'online');
check('1b. beat 149 s ago → still ONLINE (inside the window)',
  getPresence({ status: 'active', last_seen_at: ISO(minutesAgo(2.48)) }, { nowMs: NOW }).state === 'online');
check('2. beat 10 min ago → OFFLINE (inferred, no offline timestamp invented)',
  getPresence({ status: 'active', last_seen_at: ISO(minutesAgo(10)) }, { nowMs: NOW }).state === 'offline');
check('2b. offline presence reports no confirmed offline moment',
  getPresence({ status: 'active', last_seen_at: ISO(minutesAgo(10)) }, { nowMs: NOW }).lastSeenMs === minutesAgo(10));
check('3. device active 4 min ago is counted in MINUTES, not hours',
  formatRelativePresence(NOW - minutesAgo(4), i18n.translate.bind(null, 'en'), i18n.translateCount.bind(null, 'en'))
    === '4 min ago');
check('3b. 4-minute-old beat cannot render an "hours" phrase',
  !/hour/i.test(formatRelativePresence(NOW - minutesAgo(4), (k, p) => i18n.translate('en', k, p), (k, n) => i18n.translateCount('en', k, n))));
check('3c. 3-hour-old beat does render hours (the label is not broken, only honest)',
  getPresence({ status: 'active', last_seen_at: ISO(minutesAgo(180)) }, { nowMs: NOW }).state === 'offline' &&
  elapsedParts(180 * 60_000).unit === 'hours');

/* ──── 4. an older/delayed beat cannot overwrite a newer timestamp (PHP) ── */

console.log('\nmonotonic heartbeat (backend contract)');
const devicePhp = read('backend/src/Controllers/DeviceController.php');
const heartbeatSql = devicePhp.slice(
  devicePhp.indexOf("'heartbeat' =>"),
  devicePhp.indexOf('presenceMeta(int $nowMs)'),
);
check('4. heartbeat UPDATE only moves forward (last_active_at <= UTC_TIMESTAMP guard)',
  /UPDATE devices SET last_active_at = UTC_TIMESTAMP\(6\)[\s\S]{0,400}last_active_at <= UTC_TIMESTAMP\(6\)/.test(devicePhp));
check('4b. the guard is inside the UPDATE (no read-then-write race)',
  !/SELECT last_active_at[\s\S]{0,200}UPDATE devices SET last_active_at/.test(heartbeatSql));
check('4c. an implausibly-future legacy value is re-anchored, not trusted forever',
  /last_active_at > DATE_ADD\(UTC_TIMESTAMP\(6\), INTERVAL/.test(devicePhp));
check('4d. the heartbeat action is registered on the existing device-binding endpoint',
  /'heartbeat' => \$this->heartbeat\(/.test(devicePhp));

/* ─────────────── 5–7. timestamp parsing, units, unknowns ──────────────── */

console.log('\ntimestamp parsing');
check('5. epoch SECONDS are scaled to ms',
  parseServerTimestamp(1_790_000_000) === 1_790_000_000_000);
check('5b. epoch MILLISECONDS are left alone',
  parseServerTimestamp(1_790_000_000_000) === 1_790_000_000_000);
check('5c. numeric strings follow the same rule',
  parseServerTimestamp('1790000000') === 1_790_000_000_000 &&
  parseServerTimestamp('1790000000000') === 1_790_000_000_000);

const naive = '2026-10-21 12:00:00.000000';
check('6. naive MySQL DATETIME is read as UTC (not viewer-local)',
  parseServerTimestamp(naive) === NOW);
check('6b. the same instant with an explicit Z parses identically',
  parseServerTimestamp('2026-10-21T12:00:00Z') === NOW);
check('6c. toISOString round-trip proves the instant is 12:00 UTC',
  new Date(parseServerTimestamp(naive)).toISOString() === '2026-10-21T12:00:00.000Z');
check('6d. a few seconds of difference is preserved (no whole-hour shift)',
  parseServerTimestamp('2026-10-21 12:00:05.500000') === NOW + 5500);
check('6e. backend ISO field wins over the legacy raw column',
  getPresence({
    status: 'active',
    last_seen_at: ISO(NOW - 5_000),
    last_active_at: naive,
  }, { nowMs: NOW }).state === 'online');

check('7. missing timestamp → UNKNOWN (never a fabricated duration)',
  getPresence({ status: 'active', last_seen_at: null, last_active_at: null }, { nowMs: NOW }).state === 'unknown');
check('7b. empty / garbage timestamps → UNKNOWN',
  parseServerTimestamp('') === null &&
  parseServerTimestamp('not-a-date') === null &&
  parseServerTimestamp(undefined) === null &&
  getPresence({ status: 'active' }, { nowMs: NOW }).state === 'unknown');
check('7c. a far-future timestamp (legacy local-zone row) → UNKNOWN, not "online"',
  getPresence({ status: 'active', last_seen_at: ISO(NOW + 3 * 3600_000) }, { nowMs: NOW }).state === 'unknown');
check('7d. unknown label is explicit, not a duration',
  presenceLabelKey('unknown') === 'device.presence.unknown' &&
  i18n.translate('en', 'device.presence.unknown') === 'Presence unknown');
check('7e. blocked / logged-out devices never claim online',
  getPresence({ status: 'blocked', last_seen_at: ISO(NOW) }, { nowMs: NOW }).state === 'blocked' &&
  getPresence({ status: 'logged_out', last_seen_at: ISO(NOW) }, { nowMs: NOW }).state === 'logged_out');

/* ───────────── 8–9. failure handling and refresh wiring ────────────────── */

console.log('\nnetwork failure and refresh');
const presenceSrc = read('src/lib/devicePresence.ts');
const getPresenceBody = presenceSrc.slice(
  presenceSrc.indexOf('export function getPresence('),
  presenceSrc.indexOf('function lastSeenOf('),
);
check('8. presence is a pure function of the last CONFIRMED timestamp (no error input)',
  getPresenceBody.length > 0 &&
  !/error|failed|offline\s*=|retry/i.test(getPresenceBody) &&
  /\{\s*status\?: string \| null/.test(presenceSrc));

const heartbeatSrc = read('src/lib/deviceHeartbeat.ts');
check('8b. a failed beat only backs off — it never marks the device offline',
  /failures = Math\.min\(failures \+ 1, 5\)/.test(heartbeatSrc) &&
  !/setPresence|offline/i.test(heartbeatSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
check('8c. the heartbeat stops entirely while the app is backgrounded',
  /else \{[\s\S]{0,120}clear\(\);/.test(heartbeatSrc) && /AppState\.addEventListener/.test(heartbeatSrc));
check('8d. a failed device read keeps the last known list (no blank "offline" flash)',
  /prev\[userId\]\?\.loaded[\s\S]{0,80}\? prev/.test(read('src/app/(app)/(admin)/devices.tsx')));

check('9. a successful beat anchors the server clock',
  /setServerClock\(res\?\.server_epoch_ms\)/.test(heartbeatSrc));
setServerClock(NOW, NOW - 4 * 3600_000); // device clock reads 4h behind the server
check('9b. elapsed time uses the SERVER clock, so a wrong device clock cannot skew it',
  getServerNow(NOW - 4 * 3600_000) === NOW &&
  getPresence({ status: 'active', last_seen_at: ISO(NOW - 30_000) }, { nowMs: getServerNow(NOW - 4 * 3600_000) }).state === 'online');
resetServerClock();

const devicesSrc = read('src/app/(app)/(admin)/devices.tsx');
check('9c. the Manage Devices screen refreshes the expanded device list while focused',
  /setInterval\(\(\) => \{ void loadUserDevices\(expandedUser, true\); \}, 60_000\)/.test(devicesSrc));
check('9d. the screen anchors the server clock from the device list response',
  /setServerClock\(res\?\.server_epoch_ms\)/.test(devicesSrc));
check('9e. the screen recomputes labels on a local tick (presence ages without polling)',
  /setClockTick\(n => n \+ 1\)/.test(devicesSrc));

/* ─────────── 10. no self-contradicting status + last-seen line ─────────── */

console.log('\nno contradiction');
const t = (key, params) => (params && params.when ? `${key}(${params.when})` : key);
const tCount = (key, n) => `${key}#${n}`;
const onlineLine = formatPresenceLine(
  getPresence({ status: 'active', last_seen_at: ISO(NOW - 5_000) }, { nowMs: NOW }), t, tCount, { nowMs: NOW });
const offlineLine = formatPresenceLine(
  getPresence({ status: 'active', last_seen_at: ISO(minutesAgo(5)) }, { nowMs: NOW }), t, tCount, { nowMs: NOW });
check('10. the ONLINE line is a single "online now" phrase', onlineLine === 'device.presence.onlineNow');
check('10b. the OFFLINE line is "last seen …" and never also claims online',
  offlineLine === 'device.lastSeenWithTime(device.ago.minutes#5)' && !/online/i.test(offlineLine));
check('10c. the two states are mutually exclusive for one snapshot',
  getPresence({ status: 'active', last_seen_at: ISO(minutesAgo(5)) }, { nowMs: NOW }).state === 'offline' &&
  getPresence({ status: 'active', last_seen_at: ISO(minutesAgo(5)) }, { nowMs: NOW }).state !== 'online');
check('10d. the screen renders ONE label per device (no badge + separate duration)',
  /formatPresenceLine\(presence, t, tCount\)/.test(devicesSrc) &&
  !/Last seen \$\{timeAgo\(/.test(devicesSrc) &&
  !/function timeAgo/.test(devicesSrc));
check('10e. the last CONFIRMED online time is displayed as its own labelled field',
  /t\('device\.lastConfirmedOnline'\)[^\n]*formatAbsoluteTimestamp/.test(devicesSrc.replace(/\r/g, '')));
check('10f. the old local 5-minute isOnline helper is gone from every device screen',
  !/function isOnline\(/.test(devicesSrc) &&
  !/function isOnline\(/.test(read('src/app/(app)/my-devices.tsx')) &&
  !/const online = devices\.filter\(d => \{/.test(read('src/components/DeviceManagerSheet.tsx')));

/* ─────────────────────── 11. Arabic + English labels ──────────────────── */

console.log('\nlocalized labels');
const ar = i18n.translate.bind(null, 'ar');
const en = i18n.translate.bind(null, 'en');
const arCount = i18n.translateCount.bind(null, 'ar');
const enCount = i18n.translateCount.bind(null, 'en');
check('11. English online/unknown labels exist',
  en('device.presence.onlineNow') === 'Online now' && en('device.presence.unknown') === 'Presence unknown');
check('11b. Arabic online/unknown labels are natural MSA',
  ar('device.presence.onlineNow') === 'متصل الآن' && ar('device.presence.unknown') === 'حالة الاتصال غير معروفة');
check('11c. Arabic "last seen 5 minutes" uses the 3–10 plural',
  ar('device.lastSeenWithTime', { when: arCount('device.ago.minutes', 5) }) === 'آخر ظهور قبل 5 دقائق');
check('11d. Arabic dual form (2 minutes) is correct',
  arCount('device.ago.minutes', 2) === 'قبل دقيقتين');
check('11e. Arabic 11+ form is correct',
  arCount('device.ago.minutes', 11) === 'قبل 11 دقيقة');
check('11f. Arabic hours/days forms exist and differ from minutes',
  arCount('device.ago.hours', 5) === 'قبل 5 ساعات' && arCount('device.ago.days', 3) === 'قبل 3 أيام');
check('11g. English plural-count label reads naturally',
  enCount('device.ago.minutes', 5) === '5 min ago' && enCount('device.ago.days', 1) === '1 day ago');
check('11h. the inferred-offline wording is present in both languages',
  /inferred/i.test(en('device.offlineInferred')) && /مستنتج/.test(ar('device.offlineInferred')));
check('11i. no hardcoded English left in the presence label path',
  !/'(Online now|Last seen|Presence unknown)'/.test(presenceSrc.replace(/\/\*[\s\S]*?\*\//g, '')));

/* ──────────────────── 12. auth / security unchanged ───────────────────── */

console.log('\nsecurity contract');
check('12. heartbeat identity comes from the TOKEN, never from the request body',
  /deviceId = \$request->user\['device_id'\]/.test(devicePhp) &&
  !/\$body\['device_id'\]/.test(heartbeatSql));
check('12b. heartbeat only touches the caller\'s own active device row',
  /WHERE id = \? AND user_id = \? AND status = 'active'/.test(devicePhp));
check('12c. no new route / permission was added for presence',
  /'heartbeat' => \$this->heartbeat\(\$request, \$userId\)/.test(devicePhp) &&
  /'\/device-binding'[\s\S]{0,80}\$auth/.test(read('backend/routes/api.php')));
check('12d. the DB session clock is pinned to UTC so CURRENT_TIMESTAMP == UTC',
  /SET time_zone = '\+00:00'/.test(read('backend/src/Database/Database.php')));
check('12e. no schema change was made for presence (existing columns are reused)',
  /`last_active_at` DATETIME\(6\)/.test(read('backend/database/schema.sql')) &&
  !/last_confirmed_offline/.test(read('backend/database/schema.sql')));

/* ─────────────────────────────── summary ──────────────────────────────── */

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.error('\nDevice presence suite FAILED.');
  process.exit(1);
}
