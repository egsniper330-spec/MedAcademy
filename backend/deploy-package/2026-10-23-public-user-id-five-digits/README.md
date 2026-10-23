# Deploy package — user IDs past MED-9999 (five-digit ceiling + random fallback)

**Created:** 2026-10-23
**Target:** `https://api.medacademy.site` (document root `backend/public`)
**Database changes:** **1 migration required** — `036_public_user_id_five_digits.sql`
**Production deployment performed by this package:** **none** — nothing was uploaded and no database was touched.

---

## 1. What changes and why

`profiles.public_user_id` (the `MED-…` id shown on profiles, watermarks, searches and
exports) was capped at four digits. When the sequence reached `MED-9999`, the trigger
`trg_on_auth_user_created` raised *"4-digit range MED-0001..MED-9999 is full"* and **every
new user creation failed**.

New behaviour:

| Range | Format | Notes |
|---|---|---|
| 1 … 9999 | `MED-0001` … `MED-9999` | unchanged, four-digit zero padding kept |
| 10000 … 99999 | `MED-10000` … `MED-99999` | five digits, no padding needed |
| > 99999 | random five-digit (`MED-48271`) | sequential range is exhausted; random fills only free values, bounded retries |
| none free | HTTP 503 / clear SQL error | never a duplicate, never a six-digit id, never a renumber of an existing user |

Only *new* ids are affected. No existing id is rewritten, no internal UUID or foreign key
is touched, and the column type (`VARCHAR(20)`) already fits `MED-99999`.

---

## 2. Layout (mirrors the server tree)

```
database/mysql-migrations/036_public_user_id_five_digits.sql → backend/database/mysql-migrations/  (run FIRST, via phpMyAdmin)
src/Services/PublicUserIdService.php   → backend/src/Services/       (NEW file — must be uploaded)
src/Services/AuthService.php           → backend/src/Services/
src/Controllers/AdminController.php    → backend/src/Controllers/
src/Controllers/StudentController.php  → backend/src/Controllers/
scripts/import-auth-users.php          → backend/scripts/            (only needed if you re-run an auth import)
```

Everything under `src/` is a drop-in replacement for the file at the same path.
`PublicUserIdService.php` is **new** — the other three files reference it, so upload it in
the same batch; a controller uploaded without it would fatal on `Class not found` at the
first user creation.

⚠ `AdminController.php` in this package also carries the bulk-user-ops hardening that was
prepared in the same working tree (per-user suspension checks, reset links, trash guards).
Uploading it ships BOTH changes. If you want the id change alone, diff it against the live
file and take only the `PublicUserIdService::allocate()` hunk in `userManagement()`;
`AdminController::bulkUserOps` is unrelated to user-id numbering.

---

## 3. Apply order (do not reorder)

1. **Back up** `profiles` (`public_user_id`, `id`) and `public_user_id_seq`
   (phpMyAdmin → Export → selected tables). The migration is non-destructive, but a
   backup is the only way to inspect the "before" state afterwards.
2. **Run migration 036** in phpMyAdmin (Import → `036_public_user_id_five_digits.sql`).
   It: syncs the sequence to the highest issued id (never lowers it), asserts the
   `uq_profiles_public_user_id` unique index, replaces the trigger, then prints three
   read-only verification result sets.
   * If the duplicate-report query (step 3 of the file) returns rows, **stop** and send
     them: the index is intentionally not created and no id was changed.
3. **Upload the five PHP files** listed in §2.
4. **Verify** with the queries in §4, then create one test user and check its id.

The order matters: the new PHP allocator *supplies* an id that the new trigger validates.
Running the code against the old trigger would still cap ids at `MED-9999`.

---

## 4. Verification (read-only)

```sql
-- 1. Shape of the existing namespace: expect six_digit_ids = 0 and
--    placeholder_ids = 0 (a pre-existing MED-0000 is data you should inspect).
SELECT COUNT(*)                                              AS total_profiles,
       SUM(public_user_id REGEXP '^MED-[0-9]{4,5}$')          AS canonical_ids,
       SUM(public_user_id REGEXP '^MED-[0-9]{6,}$')           AS six_digit_ids,
       SUM(public_user_id = 'MED-0000')                       AS placeholder_ids,
       MAX(CAST(SUBSTRING(public_user_id, 5) AS UNSIGNED))    AS highest_numeric_value
  FROM profiles;

-- 2. Sequence position: next id issued sequentially = last_issued_numeric + 1.
SELECT next_val AS last_issued_numeric, next_val + 1 AS next_sequential_attempt
  FROM public_user_id_seq WHERE id = 1;

-- 3. The trigger that is actually installed must mention 99999 and the random tail.
SHOW CREATE TRIGGER trg_on_auth_user_created;
```

Then create one user in the app (register, or Super Admin → Users → +). A query on
`profiles` must show a canonical id (`MED-####` or `MED-#####`) for the new row, and the
trigger body from §3 must be the active one.

If you have shell access and want to exercise the boundary without real users, run the
allocator's own test suite on the server (no database writes):

```
php backend/tests/public-user-id-generator.php      # 24 checks, exit 0
```

---

## 5. Rollback

Re-import the trigger section of `009_public_user_id.sql` (it restores the four-digit
ceiling) and re-upload the previous versions of the four PHP files. **Do not** delete or
renumber ids above `MED-9999` and do not drop the unique index — they are real users and
the index is a correctness guarantee, not part of this change.

---

## 6. Known limits of this change (verified vs. not)

* The allocator **policy** is executed by `backend/tests/public-user-id-generator.php`
  (24/24 checks: boundaries, `MED-9999 → MED-10000`, full 1..99999 run, random
  five-digit shape, collision retry, bounded exhaustion, simulated concurrent draws,
  lookup normalisation).
* The **SQL trigger** is asserted statically by `tests/publicUserIdFiveDigits.test.cjs`.
  It has **not** been executed against a live MySQL/MariaDB in this environment — run the
  §4 verification on staging before production.
* After `MED-99999` the random fallback can only reuse values freed by gaps (rolled-back
  creations, imports). Once those are gone, user creation fails with a clear error instead
  of issuing an out-of-contract id — that is intended.
