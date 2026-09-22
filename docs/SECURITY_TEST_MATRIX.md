# Security Detection — Physical Device Test Matrix

Companion to the root-cause audit that fixed the **"Screen Overlay Detected"** and
**"App Integrity Compromised"** false positives on a clean physical device.

Legend:

- **SOURCE VERIFIED** — behavior confirmed by reading the code path end-to-end.
- **PHYSICAL DEVICE VERIFIED** — requires executing on the actual test device; the
  implementing agent cannot perform these steps.

---

## Test 1 — Clean official app, no VPN, no overlay, normal login → ALLOW

| Step | Action | Expected |
|------|--------|----------|
| 1 | Install the release APK (direct download — this is the sanctioned channel) | Installer shows as unknown/direct-download; this is telemetry only |
| 2 | Launch app | `getSecurityFlags` logcat shows `overlay=false tamper=false` |
| 3 | Log in | Login proceeds; no security-warning screen |
| 4 | Observe risk score | `0` unless other independent signals fire |

Root causes being verified:
- Overlay no longer fires on the >5 overlay-capable-apps capability heuristic.
- Integrity no longer fires on `installer != com.android.vending`.

**Status: PHYSICAL DEVICE VERIFICATION REQUIRED** (logic: SOURCE VERIFIED)

---

## Test 2 — Login, then enable VPN, return to app → detected + re-evaluated

| Step | Action | Expected |
|------|--------|----------|
| 1 | Log in with no VPN | Session established |
| 2 | Enable VPN (WireGuard/OpenVPN/system) while app stays open | Native `ConnectivityManager.NetworkCallback` fires `onAvailable` → emits `vpnStateChanged(true)` within seconds |
| 3 | JS receives event | `[SecurityContext][VpnCallback] vpnStateChanged event received vpnActive=true` in console/logcat |
| 4 | Re-check runs (1.5 s debounce) | `vpn_detected` threat logged to backend `security_events` with evidence metadata |
| 5 | Policy evaluation | Server policy for `vpn` (default `block_login`) triggers redirect to `/security-warning` |

Belt-and-suspenders: NetInfo listener fires on any network-state change, and the
30 s periodic check also catches the VPN. **No logout/login is required.**

**Status: PHYSICAL DEVICE VERIFICATION REQUIRED** (logic: SOURCE VERIFIED)

---

## Test 3 — Login, then disable VPN, return to app → state clears

| Step | Action | Expected |
|------|--------|----------|
| 1 | With VPN active and warning shown, disable VPN | NetworkCallback `onLost` → `detectVpn()` re-check → `vpnStateChanged(false)` |
| 2 | Return app to foreground | Foreground re-check (VPN re-check path: `hasActiveVpnThreat=true` → 1.5 s debounce) runs fresh |
| 3 | Observe result | `vpn_detected` absent from new result; stale state cleared; app usable |

**Status: PHYSICAL DEVICE VERIFICATION REQUIRED** (logic: SOURCE VERIFIED)

---

## Test 4 — Normal official app, no tampering → integrity NOT compromised

| Step | Action | Expected |
|------|--------|----------|
| 1 | Install release APK built from this repo (debug-keystore-signed build) | Runtime cert = `FA:C6:17:45:…:3B:9C` (debug keystore) |
| 2 | Launch app | `signatureValid=true` when no expected pin configured (check UNAVAILABLE, not failed); `tampered=false` |
| 3 | Log in | No `App Integrity Compromised` entry; risk score has no +40 tamper component |
| 4 | Backend `security_events` | Events (if any) carry `metadata.expected_cert_configured=false` — evidence quality recorded |

To pin properly later: set `security_config.expected_cert_sha256s` to the SHA-256
of the REAL production signing cert (Play App Signing cert if Play-distributed),
then `signatureValid` becomes a verified match instead of unavailable.

**Status: PHYSICAL DEVICE VERIFICATION REQUIRED** (logic: SOURCE VERIFIED —
the shipped `app-release.apk` was verified to be signed by the debug keystore
and to contain no `EXPECTED_CERT_SHA256` in BuildConfig)

---

## Test 5 — Background app, change security condition, foreground → re-checked

| Step | Action | Expected |
|------|--------|----------|
| 1 | Log in, background the app | — |
| 2 | Enable Developer Options (or VPN) | — |
| 3 | Foreground the app | `(app)/_layout` AppState listener calls `reset()` + `check()`; SecurityContext also re-runs |
| 4 | Observe | New state detected without re-login; blocking threats redirect to `/security-warning` |

**Status: PHYSICAL DEVICE VERIFICATION REQUIRED** (logic: SOURCE VERIFIED)

---

