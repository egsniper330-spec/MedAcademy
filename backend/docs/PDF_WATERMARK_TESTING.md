# PDF watermark tests — reproducible local workflow

This is the **single entry point** for running the real MedAcademy PDF
watermarking implementation (`backend/src/Services/PdfWatermarkService.php`)
locally with real PDFs and a real renderer, from a clean checkout. It replaces
the ad-hoc `.freebuff/pdfreal/` environment documented in
`.freebuff/pdfreal/REPORT.md` (that report remains the historical baseline;
this workflow reproduces it with pinned, verified dependencies).

Nothing here touches production: no production database, PDF, credential,
upload, migration, deployment or mobile build is involved. All runtimes,
Composer dependencies, generated PDFs, test databases and reports live in one
git-ignored directory: `.freebuff/pdf-watermark-tests/`.

---

## 1. Quick start (Windows — primary workflow)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File backend\tests\pdf-watermark\run.ps1
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
3. **Ghostscript — licensing gate.** If no renderer is found the workflow
   prints the AGPL/commercial disclosure (see §5) and **stops with exit 2**
   unless you opt in:

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
| `-AcceptGhostscriptLicense` | licensing opt-in; enables the verified Ghostscript **download** only |
| `-Clean` | delete `.freebuff/pdf-watermark-tests/` first (forces a full fresh bootstrap) |

---

## 2. What runs

| Suite | Script | Checks (baseline) | Covers |
|---|---|---|---|
| `real_pipeline` | `backend/tests/pdf-watermark/run_real_test.php` | 21 | Real Ghostscript rasterization of a multi-page, mixed-orientation PDF; page count/geometry/orientation preserved per page; image-only output (no `/Type /Font` objects, image XObjects present); two students get distinct bytes; `pdftotext` finds the marker in the SOURCE and not in the output (skipped if absent); source bytes unchanged; no temp scratch left; every page renders non-blank; pixel proof the watermark sits *behind* the content |
| `repo_verify` | `backend/scripts/verify-watermark.php` | 11 | The repository's own integration test, incl. the cross-platform `pdftotext` detection (env `PDFTOTEXT` → PATH, `proc_open` argv, no POSIX `command -v`) and the corrected font-object assertion (`/Type /Font` instead of the false-failing `/Font` dictionary key) |
| `error_handling` | `backend/tests/pdf-watermark/error_tests.php` | 8 | Fail-closed: non-PDF bytes, empty file, truncated PDF, encrypted PDF, missing Ghostscript, missing font, page limit, oversized page — each must throw, produce **no** output file and leave **no** temp dir/`.part` |
| `authorization` | `backend/tests/pdf-watermark/auth_tests.php` | 32 | `StorageService::canAccess` matrix, `shouldWatermark` role rules, token round-trip, forged identity → 403, expired → 410, malformed → 403, and **revocation after link issuance** (issued link keeps verifying cryptographically but is refused at stream time when the material is hidden or the enrollment suspended) |
| `gallery` | `backend/tests/pdf-watermark/make_gallery.php` | artifact | Builds `out/gallery.html` for manual visual inspection (non-required suite) |

**Expected result: 72/72 required checks pass (73 with the gallery artifact),
exit 0** — matching the historical baseline (20/20 real-pipeline, 8/8 error,
32/32 authorization in `.freebuff/pdfreal/REPORT.md`; the real-pipeline JSON
has always contained 21 individual assertions).

All suites drive the **actual PHP implementation and the actual renderer**.
A Python/PDFium harness may exist elsewhere as supplemental design evidence —
it is not part of this workflow and does not replace these tests.

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

The vector implementation (FPDI/FPDF passthrough) is untouched by this
workflow; no Poppler or other renderer was added.

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
  detects an existing `gs` or stops with instructions.
- **Passing these tests does not resolve licensing obligations**, does not
  constitute legal clearance, and does not prove compatibility with cPanel
  shared hosting. Those remain open decisions (see the licensing doc §8).

---

## 6. Linux / macOS

```bash
bash backend/tests/pdf-watermark/run.sh              # full run
bash backend/tests/pdf-watermark/run.sh --help       # options
```

Same suites, same workspace, same `summary.json` / `REPORT.md`, same exit
codes. Differences: PHP must already be installed (the script never installs
system packages — it prints package-manager commands), Ghostscript is
detected only (never downloaded), font detection probes DejaVu /
Liberation / FreeSans / Arial Bold paths, and `--accept-ghostscript-license`
acknowledges the disclosure but still only unlocks the instructions.

> Honest scope note: the Linux/macOS runner is written to mirror `run.ps1` and
> has been syntax-checked and logic-tested, but the documented, verified run
> environment for this baseline is **Windows 11** (the platform where the
> 20/20 · 8/8 · 32/32 baseline was produced).

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
- **Excluded from the required set:** `.freebuff/pdfreal/delivery_tests.php`
  (written after the baseline report) currently has 2 open failures around
  `MaterialDeliveryController::streamPdf` path resolution; it is documented
  here as known-failing work-in-progress and is *not* part of this workflow.
  Investigating it is a separate task.
