#!/usr/bin/env bash
# MedAcademy guarded production deployment.
#
# Usage:
#   ./deploy/deploy.sh              # portal + backend
#   ./deploy/deploy.sh portal       # portal build only
#   ./deploy/deploy.sh backend      # backend source only
#
# A failed test, build, PHP lint, checksum or smoke test stops the release.
# Backups are created before any production file is replaced.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PORTAL_DIR="$PROJECT_ROOT/portal"
BACKEND_DIR="$PROJECT_ROOT/backend"

# shellcheck source=config.env
source "$SCRIPT_DIR/config.env"

MODE="${1:-all}"
case "$MODE" in
  all|portal|backend) ;;
  *) echo "Usage: $0 [all|portal|backend]" >&2; exit 2 ;;
esac

for command_name in ssh scp tar sha256sum npm curl; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Missing required command: $command_name" >&2
    exit 2
  }
done

[ -f "$SSH_KEY" ] || {
  echo "SSH key not found at $SSH_KEY" >&2
  exit 2
}

TS="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$SCRIPT_DIR/logs/$TS"
mkdir -p "$RUN_DIR"
LOG="$RUN_DIR/deploy.log"
exec > >(tee -a "$LOG") 2>&1

SSH_OPTS=(
  -i "$SSH_KEY"
  -p "$SSH_PORT"
  -o BatchMode=yes
  -o ConnectTimeout=25
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=4
)
rssh() { ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" "$@"; }
rscp() { scp -q -P "$SSH_PORT" -i "$SSH_KEY" "$@"; }

PORTAL_ARCHIVE="$RUN_DIR/portal-dist.tar.gz"
BACKEND_ARCHIVE="$RUN_DIR/backend-app-source.tar.gz"
PORTAL_MANIFEST="$RUN_DIR/portal.sha256"
BACKEND_MANIFEST="$RUN_DIR/backend.sha256"
BACKEND_LIST="$RUN_DIR/backend-files.txt"

echo "=== MedAcademy deployment $TS ($MODE) ==="
echo "Log: $LOG"

rssh 'echo "Connected to $(hostname) as $(whoami)"; df -h "$HOME" | tail -1'

# --- Build and validate -----------------------------------------------------
if [ "$MODE" = "all" ] || [ "$MODE" = "portal" ]; then
  echo "=== Portal tests, build, lint ==="
  (
    cd "$PORTAL_DIR"
    npm test
    npm run build
    npm run lint
  )

  if find "$PORTAL_DIR/dist" \( -name '*.map' -o -name '.env*' -o -name '*.ts' -o -name '*.tsx' \) -print -quit | grep -q .; then
    echo "Refusing to deploy: development or secret files found in portal/dist" >&2
    exit 1
  fi
  if ! grep -Rqs "$API_URL" "$PORTAL_DIR/dist/assets"; then
    echo "Refusing to deploy: expected API origin missing from portal bundle" >&2
    exit 1
  fi

  (
    cd "$PORTAL_DIR/dist"
    find . -type f -printf '%P\n' | sort | xargs sha256sum
  ) > "$PORTAL_MANIFEST"
  tar -czf "$PORTAL_ARCHIVE" -C "$PORTAL_DIR/dist" .
  echo "Portal payload: $(wc -l < "$PORTAL_MANIFEST") files"
fi

if [ "$MODE" = "all" ] || [ "$MODE" = "backend" ]; then
  echo "=== Backend source manifest, with PHP syntax validation on server ==="
  (
    cd "$BACKEND_DIR"
    {
      find src config routes -type f -not -name '*.bak-*' -print
      printf '%s\n' public/index.php public/.htaccess composer.json composer.lock
    } | sort | tee "$BACKEND_LIST"
  )
  (
    cd "$BACKEND_DIR"
    while IFS= read -r file; do sha256sum "$file"; done < "$BACKEND_LIST"
  ) > "$BACKEND_MANIFEST"
  tar -czf "$BACKEND_ARCHIVE" -C "$BACKEND_DIR" -T "$BACKEND_LIST"
  echo "Backend payload: $(wc -l < "$BACKEND_MANIFEST") files"
fi

# --- Remote backup ----------------------------------------------------------
echo "=== Timestamped production backup ==="
rssh "TS='$TS' MODE='$MODE' bash -s" <<'REMOTE'
set -euo pipefail
BACKUP="$HOME/backups/medacademy-$TS"
mkdir -p "$BACKUP"

case "$MODE" in
  all|portal)
    tar -czf "$BACKUP/portal-site-pre-deploy.tar.gz" -C "$HOME" portal.medacademy.site
    (cd "$HOME/portal.medacademy.site" && find . -type f -print0 | sort -z | xargs -0 sha256sum) \
      > "$BACKUP/portal-before.sha256"
    ;;