## Test 6 — Security condition changes while app remains foreground → detected if platform supports

| Signal | Mechanism | Classification |
|--------|-----------|----------------|
| VPN | Native `NetworkCallback` push event (ms latency) + NetInfo listener + 30 s periodic | REAL-TIME EVENT + PERIODIC CHECK |
| Debugger attach | 30 s periodic `Debug.isDebuggerConnected()` | PERIODIC CHECK |
| Developer options / ADB | 30 s periodic (Settings.Global reads) | PERIODIC CHECK |
| Screen recording | `getRunningServices` snapshot at check time | PERIODIC CHECK (polling only; MediaProjection cannot be observed push-style without an accessibility service) |
| Overlay | No public API to observe other apps' windows | NOT POSSIBLE TO MONITOR RELIABLY (targeted capability check only) |
| Root / Magisk / Xposed / Frida / emulator / mock location | Filesystem + proc + package scans at check time | PERIODIC CHECK (state can change post-login and is re-read each cycle) |
| App integrity | Signature + libs re-read each cycle; Play Integrity token rate-limited 10 min | PERIODIC CHECK + SERVER VERDICT |
| Security policy / config | 30 s policy cache TTL; 15-min config refresh; refresh on foreground | PERIODIC CHECK |
| Device block / registration status | Enforced server-side at request time | SERVER-ONLY |

**Status: SOURCE VERIFIED** (live-fire confirmation of each row requires the device)

---

## Test 7 — Legitimate accessibility service → no false overlay block

| Step | Action | Expected |
|------|--------|----------|
| 1 | Enable a legitimate accessibility service (e.g. TalkBack, screen reader) | — |
| 2 | Launch app + log in | No `overlay_detected` — accessibility capability was never part of the overlay verdict (only the 4 known abuse packages are), and the aggregate count is evidence-only |

**Status: PHYSICAL DEVICE VERIFICATION REQUIRED** (logic: SOURCE VERIFIED)

---

## Test 8 — Actual suspicious overlay → detected

| Step | Action | Expected |
|------|--------|----------|
| 1 | Install an app on the known abuse list (e.g. `com.mobizen.miing.service`) and grant it overlay permission | — |
| 2 | Launch app + log in | `overlay_detected` fires; `overlayCapableAppsCount` in event metadata includes the abusive package |

Honest limitation: a *non-listed* malicious overlay app cannot be proven active
from a regular app on modern Android — the platform does not expose other apps'
windows. The backend admin can extend `abusiveOverlayPackages` as new abuse
tools are identified.

**Status: PHYSICAL DEVICE VERIFICATION REQUIRED** (logic: SOURCE VERIFIED)

---

## Test 9 — App restart after a previously detected issue → stale issues do not survive

| Step | Action | Expected |
|------|--------|----------|
| 1 | Trigger a transient detection (e.g. VPN), then remove the condition | — |
| 2 | Kill + restart app | Every check is recomputed fresh from native state — no persisted threat flags in JS (result state is React state only; `reset()` clears on logout) |
| 3 | Observe | Clean device shows clean score; old events remain in `security_events` as HISTORY (rows are append-only by design) but do not feed current enforcement |

**Status: PHYSICAL DEVICE VERIFICATION REQUIRED** (logic: SOURCE VERIFIED)

---

## Test 10 — Account switch → security state scoped to active account/device

| Step | Action | Expected |
|------|--------|----------|
| 1 | Log out | `invalidateSecurityConfig()` + `clearAppAttestKey()` + `invalidatePolicyCache()` run; scheduler tears down |
| 2 | Log in as a different account | Fresh config + policy fetch; fresh session-start security check; device binding scoped by `installation_id` server-side |

**Status: PHYSICAL DEVICE VERIFICATION REQUIRED** (logic: SOURCE VERIFIED)

---

## VPN lifecycle coverage matrix (Part 5 of the audit)

| Scenario | Primary trigger | Coverage |
|----------|-----------------|----------|
| VPN enabled while app foreground | Native `vpnStateChanged(true)` event | ✅ real-time |
| VPN enabled while app backgrounded | Event fires natively regardless of app state; JS handler runs check on next active + 30 s tick + NetInfo on reconnect | ✅ |
| VPN enabled, app killed, app restarted | `getSecurityFlags` re-measures at session-start check (immediate on session) | ✅ startup |
| VPN disabled while app foreground | `vpnStateChanged(false)` → fresh check clears state | ✅ real-time |
| VPN on the whole session | 30 s periodic re-check re-reports each cycle | ✅ periodic |

Backend receives every threat event (batched, evidence-bearing) and re-serves
policy on the next fetch — policy remains authoritative server-side.
