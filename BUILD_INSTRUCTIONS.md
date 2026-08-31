# MedAcademy Mobile App — Local Native Build Instructions

This archive contains a fully pre-built Expo project with generated `android/` and `ios/`
native directories. All Expo config plugins have already been executed. You can open the
projects directly in Android Studio and Xcode without running `expo prebuild` again.

---

## Required Tool Versions

| Tool | Required Version | Notes |
|---|---|---|
| Node.js | **18.x – 24.x** | v24.16.0 used to generate this archive |
| pnpm | 9.x or npm 10.x | For `node_modules` install only |
| Java (JDK) | **17** (LTS) | OpenJDK 17 confirmed working; JDK 21 also supported |
| Android Studio | **Hedgehog 2023.1.1** or newer | Includes AGP 8.x + Gradle 9.0 toolchain |
| Gradle | **9.0.0** | Wrapper included — auto-downloaded on first build |
| Android SDK | **API 35** (compile), **API 24** (min) | Install via Android Studio SDK Manager |
| Android NDK | **27.1.12297006** | Install via Android Studio SDK Manager |
| Xcode | **16.x** | Minimum iOS deployment target: 15.1 |
| CocoaPods | **1.15.x** | `sudo gem install cocoapods` |
| Expo CLI | **55.0.16** | `npm install -g expo-cli` (optional — only needed for `expo prebuild`) |

---

## Project Details

| Property | Value |
|---|---|
| App Name | MedAcademy Mobile App |
| Bundle ID (iOS) | `com.miaoda.appczyg340mpc75` |
| Package (Android) | `com.miaoda.appczyg340mpc75` |
| Version | 1.0.432 |
| React Native | 0.83.2 |
| Expo SDK | 55.0.6 |
| Min Android SDK | 24 |
| Target Android SDK | 35 |
| iOS Deployment Target | 15.1 |

---

## Environment Variables

Create a `.env` file in the project root (already present in this archive) with:

```
EXPO_PUBLIC_SUPABASE_URL=https://xdvjwfuqipatkpimejcb.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<your_anon_key>
EXPO_PUBLIC_APP_ID=app-czyg340mpc75
EXPO_PUBLIC_APP_SCHEME=medacademy
```

These are embedded into the JS bundle at Metro build time. No native rebuild is needed
when changing these values — only a JS bundle rebuild.

---

## Step 1 — Install JavaScript Dependencies

```bash
# From the project root
npm install
# or
pnpm install
```

> **Note**: `node_modules/` is NOT included in this archive to keep the ZIP size manageable.
> You must run the install step before building.

---

## Step 2 — Android Build

### 2a. Open in Android Studio

1. Launch Android Studio
2. **File → Open** → select the `android/` folder inside this project
3. Wait for Gradle sync to complete (first sync downloads ~500 MB)
4. Install any missing SDK components when prompted

### 2b. Build from Android Studio

- **Debug APK**: `Build → Build Bundle(s) / APK(s) → Build APK(s)`
- **Release APK**: `Build → Generate Signed Bundle / APK` → follow signing wizard

### 2c. Build from Command Line

```bash
# From the project root
cd android

# Debug APK
./gradlew assembleDebug

# Release APK (requires signing config — see below)
./gradlew assembleRelease

# Debug AAB
./gradlew bundleDebug

# Release AAB
./gradlew bundleRelease
```

Output locations:
- APK: `android/app/build/outputs/apk/debug/app-debug.apk`
- APK: `android/app/build/outputs/apk/release/app-release.apk`
- AAB: `android/app/build/outputs/bundle/release/app-release.aab`

### 2d. Android Release Signing

Add to `android/app/build.gradle` under `android { signingConfigs { ... } }`:

```groovy
signingConfigs {
    release {
        storeFile file('your-keystore.jks')
        storePassword System.getenv('KEYSTORE_PASSWORD')
        keyAlias System.getenv('KEY_ALIAS')
        keyPassword System.getenv('KEY_PASSWORD')
    }
}
```

Or set these environment variables before running Gradle:

```bash
export KEYSTORE_PASSWORD=...
export KEY_ALIAS=...
export KEY_PASSWORD=...
```

### 2e. Required Android Environment Variables

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk          # macOS
export ANDROID_HOME=$HOME/Android/Sdk                  # Linux
export PATH=$PATH:$ANDROID_HOME/emulator
export PATH=$PATH:$ANDROID_HOME/platform-tools
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64    # Linux
export JAVA_HOME=$(/usr/libexec/java_home -v 17)       # macOS
```

---

## Step 3 — iOS Build

### 3a. Install CocoaPods Dependencies

```bash
# From the project root
cd ios
pod install
cd ..
```

> This downloads all native Pod dependencies (~800 MB on first install).
> Requires CocoaPods 1.15.x and Xcode Command Line Tools installed.

### 3b. Open in Xcode

```bash
open ios/MedAcademyMobileApp.xcworkspace
```

**Always open the `.xcworkspace` file, never `.xcodeproj` directly** (CocoaPods requires the workspace).

### 3c. Build from Xcode

1. Select the `MedAcademyMobileApp` scheme
2. Select your target device or simulator
3. **Product → Build** (`⌘B`) to compile
4. **Product → Archive** to create a distributable IPA

### 3d. Build from Command Line

```bash
# Simulator build (no signing required)
xcodebuild \
  -workspace ios/MedAcademyMobileApp.xcworkspace \
  -scheme MedAcademyMobileApp \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  build

