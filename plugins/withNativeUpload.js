/**
 * withNativeUpload.js
 *
 * Expo config plugin that injects:
 *
 *   Android:
 *     - ForegroundUploadService.kt (native foreground service with HTTP upload)
 *     - UploadBridgeModule.kt (React Native bridge for JS ↔ native communication)
 *     - UploadPackage.kt (React Native package registration)
 *     - Service declaration + permissions in AndroidManifest.xml
 *     - Package registration in MainApplication
 *
 *   iOS:
 *     - BackgroundUploadHandler.swift (URLSession background upload handler)
 *     - NativeUploadBridge.swift (React Native bridge module)
 *     - AppDelegate+BackgroundUpload.swift (background session event handling)
 *     - UIBackgroundModes: fetch + processing in Info.plist
 *     - Background session identifier in Info.plist
 *
 * This is the ONLY file that touches native code. All other upload logic
 * remains in TypeScript/JavaScript.
 */

const fs   = require('fs');
const path = require('path');

// Resolve @expo/config-plugins from expo's own package tree
const expoRoot = path.dirname(require.resolve('expo/package.json'));
const {
  withDangerousMod,
  withAndroidManifest,
  withMainApplication,
  withInfoPlist,
} = require(require.resolve('@expo/config-plugins', { paths: [expoRoot] }));

// ── Source file reading ──────────────────────────────────────────────────────

function readSourceFile(dir, filename) {
  const sourcePath = path.join(__dirname, '..', dir, filename);
  return fs.readFileSync(sourcePath, 'utf8');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANDROID
// ═══════════════════════════════════════════════════════════════════════════════

function withAndroidUploadSource(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      const androidSrcDir = path.join(
        projectRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'medacademy', 'upload'
      );

      fs.mkdirSync(androidSrcDir, { recursive: true });

      const files = [
        'ForegroundUploadService.kt',
        'UploadBridgeModule.kt',
        'UploadPackage.kt',
      ];

      for (const file of files) {
        const source = readSourceFile('android-native', file);
        const destPath = path.join(androidSrcDir, file);
        fs.writeFileSync(destPath, source, 'utf8');
        console.log(`[withNativeUpload] Android: injected ${file}`);
      }

      return cfg;
    },
  ]);
}

function withUploadPackageRegistration(config) {
  return withMainApplication(config, (cfg) => {
    let contents = cfg.modResults.contents;

    if (contents.includes('com.medacademy.upload.UploadPackage')) {
      return cfg;
    }

    const importLine = 'import com.medacademy.upload.UploadPackage;';
    if (!contents.includes(importLine)) {
      contents = contents.replace(
        /(import [^\n]+\n)(?!import)/,
        `$1${importLine}\n`
      );
    }

    if (contents.includes('getPackages()')) {
      contents = contents.replace(
        /(packages\.add\([^)]+\)\s*;?\s*\n\s*return packages\s*;)/,
        `packages.add(new UploadPackage());\n          $1`
      );
    }

    cfg.modResults.contents = contents;
    return cfg;
  });
}

function withUploadManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    if (!manifest['uses-permission']) manifest['uses-permission'] = [];

    const permissions = [
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.WAKE_LOCK',
    ];

    const existingPerms = manifest['uses-permission'].map(
      (p) => p.$?.['android:name']
    );

    for (const perm of permissions) {
      if (!existingPerms.includes(perm)) {
        manifest['uses-permission'].push({
          $: { 'android:name': perm },
        });
      }
    }

    const application = manifest.application?.[0];
    if (application) {
      if (!application.service) application.service = [];

      const existingServices = application.service.map(
        (s) => s.$?.['android:name']
      );

      const SERVICE_NAME = 'com.medacademy.upload.ForegroundUploadService';

      if (!existingServices.includes(SERVICE_NAME)) {
        application.service.push({
          $: {
            'android:name': SERVICE_NAME,
            'android:exported': 'false',
            'android:foregroundServiceType': 'dataSync',
          },
        });
      }
    }

    return cfg;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// iOS
// ═══════════════════════════════════════════════════════════════════════════════

