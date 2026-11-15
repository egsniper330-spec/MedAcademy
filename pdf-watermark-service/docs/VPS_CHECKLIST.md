# VPS staged checklist (NOT EXECUTED)

Status: prepared only. None of these steps has been run on a VPS. Do not deploy from this document
without explicit approval. Paths and users are placeholders, matching `deploy/systemd/*.service`.

Rollback precaution for every stage: use `scripts/deploy_release.sh rollback` (Section L), stop the three services before changing files, keep a copy of
the previous release and `/var/lib/pdf-watermark` (state DB and storage), and never delete state to
"reset" a problem.

Expected layout: service code `/opt/pdf-watermark-service`, WAM runtime `/opt/pdf-watermark-wam`,
env files `/etc/pdf-watermark/{api,wam}.env` (root-owned, mode 0640, group pdfsvc or pdfwam),
state and storage `/var/lib/pdf-watermark`, WAM nonce state `/var/lib/pdf-watermark/wam-state`.

## A. Environment and dependencies
1. `python3 --version` -> 3.11 or the version pinned in docs/OPERATIONS.md.
2. `id pdfsvc && id pdfwam` -> both users exist, neither has a login shell needed for the service.
3. `/opt/pdf-watermark-service/.venv/bin/python -c "import app.server"` (run from the repo dir) -> exit 0.
4. `/opt/pdf-watermark-wam/venv/bin/python -c "import torch; print(torch.__version__)"` -> prints the pinned torch (CPU build).
5. Confirm no `wam_coco.pth` and no TrustMark files are present under `/opt/pdf-watermark-wam`.
Rollback: none needed; this stage changes nothing.

## B. Checkpoint SHA-256 verification
1. `bash /opt/pdf-watermark-service/scripts/install_checkpoint_verify.sh /opt/pdf-watermark-service/wam/checkpoints/wam_mit.pth`
   Expected: `checkpoint hash OK: 90ef232384e023bd63245eb0c131abd69d2afc7b8f17a71ccedceb542bf009e2`, exit 0.
   This script is read-only and refuses any filename other than `wam_mit.pth` or a symlink.
2. If the hash differs, stop. Do not start the WAM unit.
Rollback: restore the checkpoint from the known-good copy and re-check the hash.

## C. Storage permissions and web-root isolation
1. `stat -c '%U:%G %a %n' /var/lib/pdf-watermark /var/lib/pdf-watermark/storage /var/lib/pdf-watermark/wam-state`
   Expected: owned by pdfsvc (wam-state by pdfwam), mode `700` or `750`.
2. `stat -c '%a %n' /etc/pdf-watermark/*.env` -> mode `640`, owner root.
3. Web-root isolation: confirm the storage root is not under any web server document root. For example
   `grep -R "/var/lib/pdf-watermark" /etc/nginx /etc/apache2 2>/dev/null` returns nothing.
4. `curl -sk -o /dev/null -w '%{http_code}\n' https://<host>/storage/` -> not 200 (no static exposure).
Rollback: revert permissions with `chmod`/`chown` to the previous values; no data change.

## D. Starting the three services
1. `sudo systemd-analyze verify /etc/systemd/system/pdf-watermark-{wam,api,cleanup}.service` -> no errors.
2. `sudo systemctl daemon-reload`
3. `sudo systemctl start pdf-watermark-wam` then `systemctl is-active pdf-watermark-wam` -> `active`
   (startup can take up to 300 s while the checkpoint loads).
4. `sudo systemctl start pdf-watermark-api` then `systemctl is-active pdf-watermark-api` -> `active`.
5. `sudo systemctl start pdf-watermark-cleanup` then `systemctl is-active pdf-watermark-cleanup` -> `active`.
6. `journalctl -u pdf-watermark-api -u pdf-watermark-wam -u pdf-watermark-cleanup -n 50 --no-pager`
   -> no traceback, no `refusing to start` line.
Rollback: `sudo systemctl stop pdf-watermark-cleanup pdf-watermark-api pdf-watermark-wam`.

## E. Health checks
1. `curl -s http://127.0.0.1:8787/healthz` -> HTTP 200 (does not depend on WAM).
2. `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/readyz` -> `200` when WAM is up.
   If WAM is stopped: `503` with `{"status":"degraded","issuance":"unavailable"}`.
3. Confirm the API is bound to loopback or a private address only: `ss -ltnp | grep 8787`.
Rollback: stop the API; the cleanup runner is unaffected.

## F. Real WAM round trip
1. Run the real-WAM smoke check in the WAM venv against the VPS checkpoint:
   `cd /opt/pdf-watermark-service && /opt/pdf-watermark-wam/venv/bin/python scripts/wam_roundtrip_check.py`
   Expected: payload recovered, exit 0. (Not yet run on the VPS.)
