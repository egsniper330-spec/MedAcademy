-- ===========================================================================
-- MIGRATION 024 — Platform Control Center: real CMS content + flag overrides
--
-- PART 1 — CMS CURRENT-CONTENT MIGRATION
-- Seeds the REAL text users already see in the app (VERBATIM from the bundled
-- fallback sections in src/app/(app)/info/terms.tsx (9 sections), privacy.tsx
-- (9 sections), about.tsx and contact.tsx) as PUBLISHED server-managed
-- content, using the CMS controlled format: "## Heading" lines + paragraphs.
-- Parsing a seeded body therefore yields EXACTLY the sections the built-in
-- screens render (tests/platformCenter.test.cjs pins this round-trip).
--
-- Client contract (unchanged): an EMPTY body means "render built-in text"; a
-- NON-empty body means "render this". The editor opens showing exactly what
-- users see today, and any future edit is live for every user.
--
-- Safety contract (idempotent, data-preserving):
--   * INSERT IGNORE — if a row already exists (e.g. from migration 022), the
--     insert is skipped, never an error, never a duplicate.
--   * The guarded UPDATE fills the real content ONLY into an EMPTY body —
--     admin-edited (non-empty) content is NEVER overwritten. Running the
--     migration twice changes nothing.
--
-- PART 2 — feature_flag_overrides (new table)
-- Per-user three-state feature overrides (inherit/enabled/disabled), mirroring
-- the video-provider override model. No existing table is modified.
-- ===========================================================================

-- ── PART 1: migrate current in-app content ─────────────────────────────────

-- 1a. Guarantee the rows exist (no-op when migration 022 already made them).
INSERT IGNORE INTO `app_pages` (`id`, `key`, `title`, `content`, `published`, `updated_at`)
VALUES
    ('00000000-0000-0000-0000-200000000001', 'terms_conditions', 'Terms & Conditions', '', 1, UTC_TIMESTAMP(6)),
    ('00000000-0000-0000-0000-200000000002', 'privacy_policy',   'Privacy Policy',     '', 1, UTC_TIMESTAMP(6)),
    ('00000000-0000-0000-0000-200000000003', 'about_us',         'About Us',           '', 1, UTC_TIMESTAMP(6)),
    ('00000000-0000-0000-0000-200000000004', 'contact_us',       'Contact Us',         '', 1, UTC_TIMESTAMP(6));

-- 1b. Fill the CURRENT in-app text into empty bodies only.
-- Terms & Conditions — verbatim from terms.tsx SECTIONS (all 9 sections).
UPDATE `app_pages` SET
  `content`    = '## 1. Acceptance of Terms\nBy accessing or using MedAcademy, you agree to be bound by these Terms & Conditions. If you do not agree to these terms, please do not use our platform.\n\n## 2. Account Responsibilities\nYou are responsible for maintaining the confidentiality of your account credentials. Your account may only be used on one authorized device at a time. Sharing accounts or credentials is strictly prohibited and may result in suspension.\n\n## 3. Content Usage\nAll course content — including videos, PDFs, and materials — is protected by copyright and may not be recorded, distributed, or reproduced in any form. Forensic watermarks are embedded in all streamed content to identify unauthorized sharing.\n\n## 4. Subscriptions & Access\nCourse access is granted through enrollment by a Doctor or platform administrator. Access is personal and non-transferable. Completed or expired subscriptions do not entitle the user to a refund unless explicitly stated.\n\n## 5. Prohibited Conduct\nYou agree not to attempt to circumvent security measures, use screen-recording software during content playback, or exploit technical vulnerabilities. Violations may result in immediate account termination.\n\n## 6. Intellectual Property\nAll content, trademarks, and branding on MedAcademy are the exclusive property of the platform and its instructors. Unauthorized use constitutes an infringement of intellectual property rights.\n\n## 7. Disclaimer of Warranties\nThe platform is provided \"as-is\" without warranties of any kind. We do not guarantee uninterrupted access, and we are not liable for content accuracy beyond our reasonable editorial standards.\n\n## 8. Amendments\nWe reserve the right to update these Terms at any time. Continued use of the platform after changes are posted constitutes acceptance of the updated Terms.\n\n## 9. Governing Law\nThese Terms are governed by applicable laws. Any disputes shall be resolved through negotiation, and if necessary, through the competent courts.',
  `updated_at` = UTC_TIMESTAMP(6)
