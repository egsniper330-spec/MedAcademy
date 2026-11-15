# 24-hour issuance invariants: verification status

"Executed" means a test in the service venv ran and passed on Windows in this audit. "Inspection" means
only code reading. Code locations are functions in `app/issuance.py` (I) and `app/cleanup.py` (C).
Tests: `tests/test_invariants_24h.py` (I1–I12, fake WAM model), `tests/test_cleanup.py`,
`tests/test_issuance.py`, `tests/test_orphans.py`.

| # | Invariant | Code | Executed test | Gap / note |
|---|-----------|------|---------------|------------|
| 1 | TTL starts at publication | `mark_ready` sets `expires_at = now + ttl` at publish | I1 (`expires_at == issued_at + TTL`) | Claim-time absence of expiry is by construction, not asserted |
| 2 | Reuse never extends expiry | `issue` reuse path returns row unchanged | I2 (reuse at 1100, 50000, 85000) | none |
| 3 | Expired file rejected before deletion | `_live` checks `expires_at`; `claim` retires to `expired` | I3 (exact-expiry reissue, file still on disk) | none |
| 4 | Originals/masters not under TTL | cleanup deletes only `storage_key` of issued rows | I4 (original and master exist after cleanup) | none |
| 5 | Mappings/events survive deletion | `_clear_storage_key` keeps row, adds `file_deleted` | I5 | none |
| 6 | Cleanup cannot delete newer file | per-attempt keys `issued/<id>-<token>.pdf`; delete uses row's `storage_key` | I6 | none |
| 7 | Concurrent cleanup cannot corrupt | `mark_expired` single transaction; second pass is no-op | I7 (two passes, one `file_deleted`) | Same-process, sequential. True concurrency: `tests/test_multiprocess.py` (executed on Windows) |
| 8 | Failed deletion retried safely | failed delete keeps `storage_key`; retried next pass | `test_cleanup.py` failed-deletion retry; I8 | none |
| 9 | Restart does not resurrect | state in SQLite; `_live` uses `expires_at` | I9 (reopen DB after expiry) | none |
| 10 | UTC timestamps | integer unix seconds from `_utc_now` / `utc_now` | I10 (integer and within 1 s of `time.time()`) | Checks the clock source, not every stored value |
| 11 | Interrupted publication recovered | temp file + `rename` then `mark_ready`; crash leaves non-ready row | I11 (no `ready` row after crash) | Orphan temp/issued files: `test_orphans.py` |
| 12 | Expired/corrupt copy never reused | `_stored_file_ok` (exists + SHA-256); `_retire_broken` → `failed` | I12 (corrupt copy not reused) | — |
| 12b | Retired corrupt file is deleted | **Fixed in this audit**: `_pending_files` includes `failed` rows with `storage_key`; `_clear_storage_key` accepts `failed` | I12b (failed before fix, passes after) | — |

Result after fixes: `tests/test_invariants_24h.py`, `test_cleanup.py`, `test_orphans.py`, `test_issuance.py`:
43 passed, 1 skipped. Full service suite: 119 passed, 1 skipped (WAM real-model test, needs WAM venv).

## Known remaining gaps
- Multi-process cleanup and identical-request behaviour are proven on Windows only (`msvcrt`). Linux `flock` is
  prepared in `scripts/linux_verify.sh`, not executed.
- Invariants 1, 3 and 9 use a fake model and a synthetic clock. Real-WAM publication is covered by
  `tests/test_wam_boundary.py` only when run in the WAM venv.
