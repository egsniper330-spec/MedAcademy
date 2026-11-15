#!/usr/bin/env bash
# Verify the approved WAM checkpoint SHA-256 before it is installed or loaded.
# Safe to run: read-only. Usage: scripts/install_checkpoint_verify.sh /path/to/wam_mit.pth
set -euo pipefail

# Pinned SHA-256 of the approved checkpoint (same value as app/wam_adapter.py). Do not change without re-approval.
EXPECTED_SHA256="90ef232384e023bd63245eb0c131abd69d2afc7b8f17a71ccedceb542bf009e2"

if [ "$#" -ne 1 ]; then
  echo "usage: $0 /path/to/wam_mit.pth" >&2
  exit 2
fi

ckpt="$1"
if [ "$(basename "$ckpt")" != "wam_mit.pth" ]; then
  echo "refusing: checkpoint filename must be wam_mit.pth" >&2
  exit 2
fi
if [ ! -f "$ckpt" ] || [ -L "$ckpt" ]; then
  echo "refusing: $ckpt is missing or a symlink" >&2
  exit 2
fi

actual="$(sha256sum "$ckpt" | cut -d' ' -f1)"
if [ "$actual" != "$EXPECTED_SHA256" ]; then
  echo "checkpoint hash MISMATCH (expected $EXPECTED_SHA256, got $actual)" >&2
  exit 1
fi
echo "checkpoint hash OK: $actual"
