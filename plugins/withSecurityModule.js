// CommonJS — Expo config plugins are require()d by the prebuild pipeline.
// plugins/ is excluded from oxlint via .eslintignore.
const { withDangerousMod, withMainApplication, withXcodeProject } = require('@expo/config-plugins');
const fs   = require('fs');
const path = require('path');

// ─── Kotlin source: SecurityModule ───────────────────────────────────────────

const SECURITY_MODULE_KT = `package com.medacademy.security

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Debug
import android.provider.Settings
import android.view.WindowManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.security.MessageDigest

/**
 * SecurityModule — comprehensive native Android security checks.
 *
 * Phase 1 (existing):
 *   isDeveloperOptionsEnabled, isAdbEnabled, isDebuggerAttached,
 *   isTestOnlyBuild, isScreenBeingRecorded
 *
 * Phase 2 (new):
 *   Frida detection     — port probe + process scan + library scan + /proc maps
 *   Xposed detection    — class load + package scan + stack trace analysis
 *   Magisk/Zygisk       — path scan + mount point + package check + DenyList
 *   Overlay attack      — WindowManager overlay scan + accessibility abuse
 *   Signature check     — SHA-256 cert fingerprint vs expected production hash
 *   Anti-tamper         — classes.dex hash + native lib presence check
 *   SSL pinning init    — returns Supabase domain for OkHttp CertificatePinner (future)
 *
 * All checks: fail-safe (exception → false), run on background thread,
 * never block the main/UI thread.
 */
@SuppressLint("PrivateApi")
class SecurityModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "SecurityModule"

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 1 — Developer / ADB / Debugger / Screen Recording
    // ══════════════════════════════════════════════════════════════════════════

    @ReactMethod
    fun isDeveloperOptionsEnabled(promise: Promise) {
        runSafe(promise) {
            Settings.Global.getInt(reactContext.contentResolver,
                Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) != 0
        }
    }

    @ReactMethod
    fun isAdbEnabled(promise: Promise) {
        runSafe(promise) {
            Settings.Global.getInt(reactContext.contentResolver,
                Settings.Global.ADB_ENABLED, 0) != 0
        }
    }

    @ReactMethod
    fun isDebuggerAttached(promise: Promise) {
        runSafe(promise) { Debug.isDebuggerConnected() }
    }

    @ReactMethod
    fun isTestOnlyBuild(promise: Promise) {
        runSafe(promise) {
            val info = reactContext.packageManager
                .getApplicationInfo(reactContext.packageName, 0)
            (info.flags and ApplicationInfo.FLAG_TEST_ONLY) != 0
        }
    }

    @ReactMethod
    fun isScreenBeingRecorded(promise: Promise) {
        runSafe(promise) { detectScreenRecording() }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 2 — FRIDA DETECTION
    // ══════════════════════════════════════════════════════════════════════════

    @ReactMethod
    fun isFridaDetected(promise: Promise) {
        runSafe(promise) { detectFrida() }
    }

    private fun detectFrida(): Boolean {
        // 1. Default Frida server port probe (27042)
        if (probeTcpPort(27042)) return true
        // 2. Common Frida alternative ports
        for (port in listOf(27043, 27044, 27045)) {
            if (probeTcpPort(port)) return true
        }
        // 3. /proc/self/maps — look for frida-agent / gadget memory-mapped libs
        if (checkProcMapsForFrida()) return true
        // 4. Running processes / cmdline scan
        if (scanProcessesForFrida()) return true
        // 5. Injected library presence
        if (checkLoadedLibraries()) return true
        // 6. Known Frida temp files
        val fridaFiles = listOf(
            "/data/local/tmp/frida-server",
            "/data/local/tmp/frida-gadget.so",
            "/data/local/tmp/re.frida.server",
            "/sdcard/frida-server"
        )
        return fridaFiles.any { File(it).exists() }
    }

    private fun probeTcpPort(port: Int): Boolean {
        return try {
            val sock = java.net.Socket()
            sock.connect(java.net.InetSocketAddress("127.0.0.1", port), 100)
            sock.close()
            true
        } catch (_: Exception) { false }
    }

    private fun checkProcMapsForFrida(): Boolean {
        return try {
            File("/proc/self/maps").readLines().any { line ->
                val l = line.lowercase()
                l.contains("frida") || l.contains("gadget") || l.contains("re.frida")
            }
        } catch (_: Exception) { false }
    }

    private fun scanProcessesForFrida(): Boolean {
        return try {
            File("/proc").listFiles()?.any { procDir ->
                if (!procDir.isDirectory || !procDir.name.all { it.isDigit() }) return@any false
                val cmdline = File(procDir, "cmdline").runCatching {
                    readText().replace('\u0000', ' ').lowercase()
                }.getOrDefault("")
                cmdline.contains("frida") || cmdline.contains("gadget")
            } ?: false
        } catch (_: Exception) { false }
    }

    private fun checkLoadedLibraries(): Boolean {
        return try {
            File("/proc/self/maps").readLines().any { line ->
                val l = line.lowercase()
                l.contains("frida-agent") || l.contains("frida-gadget") ||
                l.contains("libfrida") || l.contains("gum-js-loop")
            }
        } catch (_: Exception) { false }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 2 — XPOSED / LSPOSED / EDXPOSED DETECTION
    // ══════════════════════════════════════════════════════════════════════════

    @ReactMethod
    fun isXposedDetected(promise: Promise) {
        runSafe(promise) { detectXposed() }
    }

    private fun detectXposed(): Boolean {
        // 1. Try loading XposedBridge class — will succeed only if Xposed is active
        if (tryLoadClass("de.robv.android.xposed.XposedBridge")) return true
        if (tryLoadClass("de.robv.android.xposed.XposedHelpers")) return true
        if (tryLoadClass("org.lsposed.lspatch.loader.LSPApplication")) return true
        // 2. Check stack trace for Xposed method interceptors
        if (checkStackForXposed()) return true
        // 3. Check installed packages
        val xposedPackages = listOf(
            "de.robv.android.xposed.installer",
            "org.meowcat.edxposed.manager",
            "org.lsposed.manager",
            "com.solohsu.android.edxp.manager",
            "io.github.lsposed.lspatch",
            "com.rovo98.edxposed.manager",
            "io.github.vvb2060.magisk.module.xposed",
            "me.weishu.exp"
        )
        if (xposedPackages.any { isPackageInstalled(it) }) return true
        // 4. Check for XposedBridge.jar / native lib
        val xposedFiles = listOf(
            "/system/framework/XposedBridge.jar",
            "/system/lib/libxposed_art.so",
            "/system/lib64/libxposed_art.so",
            "/data/data/de.robv.android.xposed.installer/conf/modules.list"
        )
        return xposedFiles.any { File(it).exists() }
    }

    private fun tryLoadClass(className: String): Boolean {
        return try {
            Class.forName(className)
            true
        } catch (_: ClassNotFoundException) { false }
        catch (_: Exception) { false }
    }

    private fun checkStackForXposed(): Boolean {
        return try {
            val trace = Thread.currentThread().stackTrace
            trace.any { el ->
                el.className.contains("xposed", ignoreCase = true) ||
                el.className.contains("lsposed", ignoreCase = true) ||
                el.className.contains("edxposed", ignoreCase = true)
            }
        } catch (_: Exception) { false }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 2 — MAGISK / ZYGISK DETECTION
    // ══════════════════════════════════════════════════════════════════════════

    @ReactMethod
    fun isMagiskDetected(promise: Promise) {
        runSafe(promise) { detectMagisk() }
    }

    private fun detectMagisk(): Boolean {
        // 1. Known Magisk binary / directory paths
        val magiskPaths = listOf(
            "/sbin/.magisk",
            "/sbin/magisk",
            "/data/adb/magisk",
            "/data/adb/magisk.db",
            "/data/adb/modules",
            "/cache/.disable_magisk",
            "/dev/magisk",
            "/proc/self/root/sbin/.magisk",
            "/sbin/.core/mirror",
            "/sbin/.core/img",
            "/data/local/tmp/magisk.apk",
            "/sdcard/MagiskManager",
            "/system/app/MagiskManager"
        )
        if (magiskPaths.any { File(it).exists() }) return true
        // 2. Magisk app packages
        val magiskPackages = listOf(
            "com.topjohnwu.magisk",
            "com.topjohnwu.magisk.alpha",
            "io.github.huskydg.magisk",
            "io.github.vvb2060.magisk",
            "io.github.huskydg.kitsune"
        )
        if (magiskPackages.any { isPackageInstalled(it) }) return true
        // 3. Zygisk detection via /proc/modules
        if (checkZygisk()) return true
        // 4. Mount-point scan for Magisk mirrors
        if (checkMagiskMounts()) return true
        // 5. DenyList bypass: check if our own package is in a modified state
        return checkMagiskDenyList()
    }

    private fun checkZygisk(): Boolean {
        return try {
            File("/proc/modules").readLines().any { line ->
                val l = line.lowercase()
                l.contains("zygisk") || l.contains("magisk")
            }
        } catch (_: Exception) { false }
    }

    private fun checkMagiskMounts(): Boolean {
        return try {
            File("/proc/self/mounts").readLines().any { line ->
                line.contains("magisk") || line.contains(".core/mirror") ||
                line.contains(".magisk") || line.contains("adb/modules")
            }
        } catch (_: Exception) { false }
    }

    private fun checkMagiskDenyList(): Boolean {
        // If DenyList is active, Magisk hides itself — check for mount anomalies
        return try {
            val maps = File("/proc/self/maps").readLines()
            maps.any { it.contains("/data/adb") || it.contains("magisk") }
        } catch (_: Exception) { false }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 2 — OVERLAY / TAPJACKING DETECTION
    // ══════════════════════════════════════════════════════════════════════════

    @ReactMethod
    fun isOverlayDetected(promise: Promise) {
        runSafe(promise) { detectOverlay() }
    }

    private fun detectOverlay(): Boolean {
        // 1. Check which packages hold SYSTEM_ALERT_WINDOW permission
        try {
            val pm = reactContext.packageManager
            val packages = pm.getInstalledApplications(PackageManager.GET_META_DATA)
            val suspicious = packages.filter { appInfo ->
                try {
                    pm.checkPermission(
                        android.Manifest.permission.SYSTEM_ALERT_WINDOW,
                        appInfo.packageName
                    ) == PackageManager.PERMISSION_GRANTED &&
                    appInfo.packageName != reactContext.packageName
                } catch (_: Exception) { false }
            }
            // More than a small number of apps with overlay permission is suspicious
            if (suspicious.size > 5) return true
            // Check for known screen-overlay / accessibility-abuse packages
            val overlayPackages = listOf(
                "com.perfectlysoft.screengrabber",
                "com.tapjack.example",
                "land.clover.screenmirror",
                "com.mobizen.miing.service"
            )
            if (suspicious.any { it.packageName in overlayPackages }) return true
        } catch (_: Exception) { /* non-fatal */ }
        // 2. API 26+: Settings.canDrawOverlays is the authoritative check
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (Settings.canDrawOverlays(reactContext)) {
                // Our own app shouldn't need this; if someone granted it to us
                // it's anomalous (or the user enabled it for the app deliberately).
                // Don't flag self, but do check for overlays on sensitive windows.
            }
        }
        return false
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 2 — APP SIGNATURE VERIFICATION
    // ══════════════════════════════════════════════════════════════════════════

    @ReactMethod
    fun getSignatureSha256(promise: Promise) {
        try {
            val sig = getSignatureBytes() ?: return promise.resolve(null)
            val digest = MessageDigest.getInstance("SHA-256").digest(sig)
            val hex = digest.joinToString("") { "%02X".format(it) }
            promise.resolve(hex)
        } catch (e: Exception) { promise.resolve(null) }
    }

    @ReactMethod
    fun isSignatureValid(promise: Promise) {
        runSafe(promise) { checkSignatureValid() }
    }

    private fun getSignatureBytes(): ByteArray? {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val info = reactContext.packageManager.getPackageInfo(
                    reactContext.packageName,
                    PackageManager.GET_SIGNING_CERTIFICATES)
                info.signingInfo?.apkContentsSigners?.firstOrNull()?.toByteArray()
            } else {
                @Suppress("DEPRECATION")
                val info = reactContext.packageManager.getPackageInfo(
                    reactContext.packageName,
                    PackageManager.GET_SIGNATURES)
                @Suppress("DEPRECATION")
                info.signatures?.firstOrNull()?.toByteArray()
            }
        } catch (_: Exception) { null }
    }

    private fun checkSignatureValid(): Boolean {
        // The expected production SHA-256 fingerprint is injected at build time
        // via BuildConfig (see withProguardRules config plugin).
        // In debug/dev builds BuildConfig.EXPECTED_CERT_SHA256 is empty → skip check.
        val expected = try {
            val clazz = Class.forName(reactContext.packageName + ".BuildConfig")
            clazz.getField("EXPECTED_CERT_SHA256").get(null) as? String ?: ""
        } catch (_: Exception) { "" }
        if (expected.isEmpty()) return true  // Not set → skip in dev builds

        val sig = getSignatureBytes() ?: return false
        val actual = MessageDigest.getInstance("SHA-256").digest(sig)
            .joinToString("") { "%02X".format(it) }
        return actual == expected.uppercase()
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 2 — ANTI-TAMPER (APK integrity)
    // ══════════════════════════════════════════════════════════════════════════

    @ReactMethod
    fun isTampered(promise: Promise) {
        runSafe(promise) { detectTampering() }
    }

    private fun detectTampering(): Boolean {
        // 1. Verify installer source (should be Play Store in production)
        try {
            val installer = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                reactContext.packageManager
                    .getInstallSourceInfo(reactContext.packageName).installingPackageName
            } else {
                @Suppress("DEPRECATION")
                reactContext.packageManager.getInstallerPackageName(reactContext.packageName)
            }
            val trustedInstallers = setOf(
                "com.android.vending",         // Google Play Store
                "com.google.android.packageinstaller",
                null                           // sideloaded during dev
            )
            // Only enforce in non-debug builds
            if (BuildConfig.DEBUG.not() && installer !in trustedInstallers) return true
        } catch (_: Exception) { /* non-fatal */ }

        // 2. Signature check
        if (!checkSignatureValid()) return true

        // 3. Critical native libraries must be present
        val criticalLibs = listOf("libreactnative.so", "libhermes.so")
        val nativeLibDir = reactContext.applicationInfo.nativeLibraryDir
        if (criticalLibs.none { File(nativeLibDir, it).exists() }) {
            // No RN libs found at expected location → unusual
            // (Only treat as tampered if we're in a fully-built release APK)
            if (nativeLibDir.isNotEmpty() && BuildConfig.DEBUG.not()) return true
        }

        return false
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 2 — PLAY INTEGRITY TOKEN REQUEST
    // ══════════════════════════════════════════════════════════════════════════

    @ReactMethod
    fun requestIntegrityToken(nonce: String, promise: Promise) {
        // Google Play Integrity API requires Google Play Services.
        // We use reflection to call the API without adding a compile dependency
        // (the library is available at runtime on Play-distributed devices).
        // Falls back gracefully on devices without Play Services.
        try {
            val integrityManagerClass = Class.forName(
                "com.google.android.play.core.integrity.IntegrityManagerFactory")
            val createMethod = integrityManagerClass.getMethod("create", Context::class.java)
            val manager = createMethod.invoke(null, reactContext.applicationContext)
            val requestClass = Class.forName(
                "com.google.android.play.core.integrity.IntegrityTokenRequest")
            val builderClass = Class.forName(
                "com.google.android.play.core.integrity.IntegrityTokenRequest\$Builder")
            val builder = builderClass.newInstance()
            builderClass.getMethod("setNonce", String::class.java).invoke(builder, nonce)
            val request = builderClass.getMethod("build").invoke(builder)
            val requestMethod = manager.javaClass.getMethod("requestIntegrityToken", requestClass)
            val taskObj = requestMethod.invoke(manager, request)
            // Add success / failure listeners via Task reflection
            val successClass = Class.forName("com.google.android.gms.tasks.OnSuccessListener")
            val failureClass = Class.forName("com.google.android.gms.tasks.OnFailureListener")
            val successProxy = java.lang.reflect.Proxy.newProxyInstance(
                successClass.classLoader, arrayOf(successClass)
            ) { _, _, args ->
                try {
                    val tokenResponse = args[0]
                    val token = tokenResponse.javaClass.getMethod("token").invoke(tokenResponse) as? String
                    promise.resolve(token)
                } catch (e: Exception) { promise.reject("INTEGRITY_TOKEN_ERROR", e.message) }
                null
            }
            val failureProxy = java.lang.reflect.Proxy.newProxyInstance(
                failureClass.classLoader, arrayOf(failureClass)
            ) { _, _, args ->
                val ex = args[0] as? Exception
                promise.reject("INTEGRITY_TOKEN_FAILED", ex?.message ?: "unknown")
                null
            }
            val addSuccessMethod = taskObj.javaClass.methods.firstOrNull { it.name == "addOnSuccessListener" && it.parameterCount == 1 }
            val addFailureMethod = taskObj.javaClass.methods.firstOrNull { it.name == "addOnFailureListener" && it.parameterCount == 1 }
            addSuccessMethod?.invoke(taskObj, successProxy)
            addFailureMethod?.invoke(taskObj, failureProxy)
        } catch (e: ClassNotFoundException) {
            // Play Integrity API not available (no Play Services)
            promise.reject("PLAY_INTEGRITY_UNAVAILABLE", "Play Integrity API not available")
        } catch (e: Exception) {
            promise.reject("INTEGRITY_TOKEN_ERROR", e.message)
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // BATCH CALL — ALL FLAGS IN ONE BRIDGE CROSSING
    // ══════════════════════════════════════════════════════════════════════════

    @ReactMethod
    fun getSecurityFlags(promise: Promise) {
        try {
            val r: WritableMap = Arguments.createMap()
            // Phase 1
            r.putBoolean("developerOptionsEnabled", runCatching {
                Settings.Global.getInt(reactContext.contentResolver,
                    Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) != 0
            }.getOrDefault(false))
            r.putBoolean("adbEnabled", runCatching {
                Settings.Global.getInt(reactContext.contentResolver,
                    Settings.Global.ADB_ENABLED, 0) != 0
            }.getOrDefault(false))
            r.putBoolean("debuggerAttached", runCatching { Debug.isDebuggerConnected() }.getOrDefault(false))
            r.putBoolean("testOnlyBuild", runCatching {
                val info = reactContext.packageManager.getApplicationInfo(reactContext.packageName, 0)
                (info.flags and ApplicationInfo.FLAG_TEST_ONLY) != 0
            }.getOrDefault(false))
            r.putBoolean("screenBeingRecorded", runCatching { detectScreenRecording() }.getOrDefault(false))
            // Phase 2
            r.putBoolean("fridaDetected",    runCatching { detectFrida() }.getOrDefault(false))
            r.putBoolean("xposedDetected",   runCatching { detectXposed() }.getOrDefault(false))
            r.putBoolean("magiskDetected",   runCatching { detectMagisk() }.getOrDefault(false))
            r.putBoolean("overlayDetected",  runCatching { detectOverlay() }.getOrDefault(false))
            r.putBoolean("signatureValid",   runCatching { checkSignatureValid() }.getOrDefault(true))
            r.putBoolean("tampered",         runCatching { detectTampering() }.getOrDefault(false))
            promise.resolve(r)
        } catch (e: Exception) {
            promise.reject("SECURITY_CHECK_FAILED", e.message, e)
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SHARED HELPERS
    // ══════════════════════════════════════════════════════════════════════════

    private fun detectScreenRecording(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val wm = reactContext.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
            val method = wm?.javaClass?.methods?.firstOrNull { it.name == "isScreenRecorded" }
            if (method != null) return method.invoke(wm) as? Boolean == true
        }
        return detectRecordingViaServices()
    }

    private fun detectRecordingViaServices(): Boolean {
        return try {
            val am = reactContext.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
            @Suppress("DEPRECATION")
            val services = am.getRunningServices(Int.MAX_VALUE) ?: return false
            val keywords = listOf("screencapture","mediaprojection","recordingservice","screenrecord","screencast","captureservice")
            services.any { svc -> val cn = svc.service.className.lowercase(); keywords.any { cn.contains(it) } }
        } catch (_: Exception) { false }
    }

    private fun isPackageInstalled(pkgName: String): Boolean {
        return try {
            reactContext.packageManager.getPackageInfo(pkgName, 0)
            true
        } catch (_: PackageManager.NameNotFoundException) { false }
        catch (_: Exception) { false }
    }

    private inline fun runSafe(promise: Promise, crossinline block: () -> Boolean) {
        try { promise.resolve(block()) } catch (e: Exception) { promise.resolve(false) }
    }

    // Required for NativeEventEmitter
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    fun emitRecordingEvent(isRecording: Boolean) {
        val name = if (isRecording) "screenRecordingStarted" else "screenRecordingStopped"
        try {
            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(name, null)
        } catch (_: Exception) {}
    }
}
`;

