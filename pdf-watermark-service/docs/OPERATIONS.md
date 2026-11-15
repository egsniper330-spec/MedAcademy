# PDF watermark issuance service: operations

Status: local implementation only. Nothing here has been run on a Linux host or the VPS.
Example values (paths, users, ports, keys) are placeholders. Replace them on the VPS.

## 1. Process architecture

Three separately supervised processes share one SQLite state database and one private storage root.

| Process | Entrypoint | Role | Needs WAM? |
|---|---|---|---|
| API | `python -m app.server` (service venv) | HTTP API, HMAC-signed, loopback or private bind | No. `/readyz` reports issuance unavailable instead |
| WAM runtime | `python -m app.wam_runtime` (WAM venv) | Loads the checkpoint once; serves `/embed` on loopback only | n/a |
| Cleanup runner | `python -m app.cleanup_runner` (service venv) | Expires PDFs and removes orphan temp files every `PDF_SVC_CLEANUP_INTERVAL_SECONDS` | No |

- Only one cleanup runner may run. It takes `cleanup.lock` next to the state DB and exits 3 if the lock is held.
- The API may run as several uvicorn processes. Cleanup does not run inside the API, so API workers never start duplicate cleanup loops.
- Systemd templates: `deploy/systemd/pdf-watermark-{api,wam,cleanup}.service`. Each starts independently and restarts on failure.

## 2. Start and stop

Example (systemd, names from the templates):

    systemctl start pdf-watermark-wam pdf-watermark-api pdf-watermark-cleanup
    systemctl stop pdf-watermark-cleanup pdf-watermark-api pdf-watermark-wam

Stop signals are SIGTERM. The API finishes in-flight requests. Cleanup finishes its current pass. WAM stops after in-flight requests.

Manual run (development only):

    python -m app.cleanup_runner        # exit 0 on clean stop, 2 bad config, 3 lock held
    python -m app.wam_runtime           # WAM venv; needs PDF_SVC_WAM_HMAC_KEY
    python -m app.server                # uses PDF_SVC_BIND_HOST / PDF_SVC_BIND_PORT

## 3. Environment variables

Separate templates: `deploy/env/api.env.example` (API and cleanup) and `deploy/env/wam.env.example` (WAM). Copy to `/etc/pdf-watermark/api.env` and `wam.env`; replace every `CHANGE-ME` value. Never commit real values. Notable keys:

- `PDF_SVC_HMAC_KEYS`: API HMAC keys, `id:secret[,id:secret]`. Secret must be at least 32 characters.
- `PDF_SVC_WAM_HMAC_KEY`: API-to-WAM HMAC key, `id:secret`. Separate from the API keys.
- `PDF_SVC_WAM_RUNTIME_URL`, `PDF_SVC_WAM_HOST`, `PDF_SVC_WAM_PORT`: WAM address. Host must be loopback.
- `PDF_SVC_WAM_CHECKPOINT`, `PDF_SVC_WAM_PARAMS_JSON`, `PDF_SVC_WAM_REPO_DIR`: fixed paths; the checkpoint SHA-256 is verified before load.
- `PDF_SVC_WAM_STATE_DIR`: WAM nonce store (`nonces.sqlite3`). Private, not web-served.
- `PDF_SVC_ISSUANCE_TTL_SECONDS` (86400), `PDF_SVC_ISSUANCE_LEASE_SECONDS` (900): 24-hour copy lifetime and generation lease.
- `PDF_SVC_ISSUANCE_WAIT_SECONDS` (10, 0-60): how long an identical request waits before HTTP 202 pending.
- `PDF_SVC_CLEANUP_INTERVAL_SECONDS` (300, 60-900): cleanup pass interval.
- `PDF_SVC_STORAGE_ROOT`, `PDF_SVC_STATE_DB_PATH`: must be outside any web root.
- `PDF_SVC_BIND_HOST` (default 127.0.0.1), `PDF_SVC_BIND_PORT` (default 8787).

## 4. Directory layout and permissions (example)

    /opt/pdf-watermark-service      code, root-owned, read-only to services
    /opt/pdf-watermark-wam          WAM venv (requirements-wam.txt), root-owned, read-only to pdfwam
    /opt/pdf-watermark-service/wam  WAM repo and checkpoints/wam_mit.pth (path used by wam.env.example)
    /etc/pdf-watermark/api.env      mode 0640, root:pdfsvc
    /etc/pdf-watermark/wam.env      mode 0640, root:pdfwam
    /var/lib/pdf-watermark/         mode 0750, owner pdfsvc
    /var/lib/pdf-watermark/storage  per-attempt PDFs (tmp/issuance, issued)
    /var/lib/pdf-watermark/state.sqlite3
    /var/lib/pdf-watermark/wam-state  owner pdfwam

No path in this tree may be inside the public web root. Env files must never be placed there.

## 5. WAM virtualenv and pinned dependencies

Use a separate virtualenv for WAM (torch, CPU build) with `requirements-wam.txt`. The API venv uses `requirements.txt` and must not contain torch. Pinned versions verified in the test environment: torch 2.2.2+cpu, torchvision 0.17.2+cpu, numpy 1.26.4 (the API uses numpy 2.5.4, so the two runtimes must stay separate). Do not install TrustMark. Load only `wam_mit.pth`, never `wam_coco.pth`.

