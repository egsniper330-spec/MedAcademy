# PDF watermark tests — reproducible local workflow

This is the **single entry point** for running the real MedAcademy PDF
watermarking implementation (`backend/src/Services/PdfWatermarkService.php`)
locally with real PDFs and the required raster renderer, from a clean checkout.
Student delivery is raster-only; Ghostscript, image composition, a TTF font and
explicit local acknowledgement of the Ghostscript licensing disclosure are
required to run the full suites. See §5 and `PDF_WATERMARK_LICENSING.md` before
proceeding. Local test acknowledgement is not production approval.
It replaces the ad-hoc `.freebuff/pdfreal/` environment documented in
`.freebuff/pdfreal/REPORT.md` (that report remains a historical baseline; this
workflow exercises the current raster-only delivery contract with pinned,
verified dependencies).

Nothing here touches production: no production database, PDF, credential,
upload, migration, deployment or mobile build is involved. All runtimes,
Composer dependencies, generated PDFs, test databases and reports live in one
git-ignored directory: `.freebuff/pdf-watermark-tests/`.

---

## 1. Quick start (Windows — primary workflow)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File backend\tests\pdf-watermark\run.ps1 -AcceptGhostscriptLicense
```

Exit codes: `0` all required suites passed · `1` a required suite failed ·
`2` prerequisite missing or Ghostscript licensing opt-in not given.

### First run, step by step

1. **PHP** — downloads the pinned PHP 8.3.35 NTS x64 zip (34 MB) from
   `windows.php.net` into the workspace, verifies it against the **official
   SPDX checksum sidecar** published next to the build *and* against a hash
   pinned in `run.ps1`, extracts it, copies the workspace `php.ini`.
   Nothing touches your system PHP. (Use `-UseSystemPhp` to opt out and use a
   PHP already on PATH instead; it must have gd+FreeType, pdo_sqlite, mbstring,
   `proc_open` and `memory_limit ≥ 512M`.)
2. **Composer** — downloads `composer.phar` 2.10.3 from `getcomposer.org`,
   verifies its pinned SHA-256 (an official GPG signature is also published at
   `composer.phar.asc` if you prefer manual verification), then runs
   `composer install --no-interaction` from the committed `composer.lock` into
   the workspace (`lib/vendor`). FPDF **1.9.0** + FPDI **2.6.8** — the exact
   versions of the baseline run. `COMPOSER_HOME` is redirected into the
   workspace, so no global Composer state is written.
3. **Ghostscript — licensing gate.** Raster delivery requires Ghostscript, and
   the test harness also requires an explicit local acknowledgement to exercise
   it. Read the AGPL/commercial disclosure (see §5); without the flag the
   workflow stops with exit 2 or the raster suites cannot pass. The flag is not
   production legal approval:

   ```powershell
   # opt in to the download (see §5 first!)
   powershell -NoProfile -ExecutionPolicy Bypass -File backend\tests\pdf-watermark\run.ps1 -AcceptGhostscriptLicense
   ```

   With the flag it downloads `gs10080w64.exe` from the official Artifex
   `ghostpdl-downloads` release and verifies it twice: against the publisher's
   `SHA512SUMS` **and** a hash pinned in `run.ps1`. It then **prints** the
   install command and stops — the script never elevates itself and never
   executes the installer. Run the printed command once in an *elevated*
   PowerShell (it installs silently into the ignored workspace, not into
   `Program Files`; PATH untouched), then re-run `run.ps1`:

   ```powershell
   Start-Process -FilePath '<workspace>\downloads\gs10080w64.exe' -ArgumentList '/S','/D=<workspace>\gs' -Wait
   ```

   If Ghostscript is already installed (PATH, `GHOSTSCRIPT_BIN`, or a previous
   workspace install), nothing is downloaded at all.
4. **Font + pdftotext** — picks a system TTF (Arial Bold → Segoe UI Bold → …)
   for `PDF_WATERMARK_FONT`, and looks for `pdftotext` (optional; without it
   the two text-extraction checks run as **SKIPPED**, counted as skipped in the
   summary rather than failed).
5. **Fixtures** — `make_fixture.php` generates every test PDF on the fly
   (no binaries are committed): a 4-page source with mixed sizes/orientations
   (A4 portrait, A4 landscape, US-Letter), dense text, 6 pt small print, a
   vector diagram, an embedded raster chart and the marker string
   `LECTURE-TEXT-MARKER-ALPHA`; plus `notapdf/empty/truncated/encrypted.pdf`
   failure fixtures (encrypted via Ghostscript pdfwrite, synthetic passwords).
6. **Suites** run, then `summarize.php` writes `out/summary.json` (machine
   readable) and `out/REPORT.md` (human readable) and sets the exit code.

### Options

| Flag | Effect |
|---|---|
| `-BootstrapOnly` | prepare workspace + fixtures, run no suites |
| `-SkipBootstrap` | skip downloads/installs (offline re-runs), go straight to suites |
| `-UseSystemPhp` | use PHP from PATH instead of the pinned runtime |
| `-AcceptGhostscriptLicense` | explicit local test acknowledgement; permits a verified Ghostscript download when needed and sets the test-only product acknowledgement for the run |
| `-Clean` | delete `.freebuff/pdf-watermark-tests/` first (forces a full fresh bootstrap) |

---

## 2. What runs

| Suite | Script | Checks | Covers |
|---|---|---|---|
| `real_pipeline` | `backend/tests/pdf-watermark/run_real_test.php` | 33 | Raster delivery through the real PHP service: page count/geometry/orientation, per-page identity, one centered mark, image-only output, source unchanged, and small/large render benchmarks. One vector-layer-only proof is skipped because raster output is one composited image |
| `repo_verify` | `backend/scripts/verify-watermark.php` | 14 | Repository integration verification through the shipped service |
| `error_handling` | `backend/tests/pdf-watermark/error_tests.php` | 8 | Fail-closed handling for malformed, encrypted, oversized/page-limit inputs and missing renderer prerequisites |
| `authorization` | `backend/tests/pdf-watermark/auth_tests.php` | 37 | Access matrix, token lifecycle, forged identity, expiry, malformed token and revocation after link issuance |
| `delivery` | `backend/tests/pdf-watermark/delivery_tests.php` | 129 | End-to-end personalization, cache keys, concurrency/locking, cleanup, status and no unwatermarked fallback. One vector-layer-only proof is skipped |
| `flatten_engine` | `backend/tests/pdf-watermark/flatten_engine_tests.php` | 12 | Legacy vector/flatten delivery modes are refused and default/`auto` resolve to raster |
| `gallery` | `backend/tests/pdf-watermark/make_gallery.php` | artifact | Builds `out/gallery.html` for manual visual inspection (non-required suite) |

**Current verified result (2026-10-29, Windows 11, PHP 8.3.35, Ghostscript
10.08.0): 232 passed, 0 failed, 2 skipped of 234 total checks; every required
suite exited 0.** The two skips are vector-layer proofs inapplicable to the
image-only contract, not checks blocked by a missing Ghostscript installation.
The harness required `-AcceptGhostscriptLicense` to set the test-only product
acknowledgement and exercise Ghostscript locally; this does not resolve
production licensing. Reproduce the recorded run with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File backend\tests\pdf-watermark\run.ps1 -SkipBootstrap -AcceptGhostscriptLicense
```