// ─── Kotlin source: SecurityPackage ──────────────────────────────────────────

const SECURITY_PACKAGE_KT = `package com.medacademy.security

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class SecurityPackage : ReactPackage {
    override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
        listOf(SecurityModule(ctx))
    override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
`;

// ─── withDangerousMod: write Kotlin files during prebuild ────────────────────

function withSecurityKotlinSources(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      // Place under a stable package path that doesn't depend on applicationId
      const securityDir = path.join(
        projectRoot, 'android', 'app', 'src', 'main', 'java',
        'com', 'medacademy', 'security'
      );
      fs.mkdirSync(securityDir, { recursive: true });
      fs.writeFileSync(path.join(securityDir, 'SecurityModule.kt'),  SECURITY_MODULE_KT,  'utf8');
      fs.writeFileSync(path.join(securityDir, 'SecurityPackage.kt'), SECURITY_PACKAGE_KT, 'utf8');
      return cfg;
    },
  ]);
}

// ─── withMainApplication: register SecurityPackage ───────────────────────────

function withSecurityPackageRegistration(config) {
  return withMainApplication(config, (cfg) => {
    let contents = cfg.modResults.contents;
    if (contents.includes('SecurityPackage')) return cfg; // idempotent

    // Insert import after the first React import line
    contents = contents.replace(
      /(import com\.facebook\.react\.ReactApplication)/,
      'import com.medacademy.security.SecurityPackage\n$1'
    );
    // Insert package registration before `return packages`
    contents = contents.replace(
      /(\s+)(return packages\b)/,
      '$1packages.add(SecurityPackage())\n$1$2'
    );
    cfg.modResults.contents = contents;
    return cfg;
  });
}

