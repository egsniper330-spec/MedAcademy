#!/usr/bin/env bash
#
# run.sh — Linux/macOS entry point for the MedAcademy REAL PDF-watermark test
# workflow (equivalent to run.ps1 on Windows).
#
# Prepares an isolated, git-ignored workspace at .freebuff/pdf-watermark-tests/,
# then runs the real PHP watermark pipeline tests against the source-controlled
# implementation. Nothing is installed globally, no system setting is changed,
# no production database, PDF, credential or server is touched.
#
#   bash backend/tests/pdf-watermark/run.sh [options]
#
# Options:
#   --bootstrap-only              prepare workspace + fixtures, run no suites
#   --skip-bootstrap              go straight to the suites (offline re-runs)
#   --accept-ghostscript-license  acknowledge the Ghostscript AGPL/commercial
#                                 licensing disclosure (still never auto-
#                                 downloads on POSIX: Artifex publishes no
#                                 official Linux/macOS binary we could verify,
#                                 so this flag only unlocks the instructions).
#                                 Only needed for PDF_WATERMARK_MODE=raster.
#   --clean                       delete the workspace first
#   -h | --help                   this text
#
# Exit codes: 0 = all required suites passed
#             1 = a required suite failed   (see out/REPORT.md)
#             2 = prerequisite missing or licensing disclosure not acknowledged

set -u

# ── Layout ───────────────────────────────────────────────────────────────────
HARNESS="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS/../../.." && pwd)"
WORK="$REPO_ROOT/.freebuff/pdf-watermark-tests"
DOWNLOADS="$WORK/downloads"
LIBDIR="$WORK/lib"
COMPOSER_HOME_DIR="$WORK/composer-home"
GS_DIR="$WORK/gs"
OUT="$WORK/out"
FIXTURES="$WORK/fixtures"

COMPOSER_VER="2.10.3"
COMPOSER_URL="https://getcomposer.org/download/$COMPOSER_VER/composer.phar"
COMPOSER_SHA256="7a2d379d5b8ffdaa028580ef26494c36d2feef4b178d3dd1473a4dbc5e17c8d6"

BOOTSTRAP_ONLY=0
SKIP_BOOTSTRAP=0
ACCEPT_GS=0
CLEAN=0

step() { printf '==> %s\n' "$*"; }
ok()   { printf '    %s\n' "$*"; }
warn() { printf '    %s\n' "$*" >&2; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

for arg in "$@"; do
    case "$arg" in
        --bootstrap-only) BOOTSTRAP_ONLY=1 ;;
        --skip-bootstrap) SKIP_BOOTSTRAP=1 ;;
        --accept-ghostscript-license) ACCEPT_GS=1 ;;
        --clean) CLEAN=1 ;;
        -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) fail "unknown option: $arg (try --help)" 2 ;;
    esac
done

# WHICH ENGINE THIS RUN EXERCISES
#   The product default is the pure-PHP VECTOR engine (FPDI + TCPDF), which needs
#   no binaries and works on ordinary cPanel hosting. The raster engine is opt-in
#   with PDF_WATERMARK_MODE=raster and is the ONLY mode that requires Ghostscript
#   and a TTF font; without it the suite runs the vector pipeline and the pixel
#   proof is reported as SKIPPED.
MODE="${PDF_WATERMARK_MODE:-vector}"
case "$MODE" in
    raster|vector|flatten|auto) ;;
    *) fail "unknown PDF_WATERMARK_MODE=$MODE (use raster, vector, flatten or auto)" 2 ;;
esac
WANT_RASTER=0
[ "$MODE" = "raster" ] && WANT_RASTER=1

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
    else fail "neither sha256sum nor shasum is available — cannot verify downloads" 2; fi
}

fetch() { # fetch <url> <dest>
    [ -f "$2" ] && return 0
    step "Downloading $(basename "$2")"
    printf '       %s\n' "$1"
    rm -f "$2.part"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --max-time 900 -o "$2.part" "$1" || { rm -f "$2.part"; fail "download failed: $1 (check network/proxy access; partial file removed)" 2; }
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2.part" "$1" || { rm -f "$2.part"; fail "download failed: $1 (check network/proxy access; partial file removed)" 2; }
    else
        fail "need curl or wget to download dependencies" 2
    fi
    [ -s "$2.part" ] || { rm -f "$2.part"; fail "empty download: $1" 2; }
    mv "$2.part" "$2"
}

