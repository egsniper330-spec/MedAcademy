@echo off
rem MedAcademy preview launcher — launched detached via Win32_Process.Create.
cd /d D:\v3
set EXPO_NO_TYPED_ROUTES=1
set EXPO_PUBLIC_PHP_API_URL=https://api.medacademy.eu.cc/backend/public/index.php
npm run start -- --localhost > D:\v3\.freebuff\preview-35719fe8-7f74-435d-a697-1dac1d2db059.log 2> D:\v3\.freebuff\preview-35719fe8-7f74-435d-a697-1dac1d2db059.log.err
