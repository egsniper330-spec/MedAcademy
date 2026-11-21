# Traffic-interception detection — what MedAcademy can and cannot see

Android gives an ordinary, non-rooted app a small and well-defined set of
network-visibility signals. This document states exactly what the app uses, what
each signal proves, and — just as important — what it does **not** prove.

No AccessibilityService, no `UsageStats` / `PACKAGE_USAGE_STATS`, no hidden API,
no second `VpnService`, no `QUERY_ALL_PACKAGES`.

## 1. Signals in use

| Signal | What it detects | What it cannot detect | Android | Permissions | Play policy | Reliability | False-positive risk |
|---|---|---|---|---|---|---|---|
| Installed-tool catalog (`getPackageInfo` on 15 verified ids, declared in `<queries>`) | A **known** interception app is **installed** (ProxyPin, Reqable, HTTP Toolkit, Proxyman, Proxio, HttpCanary, PCAPdroid, Packet Capture, ApiCatcher, HTTP Sniffer, Moni Proxy, HTTPGlass, Packet Capture Pro, NetCapture) | Whether it is running; renamed/repackaged builds; unknown tools | 1+ (targeted visibility mandatory on 11+) | none | fine — targeted visibility, no `QUERY_ALL_PACKAGES` | high for the listed ids | low (an interception tool has no benign use in a study app; developer devices are the practical case) |
| Signer digest (SHA-256 of the signing cert) | Whether the installed package is signed by the **pinned** certificate | Whether the app is genuine when no verified digest is pinned | 24+ (28+ via `GET_SIGNING_CERTIFICATES`) | none | fine | mechanism ready, **database empty** | none (evidence only, never a verdict) |
| VPN transport (`ConnectivityManager` `TRANSPORT_VPN`, `VpnWatch`) | An **active VPN tunnel** (any VPN, including ProxyPin's VPN mode) | Which app owns it; whether TLS is decrypted | 21+ | none | fine | high | low |
| Kernel tunnel evidence (`/proc/net/dev`, `/proc/net/route` via libmedasec) | A tunnel-class interface carrying the default route, independent of framework APIs | The owning app | 21+ | none | fine | high | low |
| System HTTP proxy (`http.proxyHost`, `ProxySelector`, `LinkProperties.httpProxy`) | A proxy configured on the device/network (incl. a local proxy such as ProxyPin's non-VPN mode) | A transparent proxy that sets no proxy property | 24+ (`LinkProperties` 29+) | none | fine | medium | low |
| Obscured-touch flags (`FLAG_WINDOW_IS_OBSCURED`) | A touch delivered **through** another window (tapjacking) | A window that never overlaps a touch | 29+ | none | fine | event-driven | low |

Ordinary consumer VPNs are **not** in the catalog: a VPN capability alone is not
an interception tool. They are covered by the existing (unchanged) policy that an
active VPN blocks the app.

### 1.1 Application denylist — verified ids only

A tool is added only after its **published application id** is confirmed on
Google Play or the vendor's own distribution page. Batched ids are rejected by
the test suite (`VERIFIED_IDS` in `tests/interceptionDetection.test.cjs`), so an
unverified guess cannot ship.

| Application | Package id | Intercepts | Evidence |
|---|---|---|---|
| ProxyPin | `com.network.proxy` | HTTP/HTTPS MITM, local proxy **or** VPN mode | vendor distribution + prior device inspection |
| Reqable | `com.reqable.android` | HTTP/HTTPS MITM, VPN + proxy modes, desktop collaboration | Google Play listing |
| HTTP Toolkit | `tech.httptoolkit.android.v1` | HTTP/HTTPS MITM for development | Play listing + HTTP Toolkit docs |
| Proxyman | `com.proxyman.proxymanandroid` | HTTP/HTTPS MITM over a **local VPN**, CA generated on device | Play listing (`Proxyman - Capture HTTPS`), proxyman.com/android |
| Proxio | `com.shafayat.proxly` | on-device HTTP/HTTPS MITM proxy, installs its own CA | Play listing (`Proxio - HTTP Proxy & Debugger`) |
| HttpCanary | `com.guoshi.httpcanary` | HTTP/HTTPS MITM | legacy distribution (removed from Play in 2020, still installed in the wild) |
| HttpCanary Premium | `com.guoshi.httpcanary.premium` | same, paid build | legacy distribution |
| PCAPdroid | `com.emanuelef.remote_capture` | packet capture; HTTPS only with the companion `PCAPdroid-mitm` add-on | Play listing + project README |
| Packet Capture | `app.greyshirts.sslcapture` | SSL traffic capture/decrypt without root | Grey Shirts distribution page |
| ApiCatcher | `com.wujiuye.apicatcher` | HTTP/HTTPS capture and inspection | published application id (catalog expansion) |
| HTTP Sniffer | `com.anetcapture.mock` | HTTP/HTTPS traffic sniffing / inspection | published application id (catalog expansion) |
| Moni Proxy | `com.moni.proxy` | HTTP/HTTPS MITM proxy | published application id (catalog expansion) |
| HTTPGlass | `com.nutiverse.httpglass` | HTTP/HTTPS request interception and inspection | published application id (catalog expansion) |
| Packet Capture Pro | `com.realsignal.packetcapturepro` | packet capture / traffic inspection | published application id (catalog expansion) |
| NetCapture | `com.minhui.networkcapture` | packet capture of installed apps' network traffic | published application id (catalog expansion) |

Deliberately **not** listed: Charles Proxy, Burp Suite, Fiddler, mitmproxy, OWASP
ZAP, Wireshark and Proxyman **Desktop**. Those are desktop programs; Android
gives an app no way to enumerate software installed on a computer the phone is
merely connected to. Their *effect* is covered by the CA-trust and pinning
posture below.

Proxyman Android ships **both** a Play app and a desktop app; only the Android
package id is in the catalog.

### 1.2 Certificate trust hardening (independent of package detection)

Package detection can be bypassed by renaming/repackaging a tool. Trust is the
defence that survives that, because it does not depend on knowing the tool.

`plugins/withNetworkSecurityConfig.js` generates
`res/xml/network_security_config.xml`:

| Posture | Value | Why |
|---|---|---|
| Base trust anchors | `<certificates src="system" />` only | a user-installed (interception) CA is never an anchor, for **any** host |
| Pinned origin (`api.medacademy.site`) | same system-only anchors **plus** `<pin-set>` | the API is bound to the Let's Encrypt hierarchy on top of trust |
| Cleartext | `cleartextTrafficPermitted="false"` (base + pinned domain), `android:usesCleartextTraffic="false"` | no plaintext downgrade path |
| `<debug-overrides>` | **never generated** | would let a debug build widen the anchors |
| `overridePins` | **never generated** | a pin check that can be switched off is not a pin |
| Debug build | `src/debug/res/xml/network_security_config.xml`: identical posture + loopback-only cleartext for Metro | the debug variant cannot become a trust bypass |
| Bundled CA material | none | no certificate files ship in `res/raw` or `assets` |

**Certificate denylist: intentionally EMPTY.** No fixed, verifiable SHA-256
fingerprint can be published for these tools, because each one generates its CA
dynamically — see §1.3. Shipping a fingerprint from memory would be a false
claim, and the primary defence is the trust posture above, which rejects every
user CA regardless of fingerprint.

### 1.3 CA generation behaviour of the investigated tools

| Tool | Own CA? | Lifetime | Fixed fingerprint? | Can be installed on Android? |
|---|---|---|---|---|
| ProxyPin | yes | per installation | no | yes (user CA) |
| Reqable | yes | per installation/device | no | yes |
| HTTP Toolkit | yes | per installation | no | yes |
| Proxyman (Android + desktop) | yes | root CA self-signed and **generated locally on the device** (Android app) / per install (desktop) | no | yes |
| Proxio | yes | per installation | no | yes |
| Burp Suite | yes | per installation (regenerated on reset) | no | yes |
| Charles Proxy | yes | generated on first run, per user | no | yes |
| Fiddler (Classic/Everywhere) | yes | generated on first run, per machine | no | yes |
| mitmproxy | yes | generated on first run per `~/.mitmproxy` | no | yes |
| OWASP ZAP | yes | generated per session/installation | no | yes |
| PCAPdroid-mitm | yes | generated per installation | no | yes |

Consequence, stated plainly: **there is no universal fingerprint to deny.** The
enforceable rule is "MedAcademy trusts no user-installed CA", which rejects all
of the above at trust evaluation, before any pin is consulted. A user who also
rooted the device and moved a CA into the system store defeats that — and root is
separately detected and blocked.

Scope of the trust posture per network stack:

| Stack | Path | Enforcement |
|---|---|---|
| API calls (RN `fetch`/XHR → OkHttp) | platform TLS | NSC base-config + `pin-set` on the API origin |
| WebView (YouTube/Plyr iframes) | Chromium network stack | honours the app's NSC: user CAs rejected; **not pinned** (third-party origins, rotation would break playback) |
| ExoPlayer / VdoCipher SDK (retired) | platform TLS | left untouched; routes answer `410 video_provider_retired` |
| iOS | `PinningURLProtocol.swift` | SPKI pin comparison, unchanged by this task |

A custom `TrustManager` that bypasses the platform stack would not be covered by
NSC; the project contains none, and `tests/certificatePinning.test.cjs` fails on
`overridePins`/`debug-overrides`/`src="user"` so one cannot be introduced
silently.

## 2. Detection boundary

**Reliable**
* A tool from the catalog is installed (targeted package visibility).
* A VPN tunnel is active (framework transport + kernel route).
* A system HTTP proxy is configured.

**Conditional**
* `<queries>` visibility only answers for Android 11+; on 10 and below
  `getPackageInfo` sees every installed package, so the same code works and
  returns more.
* A local proxy that sets no system proxy property and no VPN is visible only
  through its effect (e.g. pinning failures), not as a configuration.

**Heuristic**
* Signer mismatch against a pin (currently no pins are shipped).
* Obscured-touch evidence (proves a window covered a touch, not which app).

**Not possible through public APIs**
* ProxyPin **installed but not running** → detected (install is the signal).
* ProxyPin **running without VPN mode** → detected only if it sets a system
  proxy; a local listener alone is not visible.
* ProxyPin **with VPN mode** → detected as an active VPN.
* ProxyPin with a **pinned panel while its activity is paused** → not detected as
  a window (that detector was removed); it is detected only through the install
  signal and, if active, the VPN/proxy signals.
* **Reqable** inactive → detected by install; active → detected by VPN/proxy.
* **Unknown / renamed / repackaged** tool → not detectable.
* **External proxy** on Wi-Fi or another network component → detectable when it
  is published through `LinkProperties`/proxy properties, otherwise not.
* **Off-device interception** (router, gateway, upstream TLS inspection) → not
  detectable by any client-side API.

## 3. Policy

| Condition | Response |
|---|---|
| A catalog tool is installed | **Block** (connection bucket, `block_login`) with copy naming the tool |
| A catalog tool is running / active | Same block; the VPN/proxy signals fire independently |
| Unknown active VPN | Existing VPN block (unchanged) |
| System proxy configured | Existing proxy block (unchanged) |
| Multiple signals | One gate, every active reason listed |
| Inconclusive (scan threw / module absent) | **No block** — reported as an unavailable check, never as clean |

An installed tool is a real finding: it can attach a local proxy or a tunnel with
no further install step. The app therefore does not try to distinguish "installed
but idle"; it reports what it can prove.

## 4. Verification status

| Capability | Status |
|---|---|
| Installed-tool scan + targeted visibility | implemented; automated tests pass; **physical verification not possible** (no interception tool installed on the test device) |
| Expansion ids (ApiCatcher, HTTP Sniffer, Moni Proxy, HTTPGlass, Packet Capture Pro, NetCapture) | implemented (catalog + `<queries>`); source-level contracts only — none installed on the available device, so detection is **not** physically verified |
| Proxyman / Proxio / Packet Capture ids | implemented (catalog + `<queries>`); not physically verified — neither app installed |
| User-CA rejection (NSC system-only anchors) | implemented in the config plugin; generated config asserted by tests; release APK not re-verified on device in this task (no build permitted) |
| Certificate denylist | investigated, deliberately **not implemented** — every tool generates a dynamic CA |
| Signer-digest mechanism | implemented; no pinned database, so it produces no verdict today |
| VPN / kernel / system-proxy signals | implemented and previously verified on device |
| Renamed/unknown tools, off-device interception | not technically possible through public APIs |