assert_sha256() { # assert_sha256 <file> <expected> <what>
    local actual
    actual="$(sha256_of "$1")"
    [ "$actual" = "$2" ] || fail "checksum mismatch for $3
  expected (sha256): $2
  actual   (sha256): $actual
  Either the download is corrupt (retry) or the upstream artifact changed (investigate before updating the pin)."
}

# ── Clean state ──────────────────────────────────────────────────────────────
if [ "$CLEAN" -eq 1 ]; then
    case "$WORK" in
        */.freebuff/pdf-watermark-tests) [ -d "$WORK" ] && { step "Removing $WORK"; rm -rf "$WORK"; } ;;
        *) fail "refusing to clean an unexpected path: $WORK" ;;
    esac
fi
mkdir -p "$DOWNLOADS" "$LIBDIR" "$COMPOSER_HOME_DIR" "$OUT" "$FIXTURES"

# ── 1. PHP (system PHP; POSIX workflows install PHP via the OS package manager) ──
if ! command -v php >/dev/null 2>&1; then
    fail "php not found on PATH.
  This workflow deliberately does NOT install system packages on Linux/macOS.
  Install PHP >= 8.1 with gd (FreeType), pdo_sqlite and mbstring, e.g.:
    Debian/Ubuntu : sudo apt install php-cli php-gd php-sqlite3 php-mbstring
    Fedora        : sudo dnf install php-cli php-gd php-pdo php-mbstring
    macOS (brew)  : brew install php
  then re-run this script." 2
fi
PHP_VER="$(php -r 'echo PHP_VERSION;')" || fail "php cannot execute" 2
case "$PHP_VER" in
    8.*|9.*) ;;
    *) fail "PHP $PHP_VER is too old (need >= 8.1)" 2 ;;
esac
MISSING="$(php -r '$m = array(); foreach (array("gd","pdo_sqlite","mbstring") as $e) { if (!extension_loaded($e)) { $m[] = $e; } } if (!function_exists("imagettftext")) { $m[] = "gd-FreeType"; } if (!function_exists("proc_open")) { $m[] = "proc_open"; } elseif (in_array("proc_open", array_map("trim", explode(",", (string) ini_get("disable_functions"))))) { $m[] = "proc_open-disabled"; } echo implode(",", $m);')"
[ -n "$MISSING" ] && fail "PHP is missing/disabled: $MISSING
  Install the corresponding packages (php-gd must include FreeType support), then re-run." 2
MEM="$(php -r 'echo ini_get("memory_limit");')"
case "$MEM" in
    -1|""|*[0-9][Gg]) ;;
    *) MEMNUM="$(printf '%s' "$MEM" | tr -cd '0-9')"; MEMNUM="${MEMNUM:-0}"
       [ "$MEMNUM" -lt 512 ] 2>/dev/null && fail "memory_limit=$MEM (need >= 512M; run with php -d memory_limit=512M or raise it in php.ini)" 2 ;;
esac
ok "PHP $PHP_VER  ($(command -v php))"

# ── 2. Composer (pinned phar, verified) ─────────────────────────────────────
COMPOSER_PHAR="$DOWNLOADS/composer.phar"
if [ "$SKIP_BOOTSTRAP" -eq 0 ]; then
    fetch "$COMPOSER_URL" "$COMPOSER_PHAR"
    assert_sha256 "$COMPOSER_PHAR" "$COMPOSER_SHA256" "composer.phar $COMPOSER_VER"
    ok "Composer $COMPOSER_VER verified (sha256)"
fi

# ── 3. FPDF + FPDI via Composer into the ignored workspace ──────────────────
if [ "$SKIP_BOOTSTRAP" -eq 0 ]; then
    step "Installing pinned FPDF/FPDI (composer install --no-interaction)"
    cp "$HARNESS/composer.json" "$HARNESS/composer.lock" "$LIBDIR/"
    COMPOSER_HOME="$COMPOSER_HOME_DIR" php "$COMPOSER_PHAR" install \
        --working-dir="$LIBDIR" --no-interaction --no-progress --prefer-dist --no-ansi \
        || fail "composer install failed — check network access to repo.packagist.org / api.github.com" 2
fi
[ -f "$LIBDIR/vendor/autoload.php" ] || fail "FPDF/FPDI are not installed (missing $LIBDIR/vendor/autoload.php). Re-run WITHOUT --skip-bootstrap." 2
ok "FPDF/FPDI present (lib/vendor)"

