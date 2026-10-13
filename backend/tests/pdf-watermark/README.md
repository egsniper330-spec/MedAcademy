# PDF watermark tests

Reproducible local tests for the real PDF watermarking implementation.

**Start here → [`backend/docs/PDF_WATERMARK_TESTING.md`](../../docs/PDF_WATERMARK_TESTING.md)**

```powershell
# Windows (primary)
powershell -NoProfile -ExecutionPolicy Bypass -File backend\tests\pdf-watermark\run.ps1
```

```bash
# Linux/macOS
bash backend/tests/pdf-watermark/run.sh
```

Exit codes: `0` all required suites passed · `1` a suite failed ·
`2` prerequisite missing / Ghostscript licensing opt-in not given.

| File | Role |
|---|---|
| `run.ps1` / `run.sh` | single entry point: prereq checks, pinned+verified downloads, suites, `summary.json` + `REPORT.md` |
| `composer.json` / `composer.lock` | pinned FPDF 1.9.0 + FPDI 2.6.8 (installed into the git-ignored workspace, never `backend/vendor`) |
| `php.ini` | config for the pinned Windows PHP runtime (workspace only) |
| `prepend.php` | test-only FPDF/FPDI autoload bridge (mirrors a real deployment's `vendor/autoload.php`) |
| `make_fixture.php` | deterministic generation of all test PDFs (nothing binary is committed) |
| `run_real_test.php` | real raster pipeline: geometry, image-only output, distinct student copies, pixel proofs |
| `error_tests.php` | fail-closed error handling (malformed/encrypted/limits/missing deps) |
| `auth_tests.php` | authorization + token lifecycle incl. revocation (isolated SQLite, test data only) |
| `make_gallery.php` | local HTML gallery for manual inspection (never auto-opened, never uploaded) |
| `summarize.php` | machine-readable `summary.json` + human-readable `REPORT.md` |

Everything generated lands in `.freebuff/pdf-watermark-tests/` (git-ignored).
Ghostscript is AGPL/commercial licensed — see the guide §5 before any download.