All required suites drive the **actual PHP implementation and the actual
generator**.

### Removal-resistance measurements (separate, Python)

`backend/tests/pdf-watermark/removal_attacks.py` attacks a **delivered** PDF and
reports, per attack, how much watermark ink disappears and how much lecture
content it costs. It is a developer tool (needs `pikepdf`, `pymupdf`, `numpy`,
`pillow`, none of which the backend uses) and is *not* run by `run.ps1`:

```bash
python backend/tests/pdf-watermark/removal_attacks.py \
    --pdf .freebuff/pdf-watermark-tests/out/student-a.pdf \
    --source .freebuff/pdf-watermark-tests/fixtures/source.pdf \
    --identity "Test Student Alpha • MED-0042" --id MED-0042 \
    --outdir .freebuff/pdf-watermark-tests/removal/run1
```

Results and their interpretation live in
[`PDF_WATERMARK_REMOVAL_RESISTANCE.md`](PDF_WATERMARK_REMOVAL_RESISTANCE.md).

### Visual inspection (manual)

After a run, open the gallery yourself — it is never opened automatically and
never uploaded anywhere:

```
start "" "<workspace>\out\gallery.html"        (Windows)
open "<workspace>/out/gallery.html"            (macOS)
xdg-open "<workspace>/out/gallery.html"        (Linux)
```