# Device build (requires signing)
xcodebuild \
  -workspace ios/MedAcademyMobileApp.xcworkspace \
  -scheme MedAcademyMobileApp \
  -configuration Release \
  -sdk iphoneos \
  CODE_SIGN_IDENTITY="iPhone Distribution" \
  DEVELOPMENT_TEAM="<YOUR_TEAM_ID>" \
  build

# Archive for App Store / Ad Hoc
xcodebuild \
  -workspace ios/MedAcademyMobileApp.xcworkspace \
  -scheme MedAcademyMobileApp \
  -configuration Release \
  -sdk iphoneos \
  -archivePath build/MedAcademy.xcarchive \
  CODE_SIGN_IDENTITY="iPhone Distribution" \
  DEVELOPMENT_TEAM="<YOUR_TEAM_ID>" \
  archive
```

### 3e. iOS Signing Requirements

- Apple Developer account with valid provisioning profiles
- `DEVELOPMENT_TEAM` = your 10-character Apple Team ID (found in developer.apple.com)
- Bundle ID `com.miaoda.appczyg340mpc75` must be registered in App Store Connect
- App Attest entitlement enabled (already in `MedAcademyMobileApp.entitlements`)

---

## Native Security Modules

This project includes custom native security modules compiled directly into the app:

### Android
- `android/app/src/main/java/com/medacademy/security/SecurityModule.kt`
  - Root/emulator detection, Frida/Xposed/Magisk detection, overlay detection,
    signature verification, anti-tamper, Play Integrity API, screen recording monitor
- `android/app/src/main/java/com/medacademy/security/SecurityPackage.kt`
  - Registers SecurityModule with the React Native bridge

### iOS
- `ios/MedAcademyMobileApp/IOSSecurityModule.swift`
  - Jailbreak detection, debugger detection, screen recording detection,
    VPN/proxy detection, dylib injection detection, bundle tamper detection,
    App Attest, DeviceCheck, security flags aggregator
- `ios/MedAcademyMobileApp/IOSSecurityModule.m`
  - ObjC bridge (`RCT_EXTERN_MODULE` + 12 `RCT_EXTERN_METHOD` declarations)

Both modules are registered in the Xcode project's Compile Sources build phase and
the Android Gradle build. No additional configuration is needed.

---

## Troubleshooting

### Android: `ANDROID_HOME not set`
Set `ANDROID_HOME` to your Android SDK path (see Step 2e above).

### Android: `SDK location not found`
Create `android/local.properties`:
```
sdk.dir=/Users/<you>/Library/Android/sdk
```

### Android: Gradle sync fails on first open
Ensure you have JDK 17 set as the project JDK in Android Studio:
**File → Project Structure → SDK Location → JDK location**

### iOS: `pod install` fails with `Unable to find a specification`
```bash
pod repo update
pod install
```

### iOS: `xcodebuild: error: SDK "iphoneos" cannot be located`
Install Xcode Command Line Tools:
```bash
xcode-select --install
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

### iOS: Code signing errors
For local testing without a Developer account, use automatic signing in Xcode:
**Signing & Capabilities → Automatically manage signing → check the box**

### Metro bundler not running during build
The Gradle/Xcode build embeds the JS bundle at build time. For debug builds,
start Metro separately:
```bash
npx expo start
```

---

## Re-running Prebuild (if needed)

If you modify `app.json` or any file in `plugins/`, regenerate the native projects:

```bash
# Requires Node.js + pnpm/npm installed
npm install        # or pnpm install
npx expo prebuild --clean --no-install
cd ios && pod install
```

> **Do not** manually edit files inside `android/` or `ios/` — they are fully managed
> by `expo prebuild`. All customizations live in `plugins/`.

---

## Plugin Fix Note (v432)

This archive includes a fix to `plugins/withSecurityModule.js` for `xcode@3.x`
compatibility. The original `addSourceFile(path, opt)` call (no group argument)
invoked `addPluginFile()` → `correctForPluginsPath()` which crashed with:

```
TypeError: Cannot read properties of null (reading 'path')
    at correctForPath (pbxProject.js:1682)
```

The fix passes the main app PBXGroup UUID as the third argument:
`addSourceFile(filePath, { target }, mainGroupKey)` — routing through `addFile()`
which directly calls `addToPbxGroup()` without the broken path-correction logic.
This was the root cause of the "Packaging failed" error.
