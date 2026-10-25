#!/usr/bin/env bash
#
# run.sh — free-course enrollment regression suite (real PHP controller).
#
# Requires PHP 8.2+ with pdo_sqlite. No network, no Composer install, no
# production data: the workspace lives at .freebuff/enrollment-tests and is
# git-ignored.
#
#   bash backend/tests/course-enrollment/run.sh [--clean]
#
# Exit codes: 0 = all checks passed, 1 = a check failed, 2 = prerequisite missing.

set -u

HARNESS="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS/../../.." && pwd)"
WORK="$REPO_ROOT/.freebuff/enrollment-tests"

if [ "${1:-}" = "--clean" ]; then
    rm -rf "$WORK"
    echo "workspace removed: $WORK"
    exit 0
fi

if ! command -v php >/dev/null 2>&1; then
    echo "ERROR: php is not on PATH — this suite runs the real PHP controller." >&2
    exit 2
fi

if ! php -r 'exit(extension_loaded("pdo_sqlite") ? 0 : 1);' >/dev/null 2>&1; then
    echo "ERROR: PHP extension pdo_sqlite is required (it provides the isolated test database)." >&2
    exit 2
fi

php -l "$HARNESS/enroll_tests.php" >/dev/null || exit 2

php -v | head -n1
export ENROLLTEST_WORKDIR="$WORK"
rm -rf "$WORK/out"
mkdir -p "$WORK/out"
php "$HARNESS/enroll_tests.php"
exit $?