2. Confirm the payload is recovered and PSNR is recorded (earlier local run: PSNR 27.90 dB).
Rollback: stop the WAM and API units; investigate before retry.

Residual risk: upstream WAM loads the checkpoint with `torch.load(weights_only=False)`. The checkpoint is
hash-pinned and the file is read-only to the API. The API process never loads it. See docs/OPERATIONS.md.

## G. Issuance and same-copy reuse
1. Submit one signed issuance request (signing helper: docs/OPERATIONS.md). Expected: HTTP 200 or 202
   while generating, then `status: ready` with `storage_key` and `expires_at = issued_at + 86400`.
2. Submit the identical request again. Expected: `reused: true`, same `id`, same `expires_at`.
3. `sqlite3 /var/lib/pdf-watermark/state.sqlite3 "select id,status,expires_at from issuances;"`
   -> one row, status `ready`.
Rollback: stop the API; the state DB keeps every row for audit. Do not delete rows.

## H. Expiry rejection and actual deletion
1. Using a test issuance with a short TTL (set only in a scratch env, never in production), wait past
   `expires_at`. Expected: a new request returns a new `id` and `reused: false`; the old copy is not served.
2. The cleanup unit runs every `PDF_SVC_CLEANUP_INTERVAL_SECONDS`. Wait one interval, then check the
   journal: `journalctl -u pdf-watermark-cleanup -n 50 --no-pager` shows `cleanup started` and no
   `cleanup pass failed` line. A manual second runner started while the unit holds the lock exits 3.
3. Confirm the physical file is gone: `ls /var/lib/pdf-watermark/storage/issued/` no longer lists the old key.
4. `sqlite3 ... "select id,status,storage_key from issuances where id='<old>';"` -> status `expired`, `storage_key` NULL.
Rollback: stop the cleanup unit; expired files are re-deleted by the next pass. No restore is needed.

## I. Restart and crash recovery
1. `sudo systemctl restart pdf-watermark-api` -> `active`; previously expired copies are still not served.
2. `sudo kill -9 $(systemctl show -p MainPID --value pdf-watermark-cleanup)` -> unit restarts after 30 s
   (`Restart=on-failure`); the lock is released; the new process starts with exit 0 on the next run.
3. Run `bash scripts/linux_verify.sh /opt/pdf-watermark-service/.venv/bin/python` (see Section J).
Rollback: stop the unit that misbehaves; do not remove the lock file manually while a process holds it.

## J. Linux multiprocess concurrency
1. `bash /opt/pdf-watermark-service/scripts/linux_verify.sh /opt/pdf-watermark-service/.venv/bin/python`
   Expected final line: `RESULT: all checks passed`, exit 0. Includes flock refusal, release after
   SIGKILL and SIGTERM, cleanup runner exit 3 on contention, and restart recovery.
2. `cd /opt/pdf-watermark-service && .venv/bin/python -m pytest tests/test_multiprocess.py tests/test_cleanup_runner.py -q`
   Expected: all pass.
Rollback: none; the script uses a scratch directory only.

## K. Logs, resource limits and disk usage
1. `journalctl -u pdf-watermark-api --since "1 hour ago" -p warning --no-pager` -> no secrets, no student
   identifiers, no tracebacks from normal traffic.
2. `systemctl show pdf-watermark-api -p MemoryMax -p TasksMax` -> set to values chosen for the VPS, or
   documented as unlimited with a reason.
3. `du -sh /var/lib/pdf-watermark/storage` and `df -h /var/lib` -> disk headroom recorded in
   docs/OPERATIONS.md capacity section.
4. Check journal size: `journalctl --disk-usage` -> within the host's log budget.
Rollback: revert any resource-limit drop-in with `systemctl revert <unit>`; restart the unit.

## L. Release switch and rollback ([OPERATOR] for switch/rollback, [PREPARE] for stage)
1. `bash scripts/deploy_release.sh stage /path/to/new/source` -> prints the new release name. Safe: changes no running service.
2. Keep the current release name (readlink of `/opt/pdf-watermark-service`) recorded before switching.
3. `sudo bash scripts/deploy_release.sh switch <release_name>` -> stops cleanup and API, swaps the symlink
   atomically, starts WAM, API and cleanup, then polls `/readyz`. Requires operator approval.
4. Rollback: `sudo bash scripts/deploy_release.sh rollback <previous_release_name>` (same mechanism).
5. Database migrations are NOT run by the release script. Any schema change requires its own approved step
   and a backup of `/var/lib/pdf-watermark/state.sqlite3` taken first (docs/OPERATIONS.md Section Backup).

## M. Known limitation to confirm with the product owner before go-live
Issued copies are raster-rebuilt. The selectable/searchable text layer of the source PDF is NOT preserved.
The vector-overlay alternative was tested and rejected: the watermark was not reliably recoverable after
compositing (docs/RELEASE_PLAN.md). Confirm this trade-off is accepted before enabling issuance.
