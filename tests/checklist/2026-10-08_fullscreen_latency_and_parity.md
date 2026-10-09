# 2026-10-08 — Plyr fullscreen latency + safe-area/parity pass (source-level)

## Root cause of the Plyr fullscreen delay (measured from source, not guessed)

Entry path before this pass, in this exact order:

1. tap → capture-phase intercept in `src/lib/plyr/playerScript.ts` → `postMessage` to RN,
2. **`await` the security gate** — `shouldAllowFullscreen()` → `checkBeforeVideo()` →
   `runGuardedCheck()` → `runSecurityChecks()`, which runs 14 detectors in `Promise.all`
   including the **network-bound** `runPlayIntegrityCheck()` (backend nonce → Google →
   backend verify) and `await getSecurityPolicies()` (server policy fetch),
3. `setIsFullscreen(true)`,
4. the orientation effect runs `lockAsync(LANDSCAPE)`,
5. the OS rotation animation plays.

So the user waited for **(network-bound security evaluation) + (rotation animation)**
serialized. It is not a timer — it is a network round-trip in front of the visible
transition. `DETECTOR_TIMEOUT_MS` bounds the worst case, which is why the delay is
"noticeable" rather than infinite.

## Fix implemented (ordering only — no protection weakened)

`src/lib/fullscreenOrientation.ts` (new): `beginFullscreenOrientation()` /
`releaseFullscreenOrientation()`, Android-only, fire-and-forget, timer-free.

Wired into all three native players (`YouTubePlayer`, `VdoCipherPlayerNativeAdapter.native`,
`OfflineVideoPlayer.native`): the rotation is requested **before** the gate await, so the
rotation overlaps the security evaluation. Guarantees preserved:

* the gate is still awaited and fullscreen is still only committed after the verdict;
* every denial/error path calls `releaseFullscreenOrientation()`, so a refused request
  never strands the device in landscape;
* the existing `isFullscreen` effects remain the steady-state lock/unlock owner (unchanged);
* no timers, no player recreation, same WebView/VdoPlayerView instance.

## Fix 2 (user-approved): instant entry on the LIVE verdict

The remaining latency was the awaited verdict itself, so entry now reads the host's
already-published authoritative verdict **synchronously** via a new optional prop
`fullscreenVerdictNow()` (hosts pass `isSuperAdmin || !blocksVideo`, or `!blocksVideo`
offline). Fullscreen commits in the same frame as the tap.

The authoritative gate is **not** skipped — it re-validates in parallel and collapses:

| Player | Parallel re-validation | Collapse on denial |
|---|---|---|
| Plyr/YouTube | background `await gate()` started right after commit | `setIsFullscreen(false)` |
| VdoCipher offline | background `await shouldAllowPlayback()` | `setIsFullscreen(false)` + `setGateDenied(true)` |
| VdoCipher online | existing live gate mirror (immediate + every 5s) | `setIsFullscreen(false)` |

Fail-closed on both sides: a `false`/throwing sync verdict never expands, and a background
denial always collapses. The blocking path is preserved verbatim as the fallback when a
host supplies no verdict, so gateless/other surfaces keep the old semantics.

**Related latent bug fixed:** a verdict flip (`blocksVideo`) while fullscreen unmounts the
player, but the lesson screen's own fullscreen layout state stayed true — hiding the
header/back control with no player and no exit affordance. The lesson screen now collapses
fullscreen whenever the verdict flips (`useEffect` on `blocksVideo`).

## Safe-area fix (iOS-facing, found during the UI audit)

The Plyr/YouTube fullscreen exit control used a hardcoded `top: 12, left: 12` while the
offline and VdoCipher players used `Math.max(12, insets.top + 8)`. On iOS (notch/Dynamic
Island) and on Android cutouts the Plyr exit control sat under the status area.

Fixed to the shared convention in all three players: `top: Math.max(12, insets.top + 8)`,
`left: Math.max(12, insets.left + 8)` (the left inset matters in landscape).

## iOS parity — SOURCE-LEVEL ONLY

No iOS device/runner exists in this environment, so this is explicitly **source-level**
verification, not physical:

| Area | Result |
|---|---|
| Feature flags | one platform-agnostic client lib; re-hydration in the app shell on both platforms; enforcement is server-side PHP |
| Doctor Earnings | no platform exemption in the drawer / earnings screen / doctor profile gates |
| Profile photo Remove | one shared control for both roles; iOS photo-library permission declared; cross-platform APIs only |
| Fullscreen | Android-only helpers no-op on iOS; iOS never locks orientation; ONE in-place player (no second window/player); status bar hidden; watermark present |
| Safe area | root `SafeAreaProvider`; all three fullscreen exit controls inset-aware after this pass |
| Native iOS fixes | delivered through `plugins/*` config plugins (`withDangerousMod`/mods) — generated `ios/` untouched |

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `node tests/fullscreenLatency.test.cjs` (new, rewritten for the instant-entry contract) | 72 checks PASS |
| `node tests/iosParity.test.cjs` (new) | 52 checks PASS |
| `node tests/avatarUploadPipeline.test.cjs` (Part C added) | 123 checks PASS |
| `node tests/systemBarsPlugin.test.cjs` (new) | 29 checks PASS |
| `node tests/featureFlagEnforcement.test.cjs` (new) | 76 checks PASS |
| full `tests/*.test.cjs` suite (41 files) | 0 suites failing |

## Still not verified — needs the device / credentials / server

1. Physical Android: Plyr + VdoCipher fullscreen, rotation, watermark, back, re-entry
   (`adb devices` reported the tablet `offline` for the whole pass).
2. Doctor-account end-to-end feature-flag loop (needs a doctor login).
3. Backend upload of `RpcController.php` + live `verify-live.cjs` run (needs cPanel access).
4. Rollout of the `withSystemBars` plugin (requires a prebuild + APK rebuild to take effect).
