#!/usr/bin/env bash
# Install the PDF watermark service on a Linux VPS. Prepares files and venvs only.
#
# Safety classes (see docs/OPERATIONS.md):
#   [PREPARE]   safe to run: creates directories and venvs, does not touch data.
#   [OPERATOR]  requires VPS operator approval: creates system users, writes /etc, installs units.
#   [DATA]      modifies or migrates production data: never run automatically by this script.
#
# Usage: sudo scripts/install_vps.sh <stage>
#   stages: prepare | users | storage | venvs | units | checkpoint-check
#   'all' runs prepare, users, storage, venvs and units. It does NOT run DB migration or start services.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/pdf-watermark-service}"
WAM_DIR="${WAM_DIR:-/opt/pdf-watermark-wam}"
DATA_DIR="${DATA_DIR:-/var/lib/pdf-watermark}"
ETC_DIR="/etc/pdf-watermark"
UNIT_DIR="/etc/systemd/system"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

log() { printf '[%s] %s\n' "$1" "$2"; }

stage_prepare() {   # [PREPARE] no system changes
  log PREPARE "checking source tree at $SRC_DIR"
  test -f "$SRC_DIR/requirements.txt" && test -f "$SRC_DIR/requirements-wam.txt"
  test -f "$SRC_DIR/deploy/env/api.env.example" && test -f "$SRC_DIR/deploy/env/wam.env.example"
  log PREPARE "source tree OK"
}

stage_users() {     # [OPERATOR] creates unprivileged system users
  id pdfsvc >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin pdfsvc
  id pdfwam >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin pdfwam
  log OPERATOR "users pdfsvc and pdfwam present"
}

stage_storage() {   # [PREPARE] private directories, not web-served, no secrets written
  install -d -m 0750 -o pdfsvc -g pdfsvc "$DATA_DIR" "$DATA_DIR/storage"
  install -d -m 0750 -o pdfwam -g pdfwam "$DATA_DIR/wam-state"
  install -d -m 0750 -o root -g pdfsvc "$ETC_DIR"
  log PREPARE "storage directories created with mode 0750 (no web root involved)"
}

stage_venvs() {     # [PREPARE] pinned dependencies per runtime
  python3 -m venv "$APP_DIR/.venv"
  "$APP_DIR/.venv/bin/pip" install -r "$SRC_DIR/requirements.txt"
  python3 -m venv "$WAM_DIR/venv"
  # CPU torch wheels come from the PyTorch index; pin matches requirements-wam.txt.
  "$WAM_DIR/venv/bin/pip" install --index-url https://download.pytorch.org/whl/cpu \
    torch==2.2.2 torchvision==0.17.2
  "$WAM_DIR/venv/bin/pip" install -r "$SRC_DIR/requirements-wam.txt" \
    --extra-index-url https://download.pytorch.org/whl/cpu
  log PREPARE "API and WAM virtualenvs installed from pinned requirement files"
}

stage_units() {     # [OPERATOR] installs unit files and env templates (never overwrites existing env files)
  install -m 0644 "$SRC_DIR/deploy/systemd/pdf-watermark-api.service" "$UNIT_DIR/"
  install -m 0644 "$SRC_DIR/deploy/systemd/pdf-watermark-wam.service" "$UNIT_DIR/"
  install -m 0644 "$SRC_DIR/deploy/systemd/pdf-watermark-cleanup.service" "$UNIT_DIR/"
  [ -f "$ETC_DIR/api.env" ] || install -m 0640 -o root -g pdfsvc "$SRC_DIR/deploy/env/api.env.example" "$ETC_DIR/api.env"
  [ -f "$ETC_DIR/wam.env" ] || install -m 0640 -o root -g pdfwam "$SRC_DIR/deploy/env/wam.env.example" "$ETC_DIR/wam.env"
  systemctl daemon-reload
  log OPERATOR "units installed; env files created from templates ONLY if missing. Edit them: replace every CHANGE-ME value."
}

stage_checkpoint_check() {  # [PREPARE] read-only hash verification
  "$SRC_DIR/scripts/install_checkpoint_verify.sh" "$APP_DIR/wam/checkpoints/wam_mit.pth"
}

case "${1:-}" in
  prepare) stage_prepare ;;
  users) stage_users ;;
  storage) stage_storage ;;
  venvs) stage_venvs ;;
  units) stage_units ;;
  checkpoint-check) stage_checkpoint_check ;;
  all) stage_prepare; stage_users; stage_storage; stage_venvs; stage_units ;;
  *) echo "usage: $0 {prepare|users|storage|venvs|units|checkpoint-check|all}" >&2; exit 2 ;;
esac
