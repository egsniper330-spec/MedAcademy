# App Versioning — iOS `buildNumber` / Android `versionCode`

How the version and build number of a MedAcademy build are decided, where they
are stored, which one the forced-update gate compares, and how to move them.

**Single source of truth: `app.json`.** EAS Build is configured with
`cli.appVersionSource: "local"`, so the values below are exactly the values that
end up in the binary.

---

## 1. The fields

| `app.json` | iOS (native) | Android (native) | Runtime source | Sent to the backend |
| --- | --- | --- | --- | --- |
| `expo.version` | `CFBundleShortVersionString` | `versionName` | `Application.nativeApplicationVersion` | display only |
| `expo.ios.buildNumber` | `CFBundleVersion` | — | `Application.nativeBuildVersion` | `X-App-Version-Code` |
| `expo.android.versionCode` | — | `versionCode` | `Application.nativeBuildVersion` | `X-App-Version-Code` |
| `X-App-Platform` | `ios` | `android` | `Platform.OS` | header |

Two separate numbers, deliberately **not** required to match:

- `expo.version` — the human-facing release name (`1.0.844`). Never compared.
- `expo.ios.buildNumber` / `expo.android.versionCode` — the integer the
  update gate compares. **Never compare version names.**

The runtime read lives in [src/lib/appIdentity.ts](../src/lib/appIdentity.ts)
(`expo-application` native metadata first, `Constants.expoConfig` only as a
fallback). The comparison is integer-only, in
[src/lib/securityStateModel.ts](../src/lib/securityStateModel.ts)
(`evaluateUpdateVerdict`) and in `AppUpdateService::evaluate` on the PHP side:
`installed < minimum → HTTP 426 / full-screen update`. Equal values never block.

How the values reach the native project:
[plugins/withDynamicVersions.js](../plugins/withDynamicVersions.js) writes
`CFBundleShortVersionString` / `CFBundleVersion` into `Info.plist` (and mirrors
them into the `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` build settings),
and `APP_VERSION_NAME` / `APP_VERSION_CODE` into `android/gradle.properties`.

> **Do not tokenise these values.** The plugin previously wrote
> `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)` into `Info.plist` while
> nothing ever set those build settings; they resolved to Xcode's defaults and
> every iOS build reported `1.0 (build 1)` regardless of `app.json`, which made
> the update gate block the app. See §6.

---

## 2. EAS configuration

```json
"cli": {
  "version": ">= 12.0.0",
  "appVersionSource": "local"
}
```

- `"local"` — EAS reads `expo.version`, `expo.ios.buildNumber` and
  `expo.android.versionCode` from `app.json`. What you commit is what is built.
- `"remote"` — EAS owns `ios.buildNumber` / `android.versionCode`; **the values
  in `app.json` are ignored for builds** (Expo's documented behaviour). Remote
  versioning is EAS CLI 12's default recommendation, so switching to it is easy
  to do by accident; that is why the setting is now explicit.

`autoIncrement` is intentionally **not** set on any profile. With
`appVersionSource: "local"` it increments the local build number and, on a cloud
build, that increment is never committed back to this repository — every build
from the same commit would then produce the *same* number, which the App Store
rejects as a duplicate. Bump the numbers explicitly (§3) instead.

---

## 3. Release procedure

1. Edit `app.json`:
   - `expo.version` — the release name (e.g. `1.0.845`);
   - `expo.ios.buildNumber` — integer, **must be higher than every build ever
     uploaded for this version**;
   - `expo.android.versionCode` — integer, **must be higher than every build
     ever uploaded** (it is globally unique for the package, not per version).
2. Commit the change. The committed value is what gets built; nothing rewrites
   it.
3. Verify the resolved native values before building:

   ```sh
   npx expo config --type introspect
   ```

   Expected (for the current config):

   ```
   version                               1.0.844
   ios.buildNumber                       221
   ios.infoPlist.CFBundleShortVersionString   1.0.844
   ios.infoPlist.CFBundleVersion              221
   ```

   Any `$(…)` token here, or a value that differs from `app.json`, is a bug —
   the binary will report that value at runtime.
4. Build (`eas build --profile production -p ios`). The plugin regenerates the
   native project during prebuild, so no manual edit in `ios/` is ever needed —
   and `ios/`/`android/` are generated, gitignored directories.
5. After the build is live, update Super Admin → **App Updates**: set the
   published `latestVersion` / `latestVersionCode` to the new build and raise
   `minimumVersionCode` only when older builds must be blocked.

> Editing JavaScript never changes the version of an already installed binary.
> The value is compiled into `Info.plist` / `AndroidManifest.xml`; a build that
> reports the wrong number stays wrong until it is replaced.

---

## 4. Reading and writing the EAS *remote* values

Only relevant when `appVersionSource` is `"remote"` (reference for a future
switch). Run from the project root (the directory containing `eas.json`).

```sh
# Show the build numbers stored on EAS servers
eas build:version:get -p ios
eas build:version:get -p android
eas build:version:get -p all --json

# Set (seed) the remote value — interactive, no --json
eas build:version:set -p ios
eas build:version:set -p android

# Copy the remote value into the native project
eas build:version:sync -p ios
```

`--profile` / `-e` selects the build profile (`production` is used when it
exists).

**Before switching to remote, seed it.** An unseeded remote value starts at `1`
or from the local config on the first build. Run `eas build:version:set` for
iOS and Android and enter the last build number already in the stores, then
verify with `eas build:version:get`; otherwise the first remote build can
collide with a build that is already published (and, historically, produced the
`build 1` identity described in §6).

**When switching back to local**, run `eas build:version:get` for both
platforms and copy those numbers into `app.json` (`ios.buildNumber`,
`android.versionCode`) so the next local build does not go backwards.

---

## 5. Checklist when an update is blocked (or not blocked) wrongly

1. `npx expo config --type introspect` — does `CFBundleVersion` /
   `CFBundleShortVersionString` match `app.json`?
2. What does the installed app report? Super Admin → App Updates, or the
   "Current version" row on the update screen. That string is the raw native
   value, so it is the ground truth for the installed binary.
3. `GET /app/version` with `X-App-Platform: ios` — returns
   `latestVersionCode` / `minimumVersionCode` for that platform.
4. Compare as integers: blocked only when `installed < minimum`. There is no
   version-name comparison anywhere in the client or server.
5. If the binary reports a number that is not in `app.json`, it was built from
   a different config (stale native project, or a remote-versioned EAS build) —
   rebuild from the current commit.

---

## 6. Background: the `1.0 (Build 1)` defect

`plugins/withDynamicVersions.js` used to replace both `Info.plist` values with
the Xcode tokens `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)` while
never setting those build settings, which stayed at Xcode's template defaults
(`1.0` / `1`). Every iOS build therefore reported `1.0 (build 1)` no matter what
`app.json` said, the client sent `X-App-Version-Code: 1`, and the version floor
(minimum `221`) blocked the app. Changing `ios.buildNumber` from `212` to `221`
had no effect because the value was overwritten in the same prebuild pass.

Fixed by writing the real values (and keeping the Xcode build settings in sync).
Guarded by `tests/appVersionIdentity.test.cjs`.

---

## 7. Related

- [PRODUCTION_SIGNING_SETUP.md](./PRODUCTION_SIGNING_SETUP.md) — signing & build
  credentials.
- [build-troubleshooting.md](./build-troubleshooting.md) — native build failures.
- [ANDROID_BUILD_WINDOWS.md](./ANDROID_BUILD_WINDOWS.md) — local Android builds.
