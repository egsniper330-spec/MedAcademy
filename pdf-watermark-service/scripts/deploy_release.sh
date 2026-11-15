#!/usr/bin/env bash
# Controlled release switch for the PDF watermark service. Run on the VPS by the operator.
#
# Safety classes:
#   [PREPARE]   safe: stages a release directory, does not stop or change running services.
#   [OPERATOR]  requires approval: restarts services (short interruption of issuance).
#   [DATA]      never performed here. DB migration is a separate, explicitly approved step (docs/OPERATIONS.md).
#
# Usage:
#   scripts/deploy_release.sh stage  <release_src_dir>   [PREPARE]
#   scripts/deploy_release.sh switch <release_name>       [OPERATOR] stop, swap symlink, start, health-check
#   scripts/deploy_release.sh rollback <previous_release> [OPERATOR] swap back, restart, health-check
set -euo pipefail

RELEASES="${RELEASES:-/opt/pdf-watermark-releases}"
CURRENT="/opt/pdf-watermark-service"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8787/readyz}"

stage() {   # [PREPARE] copy source, never touch CURRENT or services
  local src="$1" name
  name="rel-$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -m 0755 "$RELEASES/$name"
  # Copy source and the release deploy files only. Excludes data, storage, DB, .env and .venv.
  tar -C "$src" --exclude='./data' --exclude='./.venv' --exclude='./.env' --exclude='./wam' \
      --exclude='*.pth' --exclude='*.pt' --exclude='__pycache__' -cf - . | tar -C "$RELEASES/$name" -xf -
  echo "staged $RELEASES/$name"
  echo "$name"
}

switch() {  # [OPERATOR]
  local name="$1" target="$RELEASES/$1"
  test -d "$target" || { echo "no such release: $name" >&2; exit 2; }
  local prev; prev="$(readlink -f "$CURRENT" || true)"
  echo "previous release: ${prev:-none}"
  systemctl stop pdf-watermark-cleanup.service pdf-watermark-api.service
  ln -sfn "$target" "$CURRENT.new" && mv -Tf "$CURRENT.new" "$CURRENT"
  systemctl start pdf-watermark-wam.service pdf-watermark-api.service pdf-watermark-cleanup.service
  health_check
}

rollback() {  # [OPERATOR]
  switch "$1"
}

health_check() {
  local i
  for i in 1 2 3 4 5 6; do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      echo "health OK: $HEALTH_URL"; return 0
    fi
    sleep 5
  done
  echo "health FAILED: $HEALTH_URL (check: journalctl -u pdf-watermark-api)" >&2
  return 1
}

case "${1:-}" in
  stage) stage "${2:?release source dir required}" ;;
  switch) switch "${2:?release name required}" ;;
  rollback) rollback "${2:?previous release name required}" ;;
  *) echo "usage: $0 {stage <src>|switch <rel>|rollback <rel>}" >&2; exit 2 ;;
esac
