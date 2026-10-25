#!/usr/bin/env bash
#
# run.sh — run the material upload-integrity + file-lifecycle suite.
#
# Requires PHP 8.2+ with pdo_sqlite (a stock CLI build on cPanel/Ubuntu has it).
# No network access, no Composer install, no production data: the workspace lives
# at .freebuff/material-lifecycle-tests and is git-ignored.
#
#   bash backend/tests/material-lifecycle/run.sh [--clean]
#
# Exit codes: 0 = all checks passed, 1 = a check failed, 2 = prerequisite missing.

set -u

HARNESS="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS/../../.." && pwd)"
WORK="$REPO_ROOT/.freebuff/material-lifecycle-tests"

if [ "${1:-}" = "--clean" ]; then
    rm -rf "$WORK"
    echo "workspace removed: $WORK"
    exit 0
fi

if ! command -v php >/dev/null 2>&1; then
    echo "ERROR: php is not on PATH — this suite runs the real PHP services." >&2
    exit 2
fi

if ! php -r 'exit(extension_loaded("pdo_sqlite") ? 0 : 1);' >/dev/null 2>&1; then
    echo "ERROR: PHP extension pdo_sqlite is required (it provides the isolated test database)." >&2
    exit 2
fi

php -v | head -n1
export MATTEST_WORKDIR="$WORK"
rm -rf "$WORK/out"
php "$HARNESS/upload_and_cleanup_tests.php"
exit $?
