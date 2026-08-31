#!/usr/bin/env bash
# MedAcademy production deployment checklist for the PHP/MySQL backend.
#
# This script intentionally does not run remote commands or upload files. Deploy
# backend/ through the approved cPanel workflow, apply only the required MySQL
# migrations in phpMyAdmin, then run the local verification commands below.

set -euo pipefail

API_URL="${EXPO_PUBLIC_PHP_API_URL:-https://api.medacademy.eu.cc/backend/public/index.php}"

printf '%s\n' "MedAcademy PHP deployment target: $API_URL"
printf '%s\n' "1. Upload the changed backend/ files through cPanel's approved deployment workflow."
printf '%s\n' "2. Apply only backend/database/mysql-migrations/*.sql selected for this release."
printf '%s\n' "3. Run: php backend/scripts/validate-php-syntax.js"
printf '%s\n' "4. Run: php backend/scripts/regression-test.php"
printf '%s\n' "5. Verify the API health endpoint and the Preview application."
