# VPN / proxy mandatory block — implementation and deployment

Two reported defects, one document:

1. **iOS**: VPN detection worked, but the app still showed the *dismissible*
   security-warning screen with a **`Continue Anyway`** button. Tapping it let
   the user into the app and allowed API requests while the VPN was active.
2. **Startup**: an initial **`Checking for updates`** wall delayed the normal
   splash/sign-in experience.

---

## 1. Root cause of the `Continue Anyway` bypass

The client is fully server-driven: `getSecurityPolicies()`
([src/lib/security.ts](../src/lib/security.ts)) merges the authoritative
`security_policies` rows over the bundled defaults, and the app's decision comes
from that table alone
(`evaluateSecurityResult` → `blocksLogin` / `hasWarnings` in
[src/lib/securityStateModel.ts](../src/lib/securityStateModel.ts)).

* The bundled default already said `vpn → block_login`; `proxy` was `warn_only`.
* Therefore the observed *warn-level* behaviour on the iPhone was produced by
  the **stored row** resolving `vpn`/`proxy` to `warn_only` (or being disabled).
  A configuration value was allowed to downgrade a connection-security **block**
  into a **dismissal** — and the dismissible warning path is the only surface in
  the app that renders a `Continue Anyway` button.
* `docs/DEVICE_VALIDATION_CHECKLIST.md` §10 had already documented this split
  ("If your server's authoritative `security_policies` resolves VPN/proxy to
  `warn_only`, you instead get the dismissible security-warning screen").
* Deep-linking into the warning screen was a second, independent way to reach a
  dismissable surface: `/(app)/security-warning?blocksLogin=false` and the
  pre-login `/(auth)/security-warning` variant both derived their decision from
  route params, so the button could be presented even when the verdict said
  otherwise.

## 2. What changed — a confirmed VPN/proxy always blocks

The rule is enforced in **four** places, so no single weak link re-opens the
dismissible path:

| Plane | Change |
|---|---|
| **Client policy table** | `applyMandatoryConnectionFloor()` (securityStateModel.ts) forces `vpn`/`proxy` to at least `block_login` in the merged table — a `warn_only`/disabled row, an offline launch and a stale 5-minute cache are all covered. |
| **Client defaults** | `DEFAULT_POLICIES.proxy` is `block_login` (was `warn_only`). |
| **Server payload** | `SecurityController::policies()` serves the floor for `vpn`/`proxy` (`MANDATORY_FLOOR`) — retro-fits installed clients, which read only this endpoint. |
| **Server writes** | `UPDATE /admin/security/policies/{type}` refuses any weakening of `vpn`/`proxy` (`MANDATORY_BLOCK`, HTTP 422) — the stored row can no longer be downgraded or disabled from the admin UI. |

### UI

* **SecurityGate** ([src/app/(app)/security-gate.tsx](../src/app/(app)/security-gate.tsx))
  renders a dedicated mandatory page for `BLOCKED_VPN`: title/message from
  `VPN_WARNING_COPY`, a **HOW TO TURN IT OFF** list from
  `connectionBlockInstructions(platform)` (iOS Settings / VPN app / Wi-Fi proxy
  steps, Android equivalents), the finding list, and a **Verify security and
  continue** control that *requests* a re-check. The control cannot open the
  gate: only a fresh authoritative evaluation with no connection finding clears
  it. There is no dismiss, no back route, and the gate is inline content above
  the whole authenticated Stack.
* **`(app)/security-warning.tsx`** and **`(auth)/security-warning.tsx`**: the
  dismiss path is suppressed whenever a connection finding is live — the branch
  is chosen from the **finding types**, not from the `blocksLogin` param, so a
  deep link or a stale param cannot re-open it. Pre-login, the only forward
  action is "I turned it off — try again" (returns to sign-in, which re-runs the
  check before any session exists).

### Re-detection

Access is restored only by a fresh evaluation: the native `vpnStateChanged`
event (iOS/Android), every background→foreground return, the periodic check and
the in-page re-verify control all funnel through the same authoritative
pipeline. A stale cached verdict cannot clear a live block.

### Server-side enforcement for protected APIs

* The served policy floor above is what the client's gate follows.
* `SecurityEvidenceService::deriveAssurance()` now treats a live **proxy** flag
  as a **blocking** signal (it was a warning), matching the new policy; a live
  **VPN** was already blocking. With the operator-set `enforce_strict` tier, that
  pushes assurance to `BLOCKED` and `assertEvidenceAllowed()` rejects the
  protected actions it guards (`/video/otp`, `/video/offline-authorize`,
  `/credits/redeem`, device registration) with HTTP 403.
* `SecurityRiskService::assertRiskAllowed()` (opt-in, default `log_only`) can
  already enforce the same for aggregated `vpn`-class events.
* **Not implemented, deliberately:** a new always-on server gate keyed on
  client-reported VPN state. The server cannot observe the device's tunnel, so
  such a gate would rest entirely on client assertions (no gain over the client
  gate, fully strippable by a patched client) while risking permanent lockouts —
  clients report *detections* only, so a one-off VPN event would keep a user
  blocked until an operator cleared it. The two existing opt-in gates remain the
  server-side lever.

## 3. iOS detection and its limits (do not overstate)

* Authoritative path: `IOSSecurityModule` two-gate check — `NWPathMonitor`
  (non-standard active interface type) **plus** `getifaddrs` with `IFF_UP`
  (`utun*`/`ipsec*`/`ppp*` actually up). Both must agree; that is what removed
  the historical 100 % false-positive rate from iOS's permanent `utun0/1/2`.
* **No API names the VPN vendor**, and no app can stop another app's tunnel —
  which is why the block screen *instructs* rather than acting.
* Without the native module, the detector falls back to NetInfo `type === 'vpn'`
  only, which **misses** packet-tunnel VPNs (WireGuard, OpenVPN, Tailscale,
  Cloudflare WARP — they report `wifi`/`other`). That weaker result is no longer
  presented as a verified clean device: it is reported as evidence
  (`vpn_detection_degraded`, weight 0, `log_only`, never blocking) and the signal
  path (`native` / `netinfo-fallback` / `unavailable`) is logged with every check
  (`metadata.vpn_signal_path`), so "could not verify" is auditable.
* Accepted gaps: DNS-only VPNs, per-app VPNs that never become the active path,
  and iCloud Private Relay (Apple surfaces it as `.wifi`/`.cellular`).
* Proxy detection uses `CFNetworkCopySystemProxySettings` (HTTP/HTTPS/SOCKS); a
  PAC/auto-config URL is reported as a proxy configuration.
* A detector that throws or times out is reported as degraded/unavailable — it is
  **never** silently classified as clean, and it never blocks on its own (an
  unreliable heuristic must not lock out ordinary Wi-Fi/mobile-data users).

## 4. Startup: the update check is a background request

`ForceUpdateGate` ([src/app/_layout.tsx](../src/app/_layout.tsx)) no longer
gates the whole app. The decision is surface-aware
(`resolveUpdateGateDecision`): the splash, sign-in and other public/auth screens
are **never** blocked by the version check, while the authenticated shell waits
(`pending`) or is replaced (`required`). Defense in depth: the `(app)` shell
enforces the same decision locally, and the server's HTTP 426 rejection still
guards every protected API call.

Supporting service changes
([updateConfigService.ts](../src/lib/updateConfigService.ts)):

* **Deduplication** — concurrent triggers (cold start, `AppState` active, offline
  transition, a screen's own re-check) share one in-flight request.
* **Stale-response guard** — a request generation counter; an HTTP 426 or a newer
  check supersedes a response that was already on the wire, so a late
  "SUPPORTED" can no longer clear an authoritative `UPDATE_REQUIRED`.
* **Cached verdict for the installed build** — a cached `SUPPORTED` written for
  *this* build (≤ 14 days, `update_policy_cache_v2` semantics) resolves the
  pending state immediately instead of waiting for the network; the live check
  still overwrites it, and a cached `UPDATE_REQUIRED` is still honored
  fail-closed. With no cache the protected shell waits for the live answer.
* **Unmount safety** — `ForceUpdateScreen`'s async handlers no longer set state
  after the screen is gone.

## 5. Deploying

Upload these backend files to the live server (they are runtime code, not
build-time assets):

| File | Why |
|---|---|
| `backend/src/Controllers/SecurityController.php` | serves the vpn/proxy floor + refuses weakening writes |
| `backend/src/Services/SecurityEvidenceService.php` | live proxy = blocking evidence signal |
| `backend/database/mysql-migrations/033_vpn_proxy_mandatory_block.sql` | upgrades the stored `vpn`/`proxy` rows to `block_login` (run it against the DB) |

Run the migration once (phpMyAdmin / `mysql` CLI) and verify the final `SELECT`
printed by the file shows `vpn` and `proxy` as `block_login | 1`.

**No client rebuild is required for the server half**: the served floor fixes
already-installed builds. The full fix (mandatory gate page, deep-link
suppression, silent update check) ships with the next app build, because those
are client UI/flow changes.

Nothing in this document was deployed, built, or run against the live server.