# ── 4. Ghostscript (detect only on POSIX; never auto-downloaded here) ────────
find_gs() {
    local cand
    for cand in "${GHOSTSCRIPT_BIN:-}" "$(command -v gswin64c 2>/dev/null)" "$(command -v gs 2>/dev/null)" "$GS_DIR/bin/gs"; do
        [ -n "$cand" ] || continue
        if "$cand" --version >/dev/null 2>&1; then
            GS_FOUND="$cand"
            return 0
        fi
    done
    return 1
}

GS_FOUND=""
if ! find_gs; then
    printf '\nGHOSTSCRIPT NOT FOUND - LICENSING DISCLOSURE\n' >&2
    cat >&2 <<'EOF'
  Ghostscript is dual-licensed: AGPL v3 (which contains a network-use clause)
  OR a commercial license sold exclusively by Artifex Software. Deciding which
  one applies to this deployment is a legal question this test workflow CANNOT
  answer; see backend/docs/PDF_WATERMARK_LICENSING.md.

  This workflow will neither download nor install Ghostscript. On Linux/macOS
  Artifex publishes no official binary archive we could pin and verify, so no
  automated download path exists here (the Windows runner downloads the official
  installer only after the -AcceptGhostscriptLicense opt-in, and even then never
  executes it itself). Passing the local tests does NOT resolve licensing
  obligations and does NOT prove shared-hosting (cPanel) compatibility.

  To proceed:
    - install Ghostscript through your own channel and/or package manager
        Debian/Ubuntu : sudo apt install ghostscript
        Fedora        : sudo dnf install ghostscript
        macOS (brew)  : brew install ghostscript
      (review the AGPL/commercial terms before you do), or set GHOSTSCRIPT_BIN
      to an existing gswin64c/gs binary;
    - acknowledge this disclosure with --accept-ghostscript-license;
    - re-run this script.
EOF
    if [ "$WANT_RASTER" -eq 1 ]; then
        [ "$ACCEPT_GS" -eq 1 ] && fail "PDF_WATERMARK_MODE=raster needs Ghostscript and none was found. Install it (above) and re-run." 2
        fail "PDF_WATERMARK_MODE=raster needs Ghostscript. Install it and acknowledge the licensing disclosure with --accept-ghostscript-license, or run the default pure-PHP vector mode." 2
    fi
    warn "Ghostscript not found — ok for the default VECTOR pipeline; the pixel proof is reported as SKIPPED."
fi
[ "$ACCEPT_GS" -eq 1 ] && ok "Ghostscript license disclosure acknowledged (--accept-ghostscript-license)"
GS_VERSION=""
if [ -n "$GS_FOUND" ]; then
    GS_VERSION="$("$GS_FOUND" --version 2>/dev/null | head -n1 | grep -o '[0-9]\+\.[0-9]\+\(\.[0-9]\+\)\?' | head -n1)"
    ok "Ghostscript ${GS_VERSION:-unknown}  ($GS_FOUND)"
fi

# ── 5. Watermark font (a TTF is REQUIRED by the raster engine) ───────────────
FONT="${PDF_WATERMARK_FONT:-}"
if [ -z "$FONT" ] || [ ! -f "$FONT" ]; then
    FONT=""
    for cand in \
        /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf \
        /usr/share/fonts/dejavu/DejaVuSans-Bold.ttf \
        /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
        /usr/share/fonts/dejavu/DejaVuSans.ttf \
        /usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf \
        /usr/share/fonts/truetype/freefont/FreeSansBold.ttf \
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" \
        "/Library/Fonts/Arial Bold.ttf" \
        "/System/Library/Fonts/Supplemental/Arial Bold" ; do
        [ -f "$cand" ] && { FONT="$cand"; break; }
    done
fi
if [ -n "$FONT" ]; then
    ok "Font: $FONT (raster engine only)"
elif [ "$WANT_RASTER" -eq 1 ]; then
    fail "no TrueType font found (looked for DejaVu/Liberation/FreeSans/Arial Bold). Set PDF_WATERMARK_FONT to any .ttf path and re-run." 2
else
    ok "Font: not needed (the vector engine embeds TCPDF's bundled DejaVu face)"
fi

# ── 6. pdftotext (optional; text checks are reported as SKIPPED without it) ──
PDFTOTEXT="${PDFTOTEXT:-}"
if [ -z "$PDFTOTEXT" ] && command -v pdftotext >/dev/null 2>&1; then
    PDFTOTEXT="$(command -v pdftotext)"
fi
if [ -n "$PDFTOTEXT" ] && [ -x "$PDFTOTEXT" ]; then
    ok "pdftotext: $PDFTOTEXT"
