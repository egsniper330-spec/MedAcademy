/**
 * plugins/withPrivacyPermissions.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Minimum-privilege permission hardening for Android.
 *
 * Problem
 * ───────
 * Expo SDK libraries inject permissions through their own AAR
 * AndroidManifests and config plugins. The merged app manifest therefore
 * contained permissions the app never uses:
 *
 *   CAMERA                 — expo-file-system's AAR (legacy pick/crop flows)
 *   RECORD_AUDIO           — expo-video's AAR (recording capability; app only plays)
 *   MODIFY_AUDIO_SETTINGS  — expo-audio's AAR
 *   USE_BIOMETRIC          — androidx.biometric 1.1.0 (pulled by expo-image-picker's
 *                            android-image-cropper chain; app has no biometric UI)
 *   USE_FINGERPRINT        — same chain
 *   READ_MEDIA_IMAGES/VIDEO/AUDIO — expo-media-library config plugin defaults
 *   ACCESS_MEDIA_LOCATION  — expo-media-library plugin (isAccessMediaLocationEnabled)
 *   launcher-badge permission zoo — me.leolin:ShortcutBadger + firebase-messaging
 *                            installreferrer chain (Samsung/HTC/Huawei/Oppo/Sony/
 *                            Xiaomi/EverythingMe badge providers)
 *   DOWNLOAD_WITHOUT_NOTIFICATION — vdocipher-rn-bridge AAR (DownloadManager usage
 *                            the app never exercises)
 *
 * Fix strategy
 * ────────────
 * Manifest merger directives (`tools:node="remove"`) emitted into the app's
 * own AndroidManifest during prebuild. The manifest merger processes these
 * AFTER every library manifest, so each named permission is stripped from the
 * FINAL merged manifest — including permissions added by library AARs that
 * app.json cannot influence directly.
 *
 *   • tools:node="remove"  → permission must not exist in the final APK.
 *   • tools:node="replace" → keep the permission but narrow it (used to cap
 *     legacy external-storage permissions at Android ≤ 12 and to ensure the
 *     limited-photos fallback exists on Android 13+).
 *
 * This plugin is source-controlled config — it survives `expo prebuild --clean`.
 * Nothing here weakens security features: VPN/root/debugger/ADB detection and
 * Play Integrity use NO manifest permissions (they read system state directly),
 * and the upload foreground service keeps FOREGROUND_SERVICE(_DATA_SYNC) +
 * POST_NOTIFICATIONS + WAKE_LOCK (added by withNativeUpload.js, which runs
 * separately — this plugin never touches those).
 *
 * Runtime UX contract (verified against src/lib/permissions.ts and its callers):
 *   • Startup / login → NO permission prompts. Notification permission is
 *     requested once per install, after first successful login
 *     (useNotificationPermission in the four dashboard screens).
 *   • Picking existing photos (profile / course images) → media permission is
 *     requested at that exact moment via usePermission('mediaLibrary') —
 *     never at startup.
 *   • Document/video picking (lesson uploads) → expo-document-picker uses the
 *     system document picker (SAF): no storage permission is required.
 *   • Downloading lesson materials → MediaLibrary save permission requested
 *     at download time (lesson/[id].tsx), with share-sheet fallback.
 */

const {
  withAndroidManifest,
  createRunOncePlugin,
} = require('@expo/config-plugins');

const pkg = require('../package.json');

/**
 * Permissions that must NOT exist in the final APK.
 * Order doesn't matter; see class doc for the origin of each.
 */
