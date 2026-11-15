#!/usr/bin/env bash
# Compatibility wrapper. The canonical guarded workflow is deploy/deploy.sh at
# the repository root, which also verifies checksums and production endpoints.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec "$ROOT/deploy/deploy.sh" portal