It embeds (base64) the source page vs Student A vs Student B, a 3× text zoom
and a 2× margin crop showing the grey watermark behind the glyphs. The raw
inputs are also there: `out/student-a.pdf`, `out/student-b.pdf`,
`out/src-p1..p4.png`, `out/out-p1..p4.png`.

---

## 3. Workspace layout (all git-ignored)

```
.freebuff/pdf-watermark-tests/
├── runtime/php/      pinned PHP 8.3.35 (+ workspace php.ini)
├── gs/               Ghostscript 10.08.0 (only after manual install step)
├── lib/              Composer json/lock copies + vendor (FPDF, FPDI)
├── composer-home/    isolated COMPOSER_HOME (never global)
├── downloads/        php zip + SPDX sidecar, composer.phar, gs installer + SHA512SUMS
├── fixtures/         generated test PDFs (source, encrypted, truncated, …)
└── out/              generated student PDFs, page renders, gallery.html,
                      per-suite *.json/*.log, summary.json, REPORT.md
                      tmp/  (verify-watermark scratch via PDF_WATERMARK_TEST_TMP)
```

Reset everything: `run.ps1 -Clean` (or `run.sh --clean`).

---

## 4. Exact tested versions

| Component | Version | Source | Verification |
|---|---|---|---|
| OS (primary) | Windows 11 x86_64, PowerShell 5.1 | local | — |
| PHP CLI | **8.3.35 NTS (VC++ 2019 x64)** | `https://windows.php.net/downloads/releases/php-8.3.35-nts-Win32-vs16-x64.zip` | official SPDX sidecar SHA-256 + hash pinned in `run.ps1` |
| Ghostscript | **10.08.0** (`gswin64c.exe`) | Artifex `ghostpdl-downloads` release `gs10080` | publisher `SHA512SUMS` (SHA-512) + hash pinned in `run.ps1`; opt-in download only |
| FPDF | **1.9.0** (`setasign/fpdf`) | Packagist | committed `composer.lock` |
| FPDI | **2.6.8** (`setasign/fpdi`) | Packagist | committed `composer.lock` |
| GD / FreeType | bundled **2.1.0-compatible**, FreeType **YES** (`imagettftext`) | PHP bundled `php_gd.dll` | runtime check in bootstrap |
| Composer | **2.10.3** | `https://getcomposer.org/download/2.10.3/composer.phar` | pinned SHA-256 in `run.ps1` (+ official `.asc`) |
| Font | Arial Bold (`C:\Windows\Fonts\arialbd.ttf`) | system | path probe |
| `pdftotext` (optional) | Xpdf **4.00** | already on PATH | detected at runtime; checks **skip** without it |
| `memory_limit` / `proc_open` | 512M / enabled | workspace `php.ini` | runtime check |

The delivery implementation exercised here is raster-only. FPDI/FPDF/TCPDF
remain available for PDF output and legacy-engine policy tests; student delivery
refuses vector and renderer-free flatten modes. No Poppler or other renderer was
added.

---

## 5. Ghostscript licensing (read before opting in)

- Ghostscript is **dual-licensed: AGPL v3 or a commercial license**, handled
  exclusively by Artifex. The AGPL carries a network-use clause (§13).
  See `backend/docs/PDF_WATERMARK_LICENSING.md` for the full analysis.