**Residual risk:** the upstream WAM loader calls `torch.load(weights_only=False)`. This is accepted only because the checkpoint is pinned by SHA-256 before load, the file is read-only to the API, and the API never loads the model. Replacing it would change the approved checkpoint's verification and is not done.

## 6. Checkpoint installation and SHA-256

The approved checkpoint SHA-256 is `90ef232384e023bd63245eb0c131abd69d2afc7b8f17a71ccedceb542bf009e2`.

    bash scripts/install_checkpoint_verify.sh /opt/pdf-watermark-service/wam/checkpoints/wam_mit.pth

The value must match before the service starts. `app.wam_runtime` refuses to serve on mismatch. The script is read-only.

## 7. SQLite migration

The schema is created and migrated by `app.db.StateDB` on startup. Before any upgrade, stop all three services, then copy the database file with its `-wal` and `-shm` files. Then start the new code once and confirm `/readyz` and a test issuance.

## 8. Backup and recovery

- Back up `state.sqlite3` (use the SQLite backup command or stop services first), the storage root, and `wam-state/nonces.sqlite3`.
- The database holds the forensic mapping and must be kept. Expired PDF files may be deleted; their rows and mappings are never deleted.
- Restoring an older database can re-issue payloads already seen. Do not restore over a live database without a plan for payload uniqueness.

## 9. Logs and rotation

All three services log to journald (`journalctl -u pdf-watermark-api`). Configure journald retention on the VPS. Logs must not contain student PII or payloads.

## 10. Health and readiness

- `GET /healthz`: liveness. Does not depend on WAM.
- `GET /readyz`: issuance readiness. Returns 200 `{"status":"ready","issuance":"available"}` when WAM answers, or 503 `{"status":"degraded","issuance":"unavailable"}`.
- WAM health: `GET http://127.0.0.1:8711/healthz` (unauthenticated, loopback only).

## 11. Failure recovery

- WAM down: API stays up. Issuance requests fail with a generation error until WAM returns. The API reconnects on the next request.
- API crash mid-generation: the lease expires after `PDF_SVC_ISSUANCE_LEASE_SECONDS`. The next request reclaims the record with a new token. Orphan temp files are removed by cleanup after `ORPHAN_MIN_AGE_SECONDS` (3600).
- Cleanup crash: systemd restarts it after 30 seconds. A failed deletion keeps its `storage_key` and is retried on the next pass.

## 12. Firewall and loopback

- WAM binds to loopback only. Do not open its port.
- The API binds to loopback or a private interface. Allow inbound only from the PHP server (example: `ufw allow from <PHP_SERVER_IP> to any port 8787 proto tcp`). Replace the IP.
- Loopback alone is not authentication. Every API and WAM request is HMAC-signed and replay-checked.

## 13. Storage capacity

Each personalised PDF is a full copy. Size the storage root for `issuances per day x average PDF size x (TTL in days + 1)`, plus temp headroom. Monitor free space; cleanup is the only expiry mechanism.

## 14. Safe upgrade and rollback

1. Back up the database, storage, and nonce store.
2. Stage the new code: `bash scripts/deploy_release.sh stage <src>` (no service change).
3. Switch: `sudo bash scripts/deploy_release.sh switch <release>`. It stops cleanup and API, swaps the symlink, starts WAM, API and cleanup, then checks `/readyz`. [OPERATOR approval]
4. Schema changes are NOT applied by the release script. Any migration is a separate approved step taken after the database backup.
5. Rollback: `sudo bash scripts/deploy_release.sh rollback <previous_release>`. Restore the database backup only if a schema change was applied, and never over a live database without a payload-uniqueness plan.

## 15. Command safety classes

- **[PREPARE]** safe: builds files and venvs, verifies hashes, reads state (`scripts/install_vps.sh prepare|storage|venvs`, `scripts/install_checkpoint_verify.sh`, `scripts/deploy_release.sh stage`).
- **[OPERATOR]** needs VPS operator approval: creates users, installs units, restarts services (`install_vps.sh users|units`, `deploy_release.sh switch|rollback`).
- **[DATA]** modifies or migrates production data and is never run by a script: database migration, database restore, deleting storage, changing issuance rows.

## 16. Known product limitation

The issued PDF is a raster rebuild. Its selectable and searchable text layer is not preserved. The vector overlay was tested and was not reliably recoverable after compositing, so it is not shipped. Confirm this is acceptable before enabling issuance.

The watermark is a forensic marker for later detection. Do not describe it as resistant to removal, screenshot, or print-and-scan unless that has been measured.

## 17. Not verified on Linux or the VPS

The systemd units, the Linux `flock` path in `cleanup_runner`, the multi-process tests, the real-WAM round trip on the VPS checkpoint, and the 24-hour expiry under real time have NOT been run on a Linux host. `scripts/linux_verify.sh` and `docs/VPS_CHECKLIST.md` define the verification to perform.
