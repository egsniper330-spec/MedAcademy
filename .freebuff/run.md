# MedAcademy — Local Dev Server (run doc)

Expo SDK 55 / React Native 0.83 app. Web preview is served by Metro via `expo start`.

## 1. Reproduce the uncommitted artifacts

- `.env.local` — copy from the main checkout (or from `.env.local.template` and fill in
  `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY`). Never commit; gitignored.
- `node_modules/` — install with the project's package manager (`npm install`, or `pnpm install`;
  the repo is set up for both). The `postinstall` script runs `patch-package` (applies
  `patches/expo-screen-capture+55.0.16.patch`) and the Android version sync.
- No other generated artifacts are required for the dev server. `metro-stubs/` is committed.

## 2. Run the server

```bash
npm run start -- --localhost
# or
pnpm start -- --localhost
```

Metro binds to port **8081** by default (`--localhost` keeps it loopback-only, which is
required for the Freebuff preview). The web app is served at http://localhost:8081/ — no
separate web process; the bundle is compiled on demand.

Notes:

- Do **not** pass `-w/--web` — that flag opens a browser window; the web bundle is served
  on the same port regardless.
- On Windows, start it detached so it outlives the shell, e.g.:

  ```powershell
  powershell -NoProfile -Command "(Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','start','--','--localhost' -WorkingDirectory 'D:\v3' -RedirectStandardOutput '<log>' -RedirectStandardError '<log>.err' -WindowStyle Hidden -PassThru).Id"
  ```

  stdout and stderr must go to DIFFERENT files.
- Confirm it is healthy: `curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/` → `200`.