esac
case "$MODE" in
  all|backend)
    tar -czf "$BACKUP/backend-app-source-pre-deploy.tar.gz" -C "$HOME/api.medacademy.site" \
      src config routes public/index.php public/.htaccess composer.json composer.lock
    (cd "$HOME/api.medacademy.site" && {
      find src config routes -type f -not -name '*.bak-*' -print
      printf '%s\n' public/index.php public/.htaccess composer.json composer.lock
    } | sort | xargs sha256sum) > "$BACKUP/backend-before.sha256"
    ;;
esac

sha256sum "$BACKUP"/*.tar.gz
echo "BACKUP=$BACKUP"
REMOTE

# --- Upload to staging ------------------------------------------------------
echo "=== Upload to staging ==="
if [ "$MODE" = "all" ] || [ "$MODE" = "portal" ]; then
  rscp "$PORTAL_ARCHIVE" "$SSH_USER@$SSH_HOST:/tmp/portal-dist-$TS.tar.gz"
  rscp "$PORTAL_MANIFEST" "$SSH_USER@$SSH_HOST:/tmp/portal-intended-$TS.sha256"
fi
if [ "$MODE" = "all" ] || [ "$MODE" = "backend" ]; then
  rscp "$BACKEND_ARCHIVE" "$SSH_USER@$SSH_HOST:/tmp/backend-app-$TS.tar.gz"
  rscp "$BACKEND_MANIFEST" "$SSH_USER@$SSH_HOST:/tmp/backend-intended-$TS.sha256"
fi

# --- Activate with atomic file replacement ---------------------------------
echo "=== Activate release ==="
activate_release() {
  rssh "bash -s -- '$TS' '$MODE'" <<'REMOTE'
set -euo pipefail
TS="$1"
MODE="$2"
STAGING="$HOME/deploy-staging/$TS"
mkdir -p "$STAGING"

atomic_install() {
  src="$1"
  dest="$2"
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  tmp="$dest.deploy.$$"
  cp "$src" "$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$dest"
}

if [ "$MODE" = "all" ] || [ "$MODE" = "portal" ]; then
  tar -xzf "/tmp/portal-dist-$TS.tar.gz" -C "$STAGING"
  P="$HOME/portal.medacademy.site"
  mkdir -p "$P/assets" "$P/fonts"
  install -m 644 "$STAGING"/assets/*.css "$P/assets/"
  install -m 644 "$STAGING"/assets/*.js "$P/assets/"
  install -m 644 "$STAGING"/fonts/*.woff2 "$P/fonts/"
  install -m 644 "$STAGING/favicon.svg" "$P/favicon.svg"
  # Install the new entry point last so assets exist before the document changes.
  atomic_install "$STAGING/index.html" "$P/index.html"
  atomic_install "$STAGING/.htaccess" "$P/.htaccess"
  echo "Portal files activated."
fi

if [ "$MODE" = "all" ] || [ "$MODE" = "backend" ]; then
  SB="$STAGING-backend"
  mkdir -p "$SB"
  tar -xzf "/tmp/backend-app-$TS.tar.gz" -C "$SB"
  A="$HOME/api.medacademy.site"
  (cd "$SB" && {
    find src config routes -type f -not -name '*.bak-*' -print
    printf '%s\n' public/index.php public/.htaccess composer.json composer.lock
  } | sort) > "$SB/files.list"

  while IFS= read -r rel; do
    atomic_install "$SB/$rel" "$A/$rel"
  done < "$SB/files.list"

  # Never activate backend source that does not parse.
  while IFS= read -r rel; do
    case "$rel" in
      *.php) php -l "$A/$rel" >/dev/null ;;
    esac
  done < "$SB/files.list"
  echo "Backend source activated and PHP syntax verified."
fi
REMOTE
}

ACTIVATED=0
for attempt in 1 2 3; do
  if activate_release; then ACTIVATED=1; break; fi
  echo "Activation connection was interrupted; retrying ($attempt/3)..." >&2
  sleep $((attempt * 4))
done
[ "$ACTIVATED" = "1" ] || {
  echo "Activation did not complete. Production backup: $BACKUP_ROOT/medacademy-$TS" >&2
  exit 1
}

# --- Verify deployed checksums ---------------------------------------------
echo "=== Checksum verification ==="
verify_remote_manifest() {
  label="$1"
  root="$2"
  manifest="$3"
  output="$4"
  total="$5"
  for attempt in 1 2 3; do
    if rssh "cd '$root' && sha256sum -c '$manifest'" > "$output" 2>/dev/null; then
      echo "$label: $(grep -c ': OK$' "$output")/$total files match."
      return 0
    fi
    echo "$label checksum connection interrupted; retrying ($attempt/3)..." >&2
    sleep $((attempt * 4))
  done
  cat "$output"
  return 1
}

if [ "$MODE" = "all" ] || [ "$MODE" = "portal" ]; then
  if ! verify_remote_manifest "Portal" "$PORTAL_ROOT" "/tmp/portal-intended-$TS.sha256" "$RUN_DIR/portal-verify.txt" "$(wc -l < "$PORTAL_MANIFEST")"; then
    echo "Portal checksum verification failed." >&2
    exit 1
  fi
fi

if [ "$MODE" = "all" ] || [ "$MODE" = "backend" ]; then
  if ! verify_remote_manifest "Backend" "$API_ROOT" "/tmp/backend-intended-$TS.sha256" "$RUN_DIR/backend-verify.txt" "$(wc -l < "$BACKEND_MANIFEST")"; then
    echo "Backend checksum verification failed." >&2
    exit 1
  fi
fi

# --- Production smoke tests -------------------------------------------------
echo "=== Production smoke tests ==="
run_smoke_tests() {
  rssh "bash -s -- '$PORTAL_URL' '$API_URL'" <<'REMOTE'
set -euo pipefail
PORTAL_URL="$1"
API_URL="$2"
fail() { echo "FAIL: $1" >&2; exit 1; }

portal_home="$(curl -sS --max-time 25 "$PORTAL_URL/")"
echo "$portal_home" | grep -q 'assets/index-' || fail "portal entrypoint has no bundle"
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 25 "$PORTAL_URL/")"
[ "$code" = "200" ] || fail "portal home HTTP $code"

code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 25 "$PORTAL_URL/courses")"
[ "$code" = "200" ] || fail "SPA refresh HTTP $code"

for asset in $(echo "$portal_home" | grep -o '/assets/index-[^" ]*'); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 25 "$PORTAL_URL$asset")"
  [ "$code" = "200" ] || fail "asset $asset HTTP $code"
done

code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 25 "$PORTAL_URL/fonts/NotoSansArabic-Regular.woff2")"
[ "$code" = "200" ] || fail "font HTTP $code"

headers="$(curl -sSI --max-time 25 "$PORTAL_URL/")"
echo "$headers" | grep -qi 'strict-transport-security:' || fail "missing HSTS"
echo "$headers" | grep -qi 'content-security-policy:' || fail "missing CSP"
echo "$headers" | grep -qi 'cache-control: no-cache' || fail "index cache policy missing"

body="$(curl -sS --max-time 25 "$API_URL/health")"
echo "$body" | grep -q '"status":"ok"' || fail "API health not ok"

code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 25 "$API_URL/auth/me")"
[ "$code" = "401" ] || fail "unauth /auth/me HTTP $code"

code="$(curl -sS -o /dev/null -w '%{http_code}' -X OPTIONS \
  -H "Origin: $PORTAL_URL" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" \
  --max-time 25 "$API_URL/portal/auth/login")"
[ "$code" = "204" ] || fail "portal CORS preflight HTTP $code"

echo "Portal: 200 home, SPA refresh, bundle, font, HSTS/CSP/cache headers."
echo "API: health ok, unauthenticated session 401, portal CORS 204."
REMOTE
}

SMOKE_OK=0
for attempt in 1 2 3; do
  if run_smoke_tests; then SMOKE_OK=1; break; fi
  echo "Smoke-test connection interrupted; retrying ($attempt/3)..." >&2
  sleep $((attempt * 4))
done
[ "$SMOKE_OK" = "1" ] || {
  echo "Production smoke tests failed. Backup: $BACKUP_ROOT/medacademy-$TS" >&2
  exit 1
}

echo "=== Deployment $TS verified ==="
echo "Backup: $BACKUP_ROOT/medacademy-$TS"
echo "Log: $LOG"
