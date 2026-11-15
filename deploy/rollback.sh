#!/usr/bin/env bash
# Restore a MedAcademy production backup created by deploy.sh.
#
# Usage:
#   CONFIRM_ROLLBACK=yes ./deploy/rollback.sh <backup-timestamp> [portal|backend|all]
#
# Example:
#   CONFIRM_ROLLBACK=yes ./deploy/rollback.sh 20261101T172257Z portal

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.env
source "$SCRIPT_DIR/config.env"

BACKUP_TS="${1:-}"
SCOPE="${2:-all}"
case "$SCOPE" in
  all|portal|backend) ;;
  *) echo "Usage: CONFIRM_ROLLBACK=yes $0 <backup-timestamp> [all|portal|backend]" >&2; exit 2 ;;
esac
[ -n "$BACKUP_TS" ] || {
  echo "Usage: CONFIRM_ROLLBACK=yes $0 <backup-timestamp> [all|portal|backend]" >&2
  exit 2
}
[ "${CONFIRM_ROLLBACK:-}" = "yes" ] || {
  echo "Refusing to roll back without CONFIRM_ROLLBACK=yes" >&2
  exit 2
}

SSH_OPTS=(
  -i "$SSH_KEY"
  -p "$SSH_PORT"
  -o BatchMode=yes
  -o ConnectTimeout=25
  -o ServerAliveInterval=15
)
rssh() { ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" "$@"; }

echo "=== Rollback $BACKUP_TS ($SCOPE) ==="
rssh "TS='$BACKUP_TS' SCOPE='$SCOPE' bash -s" <<'REMOTE'
set -euo pipefail
B="$HOME/backups/medacademy-$TS"

case "$SCOPE" in
  all|portal)
    [ -f "$B/portal-site-pre-deploy.tar.gz" ] || { echo "Portal backup not found" >&2; exit 1; }
    tar -tzf "$B/portal-site-pre-deploy.tar.gz" >/dev/null
    tar -xzf "$B/portal-site-pre-deploy.tar.gz" -C "$HOME"
    echo "Portal restored from $B/portal-site-pre-deploy.tar.gz"
    ;;
esac

case "$SCOPE" in
  all|backend)
    [ -f "$B/backend-app-source-pre-deploy.tar.gz" ] || { echo "Backend backup not found" >&2; exit 1; }
    tar -tzf "$B/backend-app-source-pre-deploy.tar.gz" >/dev/null
    tar -xzf "$B/backend-app-source-pre-deploy.tar.gz" -C "$HOME/api.medacademy.site"
    echo "Backend source restored from $B/backend-app-source-pre-deploy.tar.gz"
    ;;
esac
REMOTE

echo "Rollback complete. Verify the affected service immediately."
