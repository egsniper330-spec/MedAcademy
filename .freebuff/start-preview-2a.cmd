@echo off
cd /d D:\v3
set EXPO_NO_TYPED_ROUTES=1
set EXPO_PUBLIC_PHP_API_URL=https://api.medacademy.eu.cc/backend/public/index.php
npm run start -- --localhost > D:\v3\.freebuff\preview-2a3624e0-ed33-41a5-8bbb-15fe77ae58e7.log 2> D:\v3\.freebuff\preview-2a3624e0-ed33-41a5-8bbb-15fe77ae58e7.log.err