- The workflow **never downloads or installs Ghostscript without the explicit
  `-AcceptGhostscriptLicense` / `--accept-ghostscript-license` opt-in**, always
  prints the disclosure first, verifies checksums before any use, never
  elevates itself and never executes the installer — the install is a single
  documented command **you** run (and it writes only into the ignored
  workspace plus the installer's own uninstall registration).
- On Linux/macOS there is **no automated download path at all** (Artifex
  publishes no official binary archive we can pin and verify); the runner
  detects an existing `gs` or stops with instructions. Because raster is now
  mandatory, this prerequisite cannot be skipped for a passing full run.
- **Passing these tests does not resolve licensing obligations**, does not
  constitute legal clearance, and does not prove compatibility with cPanel
  shared hosting. Those remain open decisions (see the licensing doc §8).

---

## 6. Linux / macOS

```bash
bash backend/tests/pdf-watermark/run.sh --accept-ghostscript-license  # full run; requires gs + TTF + PHP raster prerequisites
bash backend/tests/pdf-watermark/run.sh --help       # options
```

Same suites, same workspace, same `summary.json` / `REPORT.md`, same exit
codes. Differences: PHP must already be installed (the script never installs
system packages — it prints package-manager commands), Ghostscript is
detected only (never downloaded), font detection probes DejaVu /
Liberation / FreeSans / Arial Bold paths, and `--accept-ghostscript-license`
sets the test-only acknowledgement after you review the disclosure. The flag
does not install Ghostscript or resolve production licensing.

> Honest scope note: the Linux/macOS runner is written to mirror `run.ps1` and
> has been syntax-checked and logic-tested, but the verified full raster run
> documented here was performed on **Windows 11**. Linux/macOS host compatibility
> and licensing remain unverified.

---

## 7. CI note

No CI workflow was committed, deliberately: a hosted runner would have to
install Ghostscript (AGPL) to run the raster suites, and **that licensing
opt-in is a maintainer decision, not one this repository may automate**. If
you add one, gate it explicitly, e.g. a `workflow_dispatch` input
`accept_ghostscript_license` that must be `true` before an `apt-get install
ghostscript` step, run `run.sh`, and upload `out/summary.json` + `out/REPORT.md`
as artifacts (never the PDFs/gallery, unless that is explicitly wanted).

---

## 8. Boundaries — what this does NOT prove

- No production database, storage, credentials, server, upload, migration,
  deployment or mobile build is used or changed by this workflow.
- The authorization tests inject an **in-memory SQLite** PDO into the
  `Database` singleton via reflection (test-only). The **MySQL**-backed
  `canAccess` on a real server is not exercised here.
- Linux `gs`, the cPanel PHP build's extensions/limits, and cPanel filesystem
  permissions are not covered by the Windows run (and vice versa).
- The delivery suite (`backend/tests/pdf-watermark/delivery_tests.php`, 129
  checks in the 2026-10-29 run; one proof is inapplicable/skipped) exercises
  the controller against an in-memory SQLite database and a temporary storage
  root, not against MySQL and cPanel storage. The path/cache logic is the same
  code, but file-system permission behaviour on the host is not reproduced.
- The removal-resistance numbers are measured on the fixture PDFs in this
  workspace; a different source document (scanned pages, full-page images,
  colour backgrounds) will produce different percentages for the image-domain
  attacks.

## 9. Re-verification log (2026-10-29)

Full run on Windows 11 with the pinned **PHP 8.3.35** CLI, `pdo_sqlite`, GD +
FreeType, Ghostscript 10.08.0, FPDF 1.9.0, FPDI 2.6.8, TCPDF 6.11.4 and Arial
Bold. The command below ran all required suites; its explicit acknowledgement
is test-only and is not production licence approval.

| Suite | Result |
|---|---|
| Real raster pipeline | **32 passed, 1 inapplicable skip** |
| Shipped service integration | **14/14 passed** |
| Fail-closed error handling | **8/8 passed** |
| Authorization and token lifecycle | **37/37 passed** |
| End-to-end delivery | **128 passed, 1 inapplicable skip** |
| Legacy vector/flatten policy | **12/12 passed** |
| Gallery artifact | **1/1 passed** |
| **Required suite total** | **232 passed, 0 failed, 2 skipped of 234 checks** |

Two harness defects were found and fixed while re-running this, neither a
product bug:

1. **`flatten_engine_tests.php` was not hermetic.** The inherited
   `PDF_WATERMARK_MODE` / `PDF_WATERMARK_OPACITY` in `$_ENV` (populated at
   process start) takes precedence over `putenv()`, so the suite could silently
   run in the wrong engine mode depending on the caller's environment. It now
   sets/restores both `$_ENV` and `putenv()` and calls `Config::init()`.
2. **`delivery_tests.php` had a stale stat cache.** The cleanup assertions
   stat()ed the orphan file in the parent process, then a *child* process
   deleted it; PHP's stat cache still answered "exists", so
   `cleanup: --apply removes the orphaned file` failed on a correct delete.
   The check now calls `clearstatcache(true, $orphan)` first.

Both were test-harness issues: the delivered bytes, the authorization decisions
and the cleanup behaviour were already correct. The exact command and full
machine-readable output are recorded in the companion
[`PDF_WATERMARK_VERIFICATION_REPORT.md`](PDF_WATERMARK_VERIFICATION_REPORT.md)
and the ignored `.freebuff/pdf-watermark-tests/out/` artifacts.