else
    PDFTOTEXT=""
    warn "pdftotext not found - the marker text-extraction checks will run as SKIPPED (install pdftotext from Xpdf or Poppler, or set PDFTOTEXT, to enable them)."
fi

# ── 7. Environment for the suites ───────────────────────────────────────────
export PDFTEST_WORKDIR="$WORK"
export PDF_WATERMARK_MODE="$MODE"
# The raster engine is licence-gated in the product and will not run unless the
# operator records the Ghostscript licence position; --accept-ghostscript-license
# is that acknowledgement, so the harness maps it onto the product switch.
if [ "$WANT_RASTER" = "1" ] && [ "$ACCEPT_GS" = "1" ]; then
    export PDF_WATERMARK_ACCEPT_AGPL_RENDERER=1
else
    unset PDF_WATERMARK_ACCEPT_AGPL_RENDERER 2>/dev/null || true
fi
if [ -n "$GS_FOUND" ]; then export GHOSTSCRIPT_BIN="$GS_FOUND"; fi
if [ -n "$FONT" ]; then export PDF_WATERMARK_FONT="$FONT"; fi
export PDF_WATERMARK_TEST_TMP="$OUT/tmp"
if [ -n "$PDFTOTEXT" ]; then export PDFTOTEXT; else unset PDFTOTEXT 2>/dev/null || true; fi

# ── 8. Fixtures (deterministic generation, no committed sample PDFs) ─────────
if [ "$SKIP_BOOTSTRAP" -eq 0 ]; then
    step "Building fixtures (source.pdf + failure fixtures)"
    export PDFTEST_JSON_OUT="$OUT/make_fixture.json"
    rm -f "$PDFTEST_JSON_OUT"
    if ! php -d "auto_prepend_file=$HARNESS/prepend.php" "$HARNESS/make_fixture.php" >"$OUT/make_fixture.log" 2>&1; then
        tail -n 20 "$OUT/make_fixture.log" >&2
        fail "fixture generation failed — see out/make_fixture.log" 2
    fi
    ok "fixtures built"
fi

[ "$BOOTSTRAP_ONLY" -eq 1 ] && { printf '\nBootstrap complete. Workspace: %s\n' "$WORK"; exit 0; }

# ── 9. Run the suites ────────────────────────────────────────────────────────
step "Running test suites (each suite writes out/<id>.json + out/<id>.log)"
EXITCODES_JSON=""
run_suite() { # run_suite <id> <script-path>
    local id="$1" script_path="$2" json_out log_out rc
    json_out="$OUT/$id.json"
    log_out="$OUT/$id.log"
    rm -f "$json_out" "$log_out"
    export PDFTEST_JSON_OUT="$json_out"
    php -d "auto_prepend_file=$HARNESS/prepend.php" "$script_path" >"$log_out" 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then
        ok "$id : PASS"
    else
        printf '    %s : FAIL (exit %s) - last lines of out/%s.log:\n' "$id" "$rc" "$id" >&2
        tail -n 15 "$log_out" | sed 's/^/      /' >&2
    fi
    [ -z "$EXITCODES_JSON" ] || EXITCODES_JSON="$EXITCODES_JSON,"
    EXITCODES_JSON="$EXITCODES_JSON\"$id\":$rc"
}

run_suite real_pipeline  "$HARNESS/run_real_test.php"
run_suite repo_verify    "$REPO_ROOT/backend/scripts/verify-watermark.php"
run_suite error_handling "$HARNESS/error_tests.php"
run_suite authorization  "$HARNESS/auth_tests.php"
run_suite delivery       "$HARNESS/delivery_tests.php"
run_suite flatten_engine "$HARNESS/flatten_engine_tests.php"
run_suite gallery        "$HARNESS/make_gallery.php"
printf '{%s}' "$EXITCODES_JSON" > "$OUT/exitcodes.json"

# ── 10. Machine-readable summary + human-readable report ────────────────────
step "Writing out/summary.json and out/REPORT.md"
php "$HARNESS/summarize.php"
sum_rc=$?
if [ "$sum_rc" -eq 0 ]; then
    printf '\nALL REQUIRED SUITES PASSED - report: %s/out/REPORT.md\n' "$WORK"
else
    printf '\nTEST FAILURE - see %s/out/REPORT.md\n' "$WORK" >&2
fi
printf 'Visual gallery (inspect manually, never auto-opened): %s/out/gallery.html\n' "$WORK"
exit "$sum_rc"