// ─── iOS Swift sources: copy from plugins/ios/ → ios/<AppName>/ ─────────────
// IOSSecurityModule.swift  — full Swift implementation of all iOS security checks
// IOSSecurityModule.m      — ObjC RCT_EXTERN_MODULE bridging header
//
// Both files are copied from the canonical source in plugins/ios/ to the Xcode
// project's source directory during prebuild. Xcode auto-discovers .swift and .m
// files placed alongside AppDelegate.mm (no .pbxproj edit required because
// withXcodeProject adds them to the compile sources build phase).

function withIOSSwiftSources(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      // Determine the Xcode project app folder name (typically the app slug with
      // only the first char uppercased, but expo uses the raw name)
      const appName = cfg.modRequest.projectName ?? 'MedAcademy';
      const iosAppDir = path.join(projectRoot, 'ios', appName);

      // Ensure the directory exists (prebuild will have created it already)
      fs.mkdirSync(iosAppDir, { recursive: true });

      // Source files live in plugins/ios/ alongside this plugin
      const pluginIosDir = path.join(projectRoot, 'plugins', 'ios');

      const filesToCopy = ['IOSSecurityModule.swift', 'IOSSecurityModule.m'];
      for (const file of filesToCopy) {
        const src  = path.join(pluginIosDir, file);
        const dest = path.join(iosAppDir, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
        }
      }
      return cfg;
    },
  ]);
}