function withIosUploadSource(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;

      // Find the iOS project directory
      // In Expo CNG, the ios/ directory is generated by prebuild
      const iosDir = path.join(projectRoot, 'ios');
      if (!fs.existsSync(iosDir)) {
        console.log('[withNativeUpload] iOS directory not found — skipping (run expo prebuild first)');
        return cfg;
      }

      // Find the main source directory (usually ios/MedAcademy/)
      const appName = cfg.modResults?.expoConfig?.name || 'MedAcademy';
      const iosAppDir = path.join(iosDir, appName);
      if (!fs.existsSync(iosAppDir)) {
        // Try finding the actual app directory
        const iosDirs = fs.readdirSync(iosDir).filter(d => {
          const full = path.join(iosDir, d);
          return fs.statSync(full).isDirectory() && d !== 'Pods';
        });
        if (iosDirs.length === 0) {
          console.log('[withNativeUpload] No iOS app directory found');
          return cfg;
        }
        // Use the first non-Pods directory
        var targetDir = path.join(iosDir, iosDirs[0]);
      } else {
        var targetDir = iosAppDir;
      }

      // Copy Swift source files
      const swiftFiles = [
        'BackgroundUploadHandler.swift',
        'NativeUploadBridge.swift',
        'AppDelegate+BackgroundUpload.swift',
      ];

      for (const file of swiftFiles) {
        const source = readSourceFile('ios-native', file);
        const destPath = path.join(targetDir, file);
        fs.writeFileSync(destPath, source, 'utf8');
        console.log(`[withNativeUpload] iOS: injected ${file} → ${destPath}`);
      }

      // Add Swift files to the Xcode project if .xcodeproj exists
      const xcodeprojDir = path.join(iosDir, `${appName}.xcodeproj`);
      if (fs.existsSync(xcodeprojDir)) {
        const pbxPath = path.join(xcodeprojDir, 'project.pbxproj');
        if (fs.existsSync(pbxPath)) {
          let pbx = fs.readFileSync(pbxPath, 'utf8');

          // Check if files are already added
          if (!pbx.includes('BackgroundUploadHandler.swift')) {
            // Add file references to PBXBuildFile and PBXFileReference sections
            // This is a simplified approach — in production, use xcode library
            console.log('[withNativeUpload] Note: Swift files added to directory. ' +
              'Add them to the Xcode project if not auto-detected.');
          }
        }
      }

      return cfg;
    },
  ]);
}

function withIosBackgroundUploadConfig(config) {
  return withInfoPlist(config, (cfg) => {
    const infoPlist = cfg.modResults;

    // UIBackgroundModes — required for background URLSession
    if (!infoPlist.UIBackgroundModes) infoPlist.UIBackgroundModes = [];
    const bgModes = infoPlist.UIBackgroundModes;
    if (!bgModes.includes('fetch')) bgModes.push('fetch');
    if (!bgModes.includes('processing')) bgModes.push('processing');

    // BGTaskScheduler identifiers — for upload recovery coordination
    if (!infoPlist.BGTaskSchedulerPermittedIdentifiers) {
      infoPlist.BGTaskSchedulerPermittedIdentifiers = [];
    }
    const taskIds = infoPlist.BGTaskSchedulerPermittedIdentifiers;
    const UPLOAD_TASK_ID = 'com.medacademy.app.upload-recovery';
    if (!taskIds.includes(UPLOAD_TASK_ID)) {
      taskIds.push(UPLOAD_TASK_ID);
    }

    // Background session identifier for documentation purposes
    // (The actual session ID is in BackgroundUploadHandler.swift)
    if (!infoPlist.NSBackgroundUploadSessionIdentifier) {
      infoPlist['NSBackgroundUploadSessionIdentifier'] = 'com.medacademy.video-upload';
    }

    return cfg;
  });
}

// ── Combined export ──────────────────────────────────────────────────────────

module.exports = function withNativeUpload(config) {
  // Android
  config = withAndroidUploadSource(config);
  config = withUploadPackageRegistration(config);
  config = withUploadManifest(config);

  // iOS
  config = withIosUploadSource(config);
  config = withIosBackgroundUploadConfig(config);

  return config;
};
