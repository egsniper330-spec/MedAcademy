# Second-pass audit — Android root, Magisk/Zygisk, LSPosed & runtime checks

Status: implemented in this change set (Android-only). Follow-up to
[ROOT_AND_INTEGRITY_HARDENING.md](ROOT_AND_INTEGRITY_HARDENING.md); the first
pass's claims were re-verified against the current source before any change.

Verification honesty up front: **no Android build, no emulator, no rooted
device, no LSPosed/Frida device run happened in this environment.** Everything
marked "verified" below means *verified by executed tests over the files on
disk*, not by a device. The device matrix in §10 is unexecuted.

---

## 1. Existing detection inventory (verified against source)

Every check that existed at the start of this pass, where it lives, what it
observes, its limits, and whether any test exercises it.

| # | Check | Location | Evidence observed | Real limits | Tested |
|---|---|---|---|---|---|
| 1 | Root-framework artifact probe (stat-by-errno) | `plugins/withSecurityModule.js` → `probeRootArtifacts()` | PRESENT vs EACCES vs ENOENT on `/data/adb/*`, su paths, `ksud`, `apd`, `lspd` | hooked `stat()` lies; data outside `/data/adb` invisible | yes — `tests/rootArtifactDenyList.test.cjs` (static + rule mirror) |
| 2 | Mount view | `inspectMountView()` | overlay/bind/debug_ramdisk shapes from `/proc/self/mountinfo` | app's own namespace only; DenyList scrubs it clean; 512-line bound; 2 s memo | yes — mirror test in `tests/rootAndIntegrityHardening.test.cjs` |
| 3 | PATH `su` | `suOnPath()` | stat of `$PATH/su` | PATH is zygote-inherited; renamed `su` invisible | static (wiring + errno semantics) |
| 4 | Classic `su` path list | `detectRoot()` step 1 | `File.exists()` | **`exists()` returns false on EACCES** (known lossy); DenyList unmounts most of these | static |
| 5 | Build props (`ro.debuggable`+`ro.secure`), `test-keys`, `/system` write test | `detectRoot()` steps 2–4 | system properties, `Build.TAGS`, write attempt | props can be reset (`resetprop`); **`test-keys` is a build-signing fact, not root** (RootBeer/AOSP documented) — kept as one low-confidence signal, now visible as `test_keys` in provenance | static |
| 6 | Root/Magisk/Xposed **package lists** | `detectRoot/detectMagisk/detectXposed` | `getPackageInfo` | **DEAD on Android 11+** — no `<queries>` entries (gap G1, fixed) | fixed + new sync test |
| 7 | Frida port probes (27042–27045) | `detectFrida()` | localhost TCP connect | non-default ports missed | static |
| 8 | Frida maps scan | `checkProcMapsForFrida()` | `/proc/self/maps` needles | **bare `gadget` needle too broad**; same file read 3×/batch (gap G7) | fixed + tested |
| 9 | Frida process cmdline scan | `scanProcessesForFrida()` | foreign `/proc/*/cmdline` | **dead on Android 10+ (`hidepid=2`, AOSP)** — silently read "clean" (gap G4) | fixed + tested |
| 10 | Frida temp files | `detectFrida()` step 6 | `File.exists()` | renamed files missed | static |
| 11 | Xposed class/stack/files | `detectXposed()` | `Class.forName`, stack frames, `/system` files | classloader visibility varies with LSPosed version; stack rarely contains Xposed frames; on-disk artifacts are legacy | static |
| 12 | Zygisk check | `checkZygisk()` | (pass 1) mount view + `/proc/modules` magisk needle | mount view duplicates detectMagisk step 0b; `/proc/modules` needle near-worthless | static |
| 13 | Magisk paths/packages, `/proc/self/mounts` scan, maps scan | `detectMagisk()` steps 1–5 | filesystem, packages, mount table, maps | mounts file = same kernel data as mountinfo (not independent); maps scan duplicate reader | static |
| 14 | C++ core `libmedasec` (`nativeRaspAggregate`, `nativeInspect`) | `MEDASEC_CPP` in the plugin | hook-lib path tails (XOR table), frida-class thread names, thread-count mismatch, RWX regions | **never reached JS or policy — `getNativeCoreSnapshot` had zero call sites** (gap G2) | fixed + decode test |
| 15 | Signed device evidence | `src/lib/deviceKey.ts` + `SecurityEvidenceService.php` | Keystore-signed flag map, challenge/counter/hash bound | client-serviced values are self-asserted; server caps payload at 8192 B | static + PHP AST |
| 16 | Play Integrity (server) | `IntegrityService.php` | Google verdicts bound to (user, action, hash) | not a root detector; log_only tiers | static (pass 1) |
| 17 | Evidence surface `getRootArtifactEvidence()` | Kotlin + `nativeSecurity.ts` | present/denied/mount/su/bootloader lists | **exposed but had no consumer anywhere in app code** (gap G7) | fixed + tested |
| 18 | Weighted findings/gates | `security.ts`, `securityStateModel.ts`, `SecurityContext.tsx` | threat weights → policy | root 35 + magisk 25 can be **one observation** (shared source) | yes — state-model suites |