WHERE `key` = 'terms_conditions' AND TRIM(`content`) = '';

-- Privacy Policy — verbatim from privacy.tsx SECTIONS (all 9 sections).
UPDATE `app_pages` SET
  `content`    = '## 1. Information We Collect\nWe collect information you provide when registering (name, email, phone), academic information (university, faculty, level), and device information for security enforcement. We also collect content-interaction data such as watch progress and lesson completion.\n\n## 2. How We Use Your Information\nYour information is used to provide and personalize the learning experience, enforce single-device policies, embed forensic watermarks in streamed content, communicate important account updates, and improve our platform.\n\n## 3. Forensic Watermarking\nA unique Watermark ID is assigned to your account and invisibly embedded in all video content you view. This allows us to identify the source of any unauthorized recordings or distributions. This process is transparent and required for platform integrity.\n\n## 4. Device Data\nWe collect your device installation ID, model, and OS version to enforce our single-device login policy. No microphone, camera, or location data is ever collected without explicit user permission.\n\n## 5. Data Sharing\nWe do not sell or rent your personal data to third parties. We may share data with instructors to the extent required to administer your enrollment. Service providers acting on our behalf are contractually bound to protect your data.\n\n## 6. Data Retention\nAccount data is retained while your account is active and for a reasonable period afterward for audit and legal compliance purposes. You may request deletion of your account by contacting our support team.\n\n## 7. Security\nWe use industry-standard encryption, secure authentication, and access controls to protect your data. Password changes invalidate all prior sessions immediately.\n\n## 8. Your Rights\nYou have the right to access, correct, or request deletion of your personal data. To exercise these rights, please contact us through the Contact Us page.\n\n## 9. Changes to This Policy\nWe may update this Privacy Policy periodically. We will notify you of significant changes through the app. Continued use after notification constitutes acceptance.',
  `updated_at` = UTC_TIMESTAMP(6)
WHERE `key` = 'privacy_policy' AND TRIM(`content`) = '';

-- About Us — mission + pillar copy from about.tsx in plain CMS format.
UPDATE `app_pages` SET
  `content`    = 'MedAcademy was built to bridge the gap between medical theory and real-world clinical practice. We partner with leading doctors and specialists to deliver structured, high-quality, mobile-first courses that fit the demanding schedule of medical students.\n\n## Expert-Led Content\nCourses crafted by verified medical professionals with real clinical experience.\n\n## Secure Learning\nForensic watermarking and device enforcement protect every student and instructor.\n\n## Clinical Focus\nCurated for medical students — from anatomy to clinical rotations and beyond.\n\n## Always Accessible\nMobile-first design so you can study anywhere — on the ward, at home, or on the go.',
  `updated_at` = UTC_TIMESTAMP(6)
WHERE `key` = 'about_us' AND TRIM(`content`) = '';

-- Contact Us — the real screen intro; channels are Branding-managed.
UPDATE `app_pages` SET
  `content`    = 'Need help? Choose one of the contact methods below and we''ll be happy to assist you.\n\nThe contact channels shown on this screen (support email, phone, WhatsApp, Telegram, website) are managed in Platform → Branding.',
  `updated_at` = UTC_TIMESTAMP(6)
WHERE `key` = 'contact_us' AND TRIM(`content`) = '';

-- ── PART 2: per-user feature flag overrides ─────────────────────────────────

CREATE TABLE IF NOT EXISTS `feature_flag_overrides` (
  `id` CHAR(36) DEFAULT (UUID()) COMMENT 'pg_default: gen_random_uuid()',
  `flag_key` VARCHAR(191) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `is_enabled` TINYINT(1) DEFAULT 1 NOT NULL COMMENT 'pg_default: true',
  `created_by` CHAR(36) NULL,
  `created_at` DATETIME(6) DEFAULT CURRENT_TIMESTAMP NOT NULL COMMENT 'pg_default: now()',
  `updated_at` DATETIME(6) DEFAULT CURRENT_TIMESTAMP NOT NULL COMMENT 'pg_default: now()',
  PRIMARY KEY (`id`),
  CONSTRAINT `uq_feature_flag_overrides_flag_user` UNIQUE (`flag_key`, `user_id`),
  CONSTRAINT `fk_feature_flag_overrides_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_feature_flag_overrides_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `idx_feature_flag_overrides_user`
  ON `feature_flag_overrides` (`user_id`);