const REMOVED_PERMISSIONS = [
  // Camera / microphone capabilities the app never exercises
  'android.permission.CAMERA',
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',

  // Biometric hardware the app never calls
  'android.permission.USE_BIOMETRIC',
  'android.permission.USE_FINGERPRINT',

  // Broad media-library access — replaced by runtime-granted Photo Picker /
  // system-document-picker flows. READ_MEDIA_VISUAL_USER_SELECTED is KEPT
  // (see below) so the Android 13/14 "select photos" flow stays available.
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.ACCESS_MEDIA_LOCATION',

  // DownloadManager usage the app never exercises (vdocipher AAR)
  'android.permission.DOWNLOAD_WITHOUT_NOTIFICATION',

  // expo-video playback service — expo-video is installed but never imported
  // by the app (video playback is WebView/Plyr + native VdoCipher SDK), so
  // its media-playback foreground-service type is dead weight.
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',

  // Launcher-badge providers (ShortcutBadger / firebase installreferrer chain)
  'com.anddoes.launcher.permission.UPDATE_COUNT',
  'com.htc.launcher.permission.READ_SETTINGS',
  'com.htc.launcher.permission.UPDATE_SHORTCUT',
  'com.huawei.android.launcher.permission.CHANGE_BADGE',
  'com.huawei.android.launcher.permission.READ_SETTINGS',
  'com.huawei.android.launcher.permission.WRITE_SETTINGS',
  'com.majeur.launcher.permission.UPDATE_BADGE',
  'com.oppo.launcher.permission.READ_SETTINGS',
  'com.oppo.launcher.permission.WRITE_SETTINGS',
  'com.sec.android.provider.badge.permission.READ',
  'com.sec.android.provider.badge.permission.WRITE',
  'com.sonyericsson.home.permission.BROADCAST_BADGE',
  'com.sonymobile.home.permission.PROVIDER_INSERT_BADGE',
  'me.everything.badger.permission.BADGE_COUNT_READ',
  'me.everything.badger.permission.BADGE_COUNT_WRITE',
  'android.permission.READ_APP_BADGE',
];

/**
 * Permissions to keep, narrowed/ensured by attributes.
 *  - Legacy storage is capped at Android ≤ 12 (API ≤ 32) — Android 13+ never
 *    sees it; the system document picker covers all file access on 13+.
 *  - READ_MEDIA_VISUAL_USER_SELECTED is explicitly (re-)written so the
 *    Android 14+ "limit access" dialog flow works even though the broad
 *    granular permissions are removed.
 */
const NARROWED_PERMISSIONS = [
  { name: 'android.permission.READ_EXTERNAL_STORAGE', maxSdkVersion: '32' },
  { name: 'android.permission.WRITE_EXTERNAL_STORAGE', maxSdkVersion: '32' },
  { name: 'android.permission.READ_MEDIA_VISUAL_USER_SELECTED' },
];

function withPrivacyPermissions(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    if (!manifest['uses-permission']) manifest['uses-permission'] = [];
    if (!manifest['uses-permission-sdk-23']) manifest['uses-permission-sdk-23'] = [];

    const perms = manifest['uses-permission'];

    const findPerm = (name) =>
      perms.find((p) => p.$ && p.$['android:name'] === name);

    // 1. Ensure narrowed versions exist with exactly the attributes we want.
    //    (replace semantics: attributes are set on the node we own)
    for (const narrow of NARROWED_PERMISSIONS) {
      let perm = findPerm(narrow.name);
      if (!perm) {
        perm = { $: {} };
        perms.push(perm);
      }
      perm.$['android:name'] = narrow.name;
      if (narrow.maxSdkVersion) {
        perm.$['android:maxSdkVersion'] = narrow.maxSdkVersion;
      } else {
        delete perm.$['android:maxSdkVersion'];
      }
    }

    // 2. Emit removal directives for every forbidden permission.
    //    Plugin order matters: earlier plugins (e.g. expo-media-library) may
    //    already have added these nodes to the app manifest, so first delete
    //    any existing node, then push an explicit tools:node="remove" entry —
    //    the manifest merger applies it AFTER all library manifests, killing
    //    the permission even when a library AAR adds it during merge.
    for (const name of REMOVED_PERMISSIONS) {
      const idx = perms.findIndex((p) => p.$ && p.$['android:name'] === name);
      if (idx !== -1) perms.splice(idx, 1);
      perms.push({
        $: {
          'android:name': name,
          'tools:node': 'remove',
        },
      });
    }

    // 3. requestLegacyExternalStorage (set by expo-media-library's plugin)
    //    is intentionally kept: Android ≤ 12 still needs it for the
    //    MediaLibrary download-save flow; Android 13+ ignores it.

    return cfg;
  });
}

module.exports = createRunOncePlugin(
  withPrivacyPermissions,
  'withPrivacyPermissions',
  '1.0.0',
);