`tests/` coverage of checks 1–13 was purely static (regex over the Kotlin
template) before this pass; that is unchanged, and §10 states what it does not
prove.

## 2. Research findings (sources read in this pass)

- **Procfs on Android 10+**: AOSP mounts procfs with `hidepid=2,gid=AID_READPROC`
  ([AOSP first_stage_init](https://android.googlesource.com/platform/system/core/+/refs/heads/android10-dev/init/first_stage_init.cpp),
  [AOSP change](https://android.googlesource.com/platform/system/core/+/c39ba5ae32afb6329d42e61d2941d87ff66d92e3));
  foreign `/proc/<pid>` dirs are **absent**, and `maps` is ptrace-gated
  ([proc_pid_maps(5)](https://man7.org/linux/man-pages/man5/proc_pid_maps.5.html)).
  → a scan of other processes' cmdlines cannot see `frida-server` on stock
  Android 10–15. **Documented fact.**
- **`/proc/self/mountinfo`** is this process's namespace view only
  ([mountinfo(5)](https://man7.org/linux/man-pages/man5/proc_pid_mountinfo.5.html),
  [mount_namespaces(7)](https://man7.org/linux/man-pages/man7/mount_namespaces.7.html));
  Magisk DenyList/Shamiko-style configurations remove mounts from the target's
  namespace ([Magisk changelog](https://github.com/topjohnwu/Magisk/blob/master/docs/changes.md),
  [Shamiko README](https://github.com/rushizgithub/shamiko)). A clean view ≠ clean
  device. **Documented fact + project statement.**
- **`/proc/modules`/Zygisk**: Zygisk is userspace zygote injection, not a kernel
  module ([Magisk guide](https://topjohnwu.github.io/Magisk/guides.html)).
  The legacy read could never fire. **Documented fact** (pass 1 had already
  flagged this).
- **LSPosed artifacts**: LSPosed is a Riru/Zygisk module on LSPlant; Riru-era
  files include `liblspd.so`, `libriru_lspd.so`
  ([LSPosed](https://github.com/LSPosed/LSPosed),
  [discussion #1820](https://github.com/LSPosed/LSPosed/discussions/1820)).
  **There is no single stable `libxposed_art.so` in-process signature**, and
  maps-hiding (Shamiko-class) defeats pathname matching entirely. LSPatch leaves
  Java-level loader classes (`org.lsposed.lspatch.loader.LSPApplication`,
  confirmed in LSPatch issue traces). **Documented fact for class/file names;
  maps appearance is version/configuration dependent (community claim).**
- **ART/JIT mappings**: memfd `jit-cache`, `(deleted)` suffixes and anonymous
  executable regions are *normal* ART behavior
  ([AOSP jit_memory_region.cc](https://android.googlesource.com/platform/art/+/master/runtime/jit/jit_memory_region.cc)) — they must not be verdicts. Our C++ RWX-region signal is therefore evidence-only; unchanged.
- **Package visibility is a known killer of package-based root checks** —
  RootBeer issue #167 documents exactly this failure
  ([scottyab/rootbeer#167](https://github.com/scottyab/rootbeer/issues/167)).
- **RootBeer / freeRASP limits**: RootBeer documents systemless-root, renamed-`su`
  and prop-cloaking defeats itself ([README](https://github.com/scottyab/rootbeer));
  freeRASP is freemium with documented bypass-resilience caveats
  ([license](https://docs.talsec.app/freerasp/terms-of-service/license)).
- **`test-keys` is not a root verdict**: it is a build-signing indicator
  (AOSP release-signing docs; RootBeer's own description). No credible
  prevalence measurement exists. Kept as a *low-confidence, provenance-visible*
  signal only.
- No credible published false-positive rate exists for rwx-map or thread-name
  scanning in normal apps — every such claim in this report is therefore marked
  as hypothesis, not measurement.

## 3. Coverage gaps found (all verified in source, not assumed)

| ID | Gap | Class | Disposition |
|---|---|---|---|
| G1 | Root/Magisk/Xposed **package checks dead on Android 11+** (no `<queries>` entries; `getPackageInfo` throws NameNotFound → always "not installed") | broken | **Fixed** |
| G2 | **C++ core unreachable**: `getNativeCoreSnapshot` had zero JS callers; `coreHookLibs/coreFridaThreads/...` TS fields never populated — the entire hook-lib/thread-name analysis fed nothing | dead code | **Fixed** |
| G3 | **Per-check fail-open**: every batch check was `runCatching{...}.getOrDefault(false/true)` — a thrown check read as "clean"/"valid" | evidence quality | **Fixed** (`detectionsUnavailable`) |
| G4 | **Process scan structurally blind** on Android 10+ (`hidepid=2`) yet reported a clean negative | broken/incomplete | **Fixed** (availability reporting) |
| G5 | **No in-process LSPosed/Riru/Zygisk maps check** in Kotlin; C++ table lacked `lspd/riru/lsplant/zygisk/lspatch/edxp/yahfa` | missing coverage | **Fixed** |
| G6 | **Non-independent double counting**: root(35)+magisk(25) can both derive from one artifact probe/mountinfo read; `checkZygisk` re-called `inspectMountView`, `checkMagiskMounts` re-read the same kernel mount table | evidence quality | **Partially fixed** — provenance arrays make the shared source explicit; weights deliberately unchanged (§8) |
| G7 | Duplicate `/proc/self/maps` readers (3×/batch), bare `gadget` needle, `getRootArtifactEvidence()` with no consumer | waste/FP/surface | **Fixed** |
| G8 | Modern manager package IDs missing (`io.github.topjohnwu.magisk`, KernelSU `me.weishu.kernelsu`, APatch `me.bmax.apatch`) | stale data | **Fixed** (Kotlin + queries; **verify IDs on device**) |

## 4. LSPosed analysis

**Existing coverage (pre-pass):** `Class.forName(XposedBridge/XposedHelpers/LSPApplication)`
(class-loader visibility varies), stack-frame string check (rarely fires),
installed-manager packages (**dead on Android 11+**), legacy `/system` files
(modern LSPosed lives under `/data/adb`, not `/system`), and the C++ `libxposed`
needle (**unwired**). Net effect before this pass: **LSPosed detection on a
modern device essentially rested on the manager package resolving (it did not)
and on files that modern installs do not create.**

**Added:** in-process native-needle check driving `xposedDetected` from BOTH
code paths — C++ decoded table (`lspd`, `riru`, `lsplant`, `lspatch`, `edxp`,
`yahfa`, `libxposed`, `substrate`) and a Kotlin `/proc/self/maps` snapshot with
the same verdict needle set. Every Kotlin verdict needle is asserted to be
covered by a C++ row (`tests/rootDetectionSecondPass.test.cjs` §5), so the core
path can actually fire for each of them.

**Remaining gaps (documented in code):** a maps-hiding configuration removes
these paths → absence proves nothing; a `Class.forName` can be hooked; thread
names/`gmain`/`gdbus` could theoretically come from a legit GLib-linked library
(none in this stack — hypothesis, not measured). We did **not** add
`QUERY_ALL_PACKAGES`, broad package enumeration, or ART-internals method-entry
comparisons (§8).

## 5. Magisk/Zygisk analysis

**Detected directly (when not hidden):** `/data/adb` errno signature (DenyList
resists because `/data` is not a mount it can scrub — still one hooked-syscall
away from defeat), root-shape mounts in our namespace, `su` on PATH, zygisk/magisk
path tails in our own maps, Magisk package when visible (now including the
modern ID).

**Only inferred:** "Magisk present but hidden" (DenyList active) — inferred
nothing; a fully hidden root currently reads clean except the `/data/adb` errno
probe. **Still bypassable:** hooked `stat/openat`, a kernel-level adversary,
maps hiding, namespace scrubbing, `resetprop` on verified-boot props, and a
patched APK (which the server-side Play Integrity + signed-evidence layers are
the real defence against).

## 6. Evidence-confidence changes

- **Unknown ≠ clean**: `getSecurityFlags()` now emits `detectionsUnavailable`
  (`developerOptions`, `adbEnabled`, `debugger`, `testOnlyBuild`,
  `screenRecording`, `frida`, `xposed`, `magisk`, `overlay`, `signatureCheck`,
  `tamper`, `vpn`, `root`, `emulator`, plus sub-checks `fridaProcessScan`,
  `procMapsScan`, `nativeCore`). Default **values are byte-for-byte unchanged**
  (no new blocking path); only availability is added.
- **Provenance**: `rootEvidenceSignals`, `magiskEvidenceSignals`,
  `fridaEvidenceSignals`, `xposedEvidenceSignals` — recorded in `finally` on
  every exit path, so "root AND magisk from one artifact probe" is visible
  instead of two look-like confirmations. Explicitly documented at the emission
  site that shared sources are one observation.
- **JS surfacing**: `SecurityEvidence.unavailableChecks` + a bounded,
  once-per-session `detection_unavailable` telemetry event (weight 0,
  `log_only`) — same philosophy as `vpn_detection_degraded`.
- **Signed evidence**: `checks_unavailable` and `root_evidence`
  (present/denied/mounts/su/bootloader) ride the signed payload. Server-side
  they are **ignored by design** (`deriveAssurance` reads only its named
  blocking fields; the v2 validator tolerates unknown fields — verified in
  `SecurityEvidenceService`), so **no backend deploy is required**. A client-side
  budget (7000 B < the server's 8192-B hard cap) drops these optional fields
  first, so they can never cause `evidence_too_large` rejection.
- **Weights/policies untouched**: no threat type, weight, event type, or server
  tier changed in this pass.

## 7. Implemented changes (files)

| File | Layer | Change |
|---|---|---|
| `plugins/withSecurityModule.js` | Android/native template (Kotlin + C++ + manifest) | §7.1 below |
| `src/lib/nativeSecurity.ts` | frontend | Types for `detectionsUnavailable`, four `*EvidenceSignals`, `coreHookLibNames` (deliberately **not** added to `SAFE_FLAGS` — a failed batch must not read as "all checks ran") |
| `src/lib/security.ts` | frontend | `SecurityEvidence.unavailableChecks`; bounded once-per-session partial-degradation telemetry (weight 0, log_only) |
| `src/lib/deviceKey.ts` | frontend | `checks_unavailable` + `root_evidence` in the signed bundle (first real consumer of `getRootArtifactEvidence()`), with the 7000-B optional-field budget |
| `tests/rootDetectionSecondPass.test.cjs` | tests | **New** — 77 checks: XOR decode, queries sync, fail-open conversion, core wiring, needle parity, provenance, hidepid, brace balance, JS surfacing |
| `docs/ROOT_DETECTION_SECOND_PASS_AUDIT.md` | docs | This report |

### 7.1 `plugins/withSecurityModule.js` (the prebuild source of truth — `android/` regenerated, never hand-edited)

1. **`SECURITY_CHECK_PACKAGES`** — scoped `<queries>` entries for every package
   the Kotlin detectors probe (merged with `TARGET_APP_CATALOG`, deduplicated).
   Fixes G1 without `QUERY_ALL_PACKAGES`.
2. **Shared evidence helpers** — `procMapsLines()`/`mapsHas()` (one 2 s
   `/proc/self/maps` snapshot; `null` = unreadable = unknown), memoised
   `coreRaspEvidence()` over the C++ bridge, tight verdict needle sets
   (`FRIDA_LIB_NEEDLES`, `XPOSED_LIB_NEEDLES`, `ZYGISK_LIB_NEEDLE`), provenance
   fields, `putStringList`.
3. **C++ table**: 7 new XOR rows (`lspd`, `riru`, `lsplant`, `zygisk`,
   `lspatch`, `edxp`, `yahfa`) — decode verified against comments by test.
4. **`detectFrida`**: provenance; core cross-read (hook libs + frida thread
   names) *before* the Kotlin fallback; bare-`gadget` needle tightened to
   `frida|libgadget|gum-js-loop`; process scan now sets
   `_fridaProcessScanAvailable` (hidepid parsed from mountinfo, or many-dirs-but-
   zero-readable heuristic) — surfaced as `fridaProcessScan` in
   `detectionsUnavailable`; duplicate `checkLoadedLibraries()` removed.
5. **`detectXposed`**: provenance; **new in-process maps step** (core first,
   Kotlin snapshot fallback) with LSPosed-era needles; package step documented
   as queries-dependent; files step labelled legacy.
6. **`detectMagisk`**: provenance; step 3 `checkZygisk()` rewritten — maps
   needle + core cross-read + memoised mount view (dead `/proc/modules` read
   removed entirely); `checkMagiskDenyList()` now uses the shared snapshot;
   `io.github.topjohnwu.magisk` added.
7. **`detectRoot`**: provenance; modern manager IDs added
   (`io.github.topjohnwu.magisk`, `me.weishu.kernelsu`, `me.bmax.apatch`).
8. **`getSecurityFlags()`**: `unavailable` accumulator — every
   `getOrDefault(false/true)` became `.getOrElse { unavailable.add(name); default }`
   (values identical); emits `detectionsUnavailable`, four provenance arrays,
   and the core fields (`coreAvailable/coreHookLibs/coreHookLibNames/
   coreFridaThreads/coreThreadMismatch`).
9. **`probeRootArtifacts()`**: 2 s memo — one batch probed the set up to 3×;
   now 19 stats once, consistent for all three consumers.
10. **`inspectMountView()`**: records `hidepid` on the proc mount
    (`_procHidepid`: true/false/null=unknown).

## 8. Rejected / deferred this pass

| Candidate | Decision | Reason |
|---|---|---|
| Score-level dedup of root+magisk events | **Deferred** | The provenance arrays expose the shared source, but changing `computeRiskScore`/threat emission would alter live policy behaviour (magisk-derived events are server-visible). Needs a deliberate policy decision + telemetry review, not an audit side effect |
| Down-grade `test-keys` root verdict | **Rejected (kept as-is)** | It is a weak signal (research §2), but *removing* it would weaken an existing check; instead it is provenance-visible (`test_keys`) so operators can see when a root verdict rests on it alone |
| Removing `checkMagiskMounts` (same kernel table as mountinfo) | **Deferred** | It is a second reader, not an independent source; documented as such. Removal buys ~nothing (one cached file read) and churns tested code |
| ART method-entry / inline-hook byte comparison | **Rejected** | Not a stable ABI across Android versions (AOSP JIT docs); high FP and maintenance cost for a client-side check a root adversary can defeat anyway |
| `ptrace` anti-debug, `QUERY_ALL_PACKAGES`, broad package enumeration | **Rejected** | Policy risk (Play), legitimate-tool breakage; Play policy review not justified by the marginal coverage |
| New RASP SDK (RootBeer/freeRASP) | **Rejected** | Both re-implement checks we already have; freeRASP adds freemium caps, telemetry to a third party, binary components (reconfirmed in this pass's research) |
| KernelSU/APatch manager **package IDs** | **Implemented but flagged** | IDs taken from project documentation/releases; must be confirmed on a real device (they are cheap and visibility-scoped) |
| Consuming C++ signals as *independent* confirmation | **Rejected by design** | Kotlin and C++ read the same `/proc/self/maps`; documented as two code paths over one source (patch-resistance, not independence) |

## 9. Tests performed (exact commands, results)

| Command | Result |
|---|---|
| `node -e "require('./plugins/withSecurityModule.js')"` | plugin loads (template literal intact) |
| `node scripts/validate-kotlin-template.js` | PASSED (1 pre-existing warning: 4 empty catches) |
| `node scripts/validate-native-build.js` | PASSED (1 pre-existing warning: App Attest entitlement) |
| `node tests/rootDetectionSecondPass.test.cjs` | **77 checks, 0 failed** (new suite) |
| `node tests/rootArtifactDenyList.test.cjs` | 44 checks, 0 failed |
| `node tests/rootAndIntegrityHardening.test.cjs` | 42 checks, 0 failed |
| `node scripts/run-all-tests.cjs security` | 9 suites, 0 failed (42.8 s) |
| `npm run test:state` | 79 passed, 0 failed |
| `npx tsc --noEmit -p tsconfig.json` | clean |
| `npx eslint src/lib/security.ts src/lib/nativeSecurity.ts src/lib/deviceKey.ts tests/rootDetectionSecondPass.test.cjs` | 0 errors (pre-existing warnings only) |
| Brace-balance + `require()` structural check of every edited Kotlin function | balanced |
| `node scripts/validate-all.js` | all 4 stages PASSED (Kotlin template, Swift, native build, security param-authority) |
| Full suite `node scripts/run-all-tests.cjs` | **107 suites, 107 passed, 0 failed** (231 s, exit 0) — run after the second-pass Kotlin/TS changes |

**Not run:** Kotlin compilation (no Android SDK/NDK in this environment), any
APK build, any device/emulator scenario, Play Integrity round-trip, PHP runtime.
Static assertions are not proof that a check *fires* on a rooted device.

## 10. Device matrix (unexecuted — reproducible instructions)

| Case | Expected observation |
|---|---|
| Stock Android 13–15, release build | all flags false; `detectionsUnavailable` **contains `fridaProcessScan`** (hidepid) and nothing else; `rootEvidenceSignals: []` |
| Magisk, **no** DenyList | `rootDetected=true`, `rootEvidenceSignals=["artifact_probe"]` or `["mount_view"]`; `magiskEvidenceSignals` names the same source (shared-source check) |
| Magisk + DenyList + Shamiko | possibly `rootDetected=false`; `root_evidence.denied` non-empty in signed payload (EACCES signature) |
| KernelSU / APatch | `ksud`/`apd` probes fire; manager package resolves only if visible + queries-correct (validates G8 IDs) |
| LSPosed (Riru or Zygisk flavor) | `xposedDetected=true` with `xposedEvidenceSignals` containing `core_hook_libs` or `xposed_maps` (validates G5); if maps-hiding active, expect **no** signal — record it as a documented miss |
| Frida server on default port | `fridaDefaultPort` signal; renamed port → expect miss unless thread/maps fire |
| Re-signed APK | unchanged: `signatureValid=false` + server `certificate_mismatch` |
| Induce a Kotlin exception in one check (debug build) | that name appears in `detectionsUnavailable`, value keeps its default, telemetry event fires once |

## 11. Deployment

- **Backend: nothing to upload.** New signed-payload fields are ignored by the
  current server (verified: `deriveAssurance` reads named fields only; v2
  validator checks listed fields only; `canonicalJson` is recursive; size cap
  protected client-side). No migration, no env var, no dependency.
- **Android: rebuild required** (EAS/prebuild) — the Kotlin, C++, and manifest
  `<queries>` changes all come from the Config Plugin. `android/` must be
  regenerated, never hand-patched.
- iOS: untouched (all changes are Android-branch code or Android-only fields).

## 12. Recommended next steps (prioritised by remaining risk)

1. **Run §10 on real hardware** — especially the LSPosed maps case and the
   modern manager-package IDs (G8); then the DenyList matrix.
2. Watch `detectionsUnavailable` telemetry for a week: `nativeCore` frequent
   would mean `libmedasec` is missing from builds (a build-config regression,
   not a device problem).
3. Decide the score-dedup policy for shared-source root+magisk (§8, deferred)
   using real provenance telemetry.
4. Consider surfacing `root_evidence`/`unavailableChecks` in the admin
   security-diagnostics UI (server-side display only; no API change needed).
5. Only after 1–3: consider a second source *independent* of `/proc` (e.g.
   Play Integrity device verdicts already available server-side) as the
   corroboration layer — client-side checks on a controlled device all collapse
   to the same trust root.

---

## Appendix — technique → status table

| Technique | Status |
|---|---|
| `/data/adb` + su-path stat-by-errno probe | **existing, verified** (static tests) |
| mountinfo root-shape parser | **existing, verified** (rule mirror test) |
| PATH `su` stat probe | **existing, verified** (static) |
| Classic su path list / props / test-keys / system-writable | **existing, unverified on device** (documented weak signals) |
| Root/Magisk/Xposed **package checks** | **fixed** (were dead on Android 11+; now queries-backed; IDs extended) |
| Frida port probes / temp files | **existing, unverified** |
| Frida maps scan | **fixed** (tightened needles, shared snapshot) |
| Frida process/cmdline scan | **fixed** (hidepid-aware; reports unavailable instead of clean) |
| Duplicate maps reader (`checkLoadedLibraries`) | **fixed** (merged) |
| Zygisk check | **fixed** (dead `/proc/modules` + duplicate mount call → maps + core + mount cross-check) |
| C++ hook-lib table (Frida/Xposed + **new** LSPosed/Riru/Zygisk rows) | **fixed — was unreachable; now wired** into `detectFrida/detectXposed/checkZygisk` + batch |
| C++ frida thread names / thread mismatch | **fixed — wired** (core fields exported) |
| In-process LSPosed/Riru/LSPlant maps needles (Kotlin) | **newly implemented** |
| Per-check `detectionsUnavailable` | **newly implemented** |
| Provenance arrays (shared-source visibility) | **newly implemented** |
| `getRootArtifactEvidence` → signed evidence consumer | **newly implemented** (was exposed, never consumed) |
| Partial-degradation telemetry (weight 0) | **newly implemented** |
| Maps/artifact memoisation (1 reader, 1 probe per batch) | **newly implemented** (perf + consistency) |
| Score-level shared-source dedup | **deferred** (policy decision; provenance now available) |
| Play Integrity server enforcement | **existing, unchanged** (already verified in pass 1) |
| ART inline-hook / method-entry integrity | **rejected** (unstable ABI, FP risk) |
| `ptrace` anti-debug, `QUERY_ALL_PACKAGES`, RASP SDKs | **rejected** |
| KernelSU/APatch in-process artifacts beyond `/data/adb` | **not applicable / none documented** to observe from an unprivileged app |
