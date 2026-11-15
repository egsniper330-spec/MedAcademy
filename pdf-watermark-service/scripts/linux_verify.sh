#!/usr/bin/env bash
# Linux verification for the PDF watermark service: flock behaviour, cleanup lock contention
# (expects exit 3), and systemd unit checks. Run on the Linux VPS (or any Linux host with
# python3 and util-linux), NOT on Windows. It creates only a scratch directory and removes it.
#
# Usage:  bash scripts/linux_verify.sh /opt/pdf-watermark-service/.venv/bin/python
# Exit:   0 all checks passed, 1 a check failed, 77 prerequisite missing (skipped).
set -u

PY="${1:-python3}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }
cleanup_work() { rm -rf "$WORK"; }
trap cleanup_work EXIT

if [ "$(uname -s)" != "Linux" ]; then
  echo "SKIP  not Linux ($(uname -s)); this script verifies Linux fcntl.flock and systemd only."
  exit 77
fi
command -v "$PY" >/dev/null 2>&1 || { echo "SKIP  python not found: $PY"; exit 77; }
command -v flock >/dev/null 2>&1 || echo "NOTE  'flock' CLI absent; using python fcntl only"

LOCK="$WORK/cleanup.lock"

# --- 1. Exclusive lock: first holder acquires, second non-blocking attempt is refused -----------
"$PY" - "$LOCK" <<'PYEOF' &
import fcntl, sys, time
h = open(sys.argv[1], "a+b")
fcntl.flock(h.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
print("holder: locked", flush=True)
time.sleep(30)
PYEOF
HOLDER=$!
sleep 1

"$PY" - "$LOCK" <<'PYEOF'
import fcntl, sys
h = open(sys.argv[1], "a+b")
try:
    fcntl.flock(h.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    sys.exit(1)  # acquired while held: BAD
except OSError:
    sys.exit(0)  # refused: GOOD
PYEOF
[ $? -eq 0 ] && pass "second process refused while lock held (flock LOCK_EX|LOCK_NB)" \
  || fail "second process acquired a lock that should be held"

# --- 2. Release on SIGKILL of the holder (process termination) ---------------------------------
kill -9 "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
"$PY" - "$LOCK" <<'PYEOF'
import fcntl, sys
h = open(sys.argv[1], "a+b")
fcntl.flock(h.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
sys.exit(0)
PYEOF
[ $? -eq 0 ] && pass "lock released after SIGKILL of holder" || fail "lock not released after SIGKILL"

# --- 3. Release on SIGTERM of the holder (default action terminates the process) --------------
"$PY" - "$LOCK" <<'PYEOF' &
import fcntl, sys, time
h = open(sys.argv[1], "a+b")
fcntl.flock(h.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
time.sleep(30)
PYEOF
HOLDER=$!
sleep 1
kill -TERM "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
"$PY" - "$LOCK" <<'PYEOF'
import fcntl, sys
h = open(sys.argv[1], "a+b")
fcntl.flock(h.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
sys.exit(0)
PYEOF
[ $? -eq 0 ] && pass "lock released after SIGTERM of holder" || fail "lock not released after SIGTERM"

# --- 4. Cleanup runner contention: second instance exits 3 while the first holds the lock ------
# Requires a configured environment for app.cleanup_runner. Uses a scratch state dir.
export PDF_SVC_STATE_DB_PATH="$WORK/state/state.sqlite3"
export PDF_SVC_STORAGE_ROOT="$WORK/storage"
export PDF_SVC_CLEANUP_INTERVAL_SECONDS=60
export PDF_SVC_WAM_HMAC_KEY="${PDF_SVC_WAM_HMAC_KEY:-verify-only-not-a-secret-0123456789abcdef}"
mkdir -p "$WORK/state" "$WORK/storage"
(cd "$REPO" && "$PY" -m app.cleanup_runner) >"$WORK/runner1.log" 2>&1 &
RUNNER1=$!
sleep 3
(cd "$REPO" && "$PY" -m app.cleanup_runner) >"$WORK/runner2.log" 2>&1
RC=$?
if [ "$RC" -eq 3 ]; then
  pass "second cleanup runner exits 3 while first holds cleanup.lock"
else
  fail "second cleanup runner exit code was $RC (expected 3); see $WORK/runner2.log"
fi
kill -TERM "$RUNNER1" 2>/dev/null; wait "$RUNNER1"; RC1=$?
[ "$RC1" -eq 0 ] && pass "first cleanup runner exits 0 on SIGTERM" \
  || fail "first cleanup runner exit code after SIGTERM was $RC1 (expected 0)"

# After the first runner stopped, the lock must be free again (restart recovery).
(cd "$REPO" && "$PY" -m app.cleanup_runner) >"$WORK/runner3.log" 2>&1 &
RUNNER3=$!
sleep 3
kill -TERM "$RUNNER3" 2>/dev/null; wait "$RUNNER3"; RC3=$?
[ "$RC3" -eq 0 ] && pass "runner restarts cleanly after prior holder exited" \
  || fail "runner did not restart after prior holder exited (rc=$RC3)"

# --- 5. Systemd unit checks (only if systemd-analyze is present) -------------------------------
UNITS="$REPO/deploy/systemd"
if command -v systemd-analyze >/dev/null 2>&1; then
  for u in pdf-watermark-api pdf-watermark-wam pdf-watermark-cleanup; do
    # verify checks syntax and referenced executables; missing paths on a dev box are expected to warn.
    if systemd-analyze verify "$UNITS/$u.service" >"$WORK/$u.verify" 2>&1; then
      pass "systemd-analyze verify: $u.service"
    else
      fail "systemd-analyze verify: $u.service (see $WORK/$u.verify)"
    fi
  done
else
  echo "SKIP  systemd-analyze not present; run the systemd checklist in docs/VPS_CHECKLIST.md"
fi

if [ "$FAILS" -eq 0 ]; then echo "RESULT: all checks passed"; exit 0; fi
echo "RESULT: $FAILS check(s) failed"; exit 1