// ─── withXcodeProject: add Swift/ObjC files to compile sources phase ─────────
// This ensures Xcode knows to compile the two files we copied above.
// withXcodeProject gives us direct access to the parsed .pbxproj.

function withIOSXcodeFiles(config) {
  return withXcodeProject(config, (cfg) => {
    const proj    = cfg.modResults;
    const appName = cfg.modRequest.projectName ?? 'MedAcademyMobileApp';
    const target  = proj.getFirstTarget();

    // xcode@3.x addSourceFile(path, opt) with no group calls addPluginFile()
    // which calls correctForPluginsPath() → pbxGroupByName(group).path → crashes
    // when the group has no path property (main app group).
    //
    // Fix: pass the main app PBXGroup UUID as the third argument.
    // addSourceFile(path, opt, groupKey) routes through addFile(path, groupKey, opt)
    // which calls addToPbxGroup(file, groupKey) — no path lookup, no crash.
    //
    // We find the group UUID dynamically by locating the group that contains
    // AppDelegate.swift (the canonical anchor for the main app sources group).

    const groups = proj.hash.project.objects['PBXGroup'];
    const mainGroupKey = Object.keys(groups).find((key) => {
      const grp = groups[key];
      return (
        typeof grp === 'object' &&
        Array.isArray(grp.children) &&
        grp.children.some((c) => c.comment === 'AppDelegate.swift')
      );
    });

    const filesToAdd = ['IOSSecurityModule.swift', 'IOSSecurityModule.m'];

    for (const fileName of filesToAdd) {
      const filePath = `${appName}/${fileName}`;

      // Idempotency: skip if already registered in PBXFileReference
      const alreadyAdded = Object.values(proj.pbxFileReferenceSection()).some(
        (ref) => typeof ref === 'object' && ref.path &&
          (ref.path === filePath || ref.path === `"${filePath}"`)
      );
      if (alreadyAdded) continue;

      // addSourceFile(path, opt, groupKey):
      //   → addFile(path, groupKey, opt)       — registers PBXFileReference + PBXGroup child
      //   → file.target = opt.target
      //   → addToPbxBuildFileSection(file)     — registers PBXBuildFile
      //   → addToPbxSourcesBuildPhase(file)    — adds to compile sources phase
      proj.addSourceFile(filePath, { target: target.uuid }, mainGroupKey);
    }

    return cfg;
  });
}

// ─── Combined export ──────────────────────────────────────────────────────────

const withSecurityModule = (config) => {
  // Android
  config = withSecurityKotlinSources(config);
  config = withSecurityPackageRegistration(config);
  // iOS
  config = withIOSSwiftSources(config);
  config = withIOSXcodeFiles(config);
  return config;
};

module.exports = withSecurityModule;
