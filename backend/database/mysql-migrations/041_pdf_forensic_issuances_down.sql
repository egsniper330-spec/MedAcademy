-- Rollback for 041_pdf_forensic_issuances.sql
-- Drops ONLY the two tables that migration created. Nothing else is touched.
-- Data loss: forensic issuance mappings and inspection history are removed; the
-- personalised PDF files themselves are not affected (delete them with the app's
-- own cleanup if needed).

DROP TABLE IF EXISTS `pdf_forensic_checks`;
DROP TABLE IF EXISTS `pdf_forensic_issuances`;
