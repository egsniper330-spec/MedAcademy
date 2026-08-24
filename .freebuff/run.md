# MedAcademy — Local Dev Server (run doc)

Expo SDK 55 / React Native 0.83 app. Web preview is served by Metro via `expo start`.

## 1. Reproduce the uncommitted artifacts

- `.env.local` — copy from the main checkout (or from `.env.local.template` and fill in
  `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY`). Never commit; gitignored.
- **`EXPO_PUBLIC_PHP_API_URL` is required.** The app has been migrated off Supabase:
  `src/client/php.ts` resolves the API base from `EXPO_PUBLIC_PHP_API_URL` first and falls
  back to `EXPO_PUBLIC_SUPABASE_URL + '/backend/public/index.php'` (wrong — points at
  supabase.co) if it's unset. Add it to `.env.local`, e.g.
  `EXPO_PUBLIC_PHP_API_URL=https://api.medacademy.eu.cc/backend/public/index.php`, or set
  it in the environment when launching the server (see below).
- `node_modules/` — install with the project's package manager (`npm install`, or `pnpm install`;
  the repo is set up for both). The `postinstall` script runs `patch-package` (applies
  `patches/expo-screen-capture+55.0.16.patch`) and the Android version sync.
- No other generated artifacts are required for the dev server. `metro-stubs/` is committed.

## 2. Run the server

```bash
EXPO_NO_TYPED_ROUTES=1 npm run start -- --localhost
# or
EXPO_NO_TYPED_ROUTES=1 pnpm start -- --localhost
```

`EXPO_NO_TYPED_ROUTES=1` disables the typed-routes file watcher: on Windows it crashes
Metro whenever a route file changes (`TypeError: The "to" argument must be of type string`
in `@expo/router-server/src/typed-routes`), killing the dev server mid-session. The env
var only affects the dev server — typed routes in app.json and production builds are untouched.

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

  Caveat for terminals that wait on the whole process tree (e.g. the Freebuff shell): the
  wrapper appears to "hang" (it waits on the npm child) and on timeout the tool terminates
  console-attached cmd/node children. To fully detach instead, use the included launcher
  (it sets the env vars and `cd`s into the project) spawned via WMI, which returns
  immediately and survives the shell:

  ```powershell
  powershell -NoProfile -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd /c D:\v3\.freebuff\start-preview.cmd' }"
  ```

  Then poll `http://localhost:8081/` until it returns `200` (Metro takes ~15–30s to boot).
- Confirm it is healthy: `curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/` → `200`.
