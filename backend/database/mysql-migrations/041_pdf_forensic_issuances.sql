-- ============================================================================
-- 041_pdf_forensic_issuances.sql
--
-- Server-side record of every personalised PDF issued by the PDF forensic
-- service (WAM watermark), plus the opaque payload -> person mapping the PDF
-- Checker needs.
--
-- WHY A NEW TABLE
--   lesson_material_pdfs caches a resulting file per (material, student,
--   variant) and is bounded by that unique key. A forensic issuance is a
--   separate fact: it carries an opaque 32-bit payload, the exact source
--   version, the course the document was opened through, and an absolute
--   24-hour expiry that must survive even after the FILE is deleted.
--   Deleting the personalised PDF must NOT delete this row: without it a
--   detected payload could never be attributed again.
--
-- PRIVACY
--   The payload is a random 32-bit integer chosen by the service and is
--   useless without this table. No name, e-mail or public user id is encoded
--   in the watermark itself.
--
-- SAFETY
--   Additive only: two new tables, no existing row or column is touched.
--   Re-runnable (IF NOT EXISTS).
--
-- ROLLBACK
--   041_pdf_forensic_issuances_down.sql drops both tables.
-- ============================================================================

CREATE TABLE IF NOT EXISTS `pdf_forensic_issuances` (
  `id`                 CHAR(36)      NOT NULL,
  -- Service-side opaque record id (wm_...). Unique: one row per generated copy.
  `service_issuance_id` VARCHAR(80)  NOT NULL,
  -- Random 32-bit WAM payload. NULL only for a row created before generation completed.
  `payload`            BIGINT UNSIGNED NULL,
  `student_id`         CHAR(36)      NOT NULL,
  `doctor_id`          CHAR(36)      NULL,
  `material_id`        CHAR(36)      NOT NULL,
  `version_id`         VARCHAR(80)   NOT NULL,
  `course_id`          CHAR(36)      NOT NULL,
  `source_sha256`      CHAR(64)      NOT NULL,
  `algorithm`          VARCHAR(32)   NOT NULL DEFAULT 'wam_mit',
  `config_version`     VARCHAR(64)   NOT NULL DEFAULT '',
  -- Private path of the personalised copy on this host; NULL once cleanup ran.
  `storage_path`       TEXT          NULL,
  `file_sha256`        CHAR(64)      NULL,
  `status`             VARCHAR(16)   NOT NULL DEFAULT 'ready',
  `issued_at`          DATETIME(6)   NOT NULL,
  -- Absolute expiry set at publication. Reads never extend it.
  `expires_at`         DATETIME(6)   NOT NULL,
  `purged_at`          DATETIME(6)   NULL,
  `download_count`     INT UNSIGNED  NOT NULL DEFAULT 0,
  `last_download_at`   DATETIME(6)   NULL,
  `created_at`         DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`         DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pdf_forensic_service_id` (`service_issuance_id`),
  -- One live row per (student, material version, course): the reuse contract.
  UNIQUE KEY `uq_pdf_forensic_cache` (`student_id`, `material_id`, `version_id`, `course_id`),
  UNIQUE KEY `uq_pdf_forensic_payload` (`payload`),
  KEY `idx_pdf_forensic_student` (`student_id`, `expires_at`),
  KEY `idx_pdf_forensic_material` (`material_id`, `expires_at`),
  KEY `idx_pdf_forensic_expiry` (`status`, `expires_at`),
  CONSTRAINT `fk_pdf_forensic_student` FOREIGN KEY (`student_id`) REFERENCES `profiles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pdf_forensic_material` FOREIGN KEY (`material_id`) REFERENCES `lesson_materials` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every forensic inspection (PDF Checker) run. Written for ALL roles, so an
-- inspection can never happen without a trace.
CREATE TABLE IF NOT EXISTS `pdf_forensic_checks` (
  `id`             CHAR(36)     NOT NULL,
  `actor_id`       CHAR(36)     NOT NULL,
  `actor_role`     VARCHAR(16)  NOT NULL,
  `material_id`    CHAR(36)     NULL,
  `scope_course_id` CHAR(36)    NULL,
  `file_sha256`    CHAR(64)     NOT NULL,
  `verdict`        VARCHAR(16)  NOT NULL,
  `payload`        BIGINT UNSIGNED NULL,
  `score`          DECIMAL(6,4) NULL,
  `agreement`      DECIMAL(6,4) NULL,
  `pages_analyzed` INT UNSIGNED  NOT NULL DEFAULT 0,
  `matched_issuance_id` CHAR(36) NULL,
  `notes`          VARCHAR(191) NULL,
  `created_at`     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `idx_pdf_forensic_checks_actor` (`actor_id`, `created_at`),
  KEY `idx_pdf_forensic_checks_payload` (`payload`),
  KEY `idx_pdf_forensic_checks_verdict` (`verdict`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
