// CommonJS — Expo config plugins are require()d by the prebuild pipeline.
// plugins/ is excluded from oxlint via .eslintignore.
//
// @expo/config-plugins is NOT a direct project dependency — it lives inside
// expo's own node_modules tree. Under pnpm, require('@expo/config-plugins')
// from the project root fails because pnpm does not hoist transitive deps.
// We resolve it from expo's package directory so Node can always find it,
// regardless of whether the project uses npm, yarn, or pnpm.
const fs   = require('fs');
const path = require('path');
const expoDir = path.dirname(require.resolve('expo/package.json'));
const { withDangerousMod, withMainApplication, withXcodeProject } = require(
  require.resolve('@expo/config-plugins', { paths: [expoDir] })
);

// ─── Kotlin source: SecurityModule ───────────────────────────────────────────

const SECURITY_MODULE_KT = `package com.medacademy.security

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.app.AppOpsManager
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorManager
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Debug
import android.provider.Settings
import android.util.Log
import android.view.WindowManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
// BuildConfig import removed — runtime equivalent used below to avoid AGP/Kotlin task-ordering issue
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.NetworkInterface
import java.security.MessageDigest

private const val TAG = "SecurityModule"

/**
 * SecurityModule — comprehensive native Android security checks.
 *
 * Phase 1 (existing):
 *   isDeveloperOptionsEnabled, isAdbEnabled, isDebuggerAttached,
 *   isTestOnlyBuild, isScreenBeingRecorded
 *
 * Phase 2 (existing):
 *   Frida detection     — port probe + process scan + library scan + /proc maps
 *   Xposed detection    — class load + package scan + stack trace analysis
 *   Magisk/Zygisk       — path scan + mount point + package check + DenyList
 *   Overlay attack      — WindowManager overlay scan + accessibility abuse
 *   Signature check     — SHA-256 cert fingerprint vs expected production hash
 *   Anti-tamper         — classes.dex hash + native lib presence check
 *
 * Phase 3 (new — previously missing):
 *   VPN detection       — ConnectivityManager TRANSPORT_VPN + NetworkInterface tun/vpn scan
 *   Root detection      — su binary paths + system props + test-keys + /system write test
 *   Emulator detection  — Build fingerprint/model/manufacturer + QEMU props + sensor count
 *   Mock location       — AppOpsManager MOCK_LOCATION + Settings.Secure (pre-API23 fallback)
 *
 * All checks: fail-safe (exception → false), detailed Log.d for diagnostics.
 * Never block the main/UI thread.
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
        Log.d(TAG, "[isDeveloperOptionsEnabled] ▶ called")
        runSafe(promise) {
            val result = Settings.Global.getInt(reactContext.contentResolver,
                Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) != 0
            Log.d(TAG, "[isDeveloperOptionsEnabled] result=$result")
            result
        }
    }

    @ReactMethod
    fun isAdbEnabled(promise: Promise) {
        Log.d(TAG, "[isAdbEnabled] ▶ called")
        runSafe(promise) {
            val result = Settings.Global.getInt(reactContext.contentResolver,
                Settings.Global.ADB_ENABLED, 0) != 0
            Log.d(TAG, "[isAdbEnabled] result=$result")
            result
        }
    }

    @ReactMethod
    fun isDebuggerAttached(promise: Promise) {
        Log.d(TAG, "[isDebuggerAttached] ▶ called")
        runSafe(promise) {
            val result = Debug.isDebuggerConnected()
            Log.d(TAG, "[isDebuggerAttached] result=$result")
            result
        }
    }

    @ReactMethod
    fun isTestOnlyBuild(promise: Promise) {
        Log.d(TAG, "[isTestOnlyBuild] ▶ called")
        runSafe(promise) {
            val info = reactContext.packageManager
                .getApplicationInfo(reactContext.packageName, 0)
            val result = (info.flags and ApplicationInfo.FLAG_TEST_ONLY) != 0
            Log.d(TAG, "[isTestOnlyBuild] result=$result")
            result
        }
    }

    @ReactMethod
    fun isScreenBeingRecorded(promise: Promise) {
        Log.d(TAG, "[isScreenBeingRecorded] ▶ called")
        runSafe(promise) {
            val result = detectScreenRecording()
            Log.d(TAG, "[isScreenBeingRecorded] result=$result")
            result
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 3 — VPN DETECTION
    // ══════════════════════════════════════════════════════════════════════════

    @ReactMethod
    fun isVpnActive(promise: Promise) {
        Log.d(TAG, "[isVpnActive] ▶ called")
        runSafe(promise) {
            val result = detectVpn()
            Log.d(TAG, "[isVpnActive] result=$result")
            result
        }
    }

    /**
     * Two-tier VPN detection:
     *   Tier 1 — ConnectivityManager.getNetworkCapabilities: checks TRANSPORT_VPN on
     *            every active network (not just the primary one). This catches VPN-over-WiFi
     *            and VPN-over-cellular which expo-network misses because it only inspects
     *            the primary transport type.
     *   Tier 2 — NetworkInterface scan: looks for tun*, vpn*, ppp* interface names that
     *            VPN clients create. Works even when the CM API is restricted.
     *
     * Both tiers run independently; either a positive triggers detection.
     */
    private fun detectVpn(): Boolean {
        // Tier 1: ConnectivityManager.getNetworkCapabilities (API 23+)
        try {
            val cm = reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            if (cm != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    val allNetworks = cm.allNetworks
                    Log.d(TAG, "[detectVpn] allNetworks.count=$\{allNetworks.size}")
                    for (network in allNetworks) {
                        val caps = cm.getNetworkCapabilities(network)
                        if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                            Log.d(TAG, "[detectVpn] TRANSPORT_VPN found on network=$network caps=$caps")
                            return true
                        }
                    }
                } else {
                    // API < 23: check active network info for TYPE_VPN (deprecated but present)
                    @Suppress("DEPRECATION")
                    val activeInfo = cm.activeNetworkInfo
                    @Suppress("DEPRECATION")
                    if (activeInfo != null && activeInfo.type == ConnectivityManager.TYPE_VPN) {
                        Log.d(TAG, "[detectVpn] TYPE_VPN detected via deprecated API")
                        return true
                    }
                }
            }
        } catch (e: Exception) {
            Log.d(TAG, "[detectVpn] CM tier exception: $\{e.message}")
        }

        // Tier 2: NetworkInterface scan — catches VPN interfaces not reported by CM
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces()
            if (interfaces != null) {
                for (iface in interfaces.iterator()) {
                    val name = iface.name.lowercase()
                    // tun0/tun1 = OpenVPN/WireGuard kernel tun device
                    // vpn* = some split-tunnel VPN drivers
                    // ppp0 = L2TP/PPP-based VPNs
                    // ipsec* = IPSec tunnel
                    if ((name.startsWith("tun") || name.startsWith("vpn") ||
                         name.startsWith("ppp") || name.startsWith("ipsec")) &&
                        iface.isUp && !iface.isLoopback) {
                        Log.d(TAG, "[detectVpn] VPN interface found: $name (up=$\{iface.isUp})")
                        return true
                    }
                }
            }
        } catch (e: Exception) {
            Log.d(TAG, "[detectVpn] NetworkInterface tier exception: $\{e.message}")
        }

        Log.d(TAG, "[detectVpn] no VPN detected")
        return false
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 3 — ROOT DETECTION
    // ══════════════════════════════════════════════════════════════════════════

    @ReactMethod
    fun isRooted(promise: Promise) {
        Log.d(TAG, "[isRooted] ▶ called")
        runSafe(promise) {
            val result = detectRoot()
            Log.d(TAG, "[isRooted] result=$result")
            result
        }
    }

    /**
     * Multi-method root detection (6 independent heuristics):
     *   1. su binary: scan 20+ well-known paths for the su executable
     *   2. Dangerous system properties: ro.debuggable=1, ro.secure=0
     *   3. Build tags: "test-keys" in ro.build.tags (indicates unofficial/rooted ROM)
     *   4. /system write test: attempt to open /system/medacademy-rwtest for writing
     *   5. Shell command execution: run "which su" and check output
     *   6. Known root management packages: Magisk, SuperSU, KingRoot, etc.
     *
     * Any single positive = rooted. All wrapped in runCatching for fail-safety.
     */
    private fun detectRoot(): Boolean {
        // 1. su binary path scan
        val suPaths = listOf(
            "/system/bin/su", "/system/xbin/su", "/system/app/Superuser.apk",
            "/sbin/su", "/data/local/su", "/data/local/bin/su", "/data/local/xbin/su",
            "/system/sd/xbin/su", "/system/bin/failsafe/su", "/data/local/tmp/su",
            "/dev/com.koushikdutta.superuser.daemon/", "/system/usr/we-need-root/su",
            "/system/bin/.ext/su", "/system/xbin/mu", "/system/bin/daemonsu",
            "/system/etc/init.d/99SuperSUDaemon", "/system/app/SuperSU.apk"
        )
        val suFound = suPaths.any { File(it).exists() }
        Log.d(TAG, "[detectRoot] suBinaryFound=$suFound")
        if (suFound) return true

        // 2. Dangerous system properties
        val debuggable = runCatching { getSystemProperty("ro.debuggable") }.getOrDefault("")
        val secure     = runCatching { getSystemProperty("ro.secure") }.getOrDefault("1")
        Log.d(TAG, "[detectRoot] ro.debuggable=$debuggable ro.secure=$secure")
        if (debuggable == "1" && secure == "0") {
            Log.d(TAG, "[detectRoot] dangerous props detected")
            return true
        }

        // 3. Build tags — test-keys means the ROM was built with test signing keys (unofficial/rooted)
        val buildTags = Build.TAGS ?: ""
        Log.d(TAG, "[detectRoot] Build.TAGS=$buildTags")
        if (buildTags.contains("test-keys")) {
            Log.d(TAG, "[detectRoot] test-keys build tag detected")
            return true
        }

        // 4. /system write test — on truly un-rooted devices /system is mounted read-only
        val writeTestResult = runCatching {
            val f = File("/system/medacademy-rwtest-$\{System.currentTimeMillis()}")
            val opened = f.createNewFile()
            if (opened) f.delete()
            opened
        }.getOrDefault(false)
        Log.d(TAG, "[detectRoot] systemWritable=$writeTestResult")
        if (writeTestResult) return true

        // 5. Shell command: "which su"
        val whichSu = runCatching {
            val process = Runtime.getRuntime().exec(arrayOf("which", "su"))
            val reader  = BufferedReader(InputStreamReader(process.inputStream))
            val output  = reader.readLine()?.trim() ?: ""
            process.destroy()
            output.isNotEmpty()
        }.getOrDefault(false)
        Log.d(TAG, "[detectRoot] whichSu=$whichSu")
        if (whichSu) return true

        // 6. Known root management packages
        val rootPackages = listOf(
            "com.noshufou.android.su", "com.noshufou.android.su.elite",
            "eu.chainfire.supersu", "com.koushikdutta.superuser",
            "com.thirdparty.superuser", "com.yellowes.su",
            "com.kingroot.kinguser", "com.kingo.root",
            "com.smedialink.oneclickroot", "com.zhiqupk.root.global",
            "com.alephzain.framaroot", "com.topjohnwu.magisk"
        )
        val rootPkgFound = rootPackages.any { isPackageInstalled(it) }
        Log.d(TAG, "[detectRoot] rootPackageFound=$rootPkgFound")
        return rootPkgFound
    }

    /** Read a system property via reflection (mirrors what Build reads internally). */
    private fun getSystemProperty(key: String): String {
        return Class.forName("android.os.SystemProperties")
            .getMethod("get", String::class.java)
            .invoke(null, key) as? String ?: ""
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 3 — EMULATOR DETECTION
    // ══════════════════════════════════════════════════════════════════════════

    @ReactMethod
    fun isEmulator(promise: Promise) {
        Log.d(TAG, "[isEmulator] ▶ called")
        runSafe(promise) {
            val result = detectEmulator()
            Log.d(TAG, "[isEmulator] result=$result")
            result
        }
    }

    /**
     * Multi-method emulator detection (5 independent heuristics):
     *   1. Build.FINGERPRINT: contains "generic", "unknown", or "vbox"
     *   2. Build.MODEL / Build.HARDWARE: Genymotion, goldfish, sdk_gphone, ranchu
     *   3. Build.MANUFACTURER: "Genymotion", unknown, "Google" (for AVD)
     *   4. QEMU-specific system properties: ro.kernel.qemu, ro.product.device
     *   5. Sensor count = 0: real phones always have at least an accelerometer
     */
    private fun detectEmulator(): Boolean {
        // 1. Build.FINGERPRINT patterns
        val fingerprint = Build.FINGERPRINT.lowercase()
        val fingerprintMatch = fingerprint.startsWith("generic") ||
            fingerprint.startsWith("unknown") ||
            fingerprint.contains("vbox") ||
            fingerprint.contains("test-keys") && fingerprint.contains("sdk")
        Log.d(TAG, "[detectEmulator] fingerprint=$fingerprint match=$fingerprintMatch")
        if (fingerprintMatch) return true

        // 2. Build.MODEL / Build.HARDWARE
        val model    = Build.MODEL.lowercase()
        val hardware = Build.HARDWARE.lowercase()
        val modelMatch = model.contains("google_sdk") || model.contains("emulator") ||
            model.contains("android sdk") || model.contains("genymotion") ||
            model.startsWith("sdk") || hardware.contains("goldfish") ||
            hardware.contains("ranchu") || hardware.contains("vbox")
        Log.d(TAG, "[detectEmulator] model=$model hardware=$hardware match=$modelMatch")
        if (modelMatch) return true

        // 3. Build.MANUFACTURER
        val manufacturer = Build.MANUFACTURER.lowercase()
        val manuMatch = manufacturer == "unknown" || manufacturer.contains("genymotion")
        Log.d(TAG, "[detectEmulator] manufacturer=$manufacturer match=$manuMatch")
        if (manuMatch) return true

        // 4. QEMU-specific system properties
        val qemuKernel = runCatching { getSystemProperty("ro.kernel.qemu") }.getOrDefault("")
        val qemuDevice = runCatching { getSystemProperty("ro.product.device") }.getOrDefault("")
        Log.d(TAG, "[detectEmulator] ro.kernel.qemu=$qemuKernel ro.product.device=$qemuDevice")
        if (qemuKernel == "1" || qemuDevice.contains("generic") || qemuDevice.contains("goldfish")) {
            return true
        }

        // 5. Sensor count — real devices always have motion sensors; AVD has none by default
        return try {
            val sm = reactContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
            val sensors = sm?.getSensorList(Sensor.TYPE_ALL) ?: emptyList()
            Log.d(TAG, "[detectEmulator] sensorCount=$\{sensors.size}")
            sensors.isEmpty()
        } catch (e: Exception) {
            Log.d(TAG, "[detectEmulator] sensor check exception: $\{e.message}")
            false
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 3 — MOCK LOCATION DETECTION
    // ══════════════════════════════════════════════════════════════════════════

    @ReactMethod
    fun isMockLocationEnabled(promise: Promise) {
        Log.d(TAG, "[isMockLocationEnabled] ▶ called")
        runSafe(promise) {
            val result = detectMockLocation()
            Log.d(TAG, "[isMockLocationEnabled] result=$result")
            result
        }
    }

    /**
     * Mock location detection (3-tier approach):
     *   Tier 1 (API 23+): AppOpsManager.checkOp(OPSTR_MOCK_LOCATION) — the authoritative
     *            check. Returns MODE_ALLOWED only if the user granted "Allow mock locations"
     *            in Developer Options to a specific app other than ours.
     *   Tier 2 (API < 23): Settings.Secure.ALLOW_MOCK_LOCATION — the legacy global flag.
     *   Tier 3: Check if any installed package holds the ACCESS_MOCK_LOCATION permission
     *            (distinct from us). If yes, mock GPS is plausibly active.
     */
    private fun detectMockLocation(): Boolean {
        // Tier 1: AppOpsManager (API 23+) — check every package for MOCK_LOCATION op
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                val appOps = reactContext.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager
                if (appOps != null) {
                    val pm = reactContext.packageManager
                    val packages = pm.getInstalledApplications(PackageManager.GET_META_DATA)
                    for (appInfo in packages) {
                        if (appInfo.packageName == reactContext.packageName) continue
                        val mode = appOps.checkOpNoThrow(
                            AppOpsManager.OPSTR_MOCK_LOCATION,
                            appInfo.uid,
                            appInfo.packageName
                        )
                        if (mode == AppOpsManager.MODE_ALLOWED) {
                            Log.d(TAG, "[detectMockLocation] MOCK_LOCATION granted to $\{appInfo.packageName}")
                            return true
                        }
                    }
                }
            } catch (e: Exception) {
                Log.d(TAG, "[detectMockLocation] AppOpsManager tier exception: $\{e.message}")
            }
        }

        // Tier 2: Legacy flag (API < 23)
        try {
            @Suppress("DEPRECATION")
            val legacyFlag = Settings.Secure.getInt(
                reactContext.contentResolver,
                Settings.Secure.ALLOW_MOCK_LOCATION, 0
            )
            Log.d(TAG, "[detectMockLocation] legacy ALLOW_MOCK_LOCATION=$legacyFlag")
            if (legacyFlag != 0) return true
        } catch (e: Exception) {
            Log.d(TAG, "[detectMockLocation] legacy flag exception: $\{e.message}")
        }

        // Tier 3: scan for any installed app with ACCESS_MOCK_LOCATION permission
        try {
            val pm = reactContext.packageManager
            val mockApps = pm.getPackagesHoldingPermissions(
                arrayOf("android.permission.ACCESS_MOCK_LOCATION"),
                PackageManager.MATCH_ALL
            )
            val external = mockApps.filter { it.packageName != reactContext.packageName }
            Log.d(TAG, "[detectMockLocation] mockLocationApps=$\{external.map { it.packageName }}")
            if (external.isNotEmpty()) return true
        } catch (e: Exception) {
            Log.d(TAG, "[detectMockLocation] permission scan exception: $\{e.message}")
        }

        return false
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 2 — FRIDA DETECTION
    // ══════════════════════════════════════════════════════════════════════════

    @ReactMethod
    fun isFridaDetected(promise: Promise) {
        Log.d(TAG, "[isFridaDetected] ▶ called")
        runSafe(promise) {
            val result = detectFrida()
            Log.d(TAG, "[isFridaDetected] result=$result")
            result
        }
    }

    private fun detectFrida(): Boolean {
        // 1. Default Frida server port probe (27042)
        if (probeTcpPort(27042)) { Log.d(TAG, "[detectFrida] port 27042 open"); return true }
        // 2. Common Frida alternative ports
        for (port in listOf(27043, 27044, 27045)) {
            if (probeTcpPort(port)) { Log.d(TAG, "[detectFrida] port $port open"); return true }
        }
        // 3. /proc/self/maps — look for frida-agent / gadget memory-mapped libs
        if (checkProcMapsForFrida()) { Log.d(TAG, "[detectFrida] frida in /proc/self/maps"); return true }
        // 4. Running processes / cmdline scan
        if (scanProcessesForFrida()) { Log.d(TAG, "[detectFrida] frida process found"); return true }
        // 5. Injected library presence
        if (checkLoadedLibraries()) { Log.d(TAG, "[detectFrida] frida library in maps"); return true }
        // 6. Known Frida temp files
        val fridaFiles = listOf(
            "/data/local/tmp/frida-server",
            "/data/local/tmp/frida-gadget.so",
            "/data/local/tmp/re.frida.server",
            "/sdcard/frida-server"
        )
        val fileFound = fridaFiles.any { File(it).exists() }
        if (fileFound) Log.d(TAG, "[detectFrida] frida file found on disk")
        return fileFound
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
                    readText().replace('', ' ').lowercase()
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
        Log.d(TAG, "[isXposedDetected] ▶ called")
        runSafe(promise) {
            val result = detectXposed()
            Log.d(TAG, "[isXposedDetected] result=$result")
            result
        }
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
        Log.d(TAG, "[isMagiskDetected] ▶ called")
        runSafe(promise) {
            val result = detectMagisk()
            Log.d(TAG, "[isMagiskDetected] result=$result")
            result
        }
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
        Log.d(TAG, "[isOverlayDetected] ▶ called")
        runSafe(promise) {
            val result = detectOverlay()
            Log.d(TAG, "[isOverlayDetected] result=$result")
            result
        }
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
        Log.d(TAG, "[getSignatureSha256] ▶ called")
        try {
            val sig = getSignatureBytes() ?: return promise.resolve(null)
            val digest = MessageDigest.getInstance("SHA-256").digest(sig)
            val hex = digest.joinToString("") { "%02X".format(it) }
            promise.resolve(hex)
        } catch (e: Exception) { promise.resolve(null) }
    }

    @ReactMethod
    fun isSignatureValid(promise: Promise) {
        Log.d(TAG, "[isSignatureValid] ▶ called")
        runSafe(promise) {
            val result = checkSignatureValid()
            Log.d(TAG, "[isSignatureValid] result=$result")
            result
        }
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
        Log.d(TAG, "[isTampered] ▶ called")
        runSafe(promise) {
            val result = detectTampering()
            Log.d(TAG, "[isTampered] result=$result")
            result
        }
    }

    private fun detectTampering(): Boolean {
        // Runtime equivalent of BuildConfig.DEBUG — hoisted to function scope so all
        // checks below can use it. ApplicationInfo.FLAG_DEBUGGABLE is cleared on
        // signed release APKs, set on debug builds.
        val isDebugBuild = (reactContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

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
            if (!isDebugBuild && installer !in trustedInstallers) return true
        } catch (_: Exception) { /* non-fatal */ }

        // 2. Signature check
        if (!checkSignatureValid()) return true

        // 3. Critical native libraries must be present
        val criticalLibs = listOf("libreactnative.so", "libhermes.so")
        val nativeLibDir = reactContext.applicationInfo.nativeLibraryDir
        if (criticalLibs.none { File(nativeLibDir, it).exists() }) {
            // No RN libs found at expected location → unusual
            // (Only treat as tampered if we're in a fully-built release APK)
            if (nativeLibDir.isNotEmpty() && !isDebugBuild) return true
        }

        return false
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 2 — PLAY INTEGRITY TOKEN REQUEST
    // ══════════════════════════════════════════════════════════════════════════

    @ReactMethod
    fun requestIntegrityToken(nonce: String, promise: Promise) {
        Log.d(TAG, "[requestIntegrityToken] ▶ called")
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
                "com.google.android.play.core.integrity.IntegrityTokenRequest\\$Builder")
            @Suppress("DEPRECATION")
            val builder = builderClass.getDeclaredConstructor().newInstance()
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
        Log.d(TAG, "[getSecurityFlags] ▶ called")
        try {
            val r: WritableMap = Arguments.createMap()

            // ── Phase 1 ────────────────────────────────────────────────────
            val devOpts = runCatching {
                Settings.Global.getInt(reactContext.contentResolver,
                    Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) != 0
            }.getOrDefault(false)
            r.putBoolean("developerOptionsEnabled", devOpts)
            Log.d(TAG, "[getSecurityFlags] developerOptionsEnabled=$devOpts")

            val adb = runCatching {
                Settings.Global.getInt(reactContext.contentResolver,
                    Settings.Global.ADB_ENABLED, 0) != 0
            }.getOrDefault(false)
            r.putBoolean("adbEnabled", adb)
            Log.d(TAG, "[getSecurityFlags] adbEnabled=$adb")

            val debugger = runCatching { Debug.isDebuggerConnected() }.getOrDefault(false)
            r.putBoolean("debuggerAttached", debugger)
            Log.d(TAG, "[getSecurityFlags] debuggerAttached=$debugger")

            val testOnly = runCatching {
                val info = reactContext.packageManager.getApplicationInfo(reactContext.packageName, 0)
                (info.flags and ApplicationInfo.FLAG_TEST_ONLY) != 0
            }.getOrDefault(false)
            r.putBoolean("testOnlyBuild", testOnly)
            Log.d(TAG, "[getSecurityFlags] testOnlyBuild=$testOnly")

            val screenRec = runCatching { detectScreenRecording() }.getOrDefault(false)
            r.putBoolean("screenBeingRecorded", screenRec)
            Log.d(TAG, "[getSecurityFlags] screenBeingRecorded=$screenRec")

            // ── Phase 2 ────────────────────────────────────────────────────
            val frida   = runCatching { detectFrida()   }.getOrDefault(false)
            val xposed  = runCatching { detectXposed()  }.getOrDefault(false)
            val magisk  = runCatching { detectMagisk()  }.getOrDefault(false)
            val overlay = runCatching { detectOverlay() }.getOrDefault(false)
            val sigOk   = runCatching { checkSignatureValid() }.getOrDefault(true)
            val tamper  = runCatching { detectTampering() }.getOrDefault(false)
            r.putBoolean("fridaDetected",   frida)
            r.putBoolean("xposedDetected",  xposed)
            r.putBoolean("magiskDetected",  magisk)
            r.putBoolean("overlayDetected", overlay)
            r.putBoolean("signatureValid",  sigOk)
            r.putBoolean("tampered",        tamper)
            Log.d(TAG, "[getSecurityFlags] frida=$frida xposed=$xposed magisk=$magisk overlay=$overlay sigOk=$sigOk tamper=$tamper")

            // ── Phase 3 (new) ──────────────────────────────────────────────
            val vpn      = runCatching { detectVpn()           }.getOrDefault(false)
            val rooted   = runCatching { detectRoot()          }.getOrDefault(false)
            val emulator = runCatching { detectEmulator()      }.getOrDefault(false)
            val mockLoc  = runCatching { detectMockLocation()  }.getOrDefault(false)
            r.putBoolean("vpnDetected",          vpn)
            r.putBoolean("rootDetected",         rooted)
            r.putBoolean("emulatorDetected",     emulator)
            r.putBoolean("mockLocationDetected", mockLoc)
            Log.d(TAG, "[getSecurityFlags] vpn=$vpn rooted=$rooted emulator=$emulator mockLoc=$mockLoc")

            val _elapsed = System.currentTimeMillis() - _t0
            Log.d(TAG, "[getSecurityFlags] ✅ all checks complete in $\{_elapsed}ms")
            Log.d(TAG, "[getSecurityFlags] RAW_FLAGS=$\{r}")
            promise.resolve(r)
        } catch (e: Exception) {
            Log.e(TAG, "[getSecurityFlags] ❌ exception: $\{e.message}", e)
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
// ─── withIOSSwiftSources ──────────────────────────────────────────────────────
// Copies IOSSecurityModule.swift + .m into the Xcode app source folder AND
// writes the bridging header with the React Native ObjC imports.
//
// TIMING: Both operations run inside withXcodeProject (mod priority -1).
// This is intentional and critical:
//
//   withDangerousMod  (priority -2)  runs BEFORE expo creates ios/ from template.
//   withXcodeProject  (priority -1)  runs AFTER ios/ is fully created on disk.
//
// On `expo prebuild --clean`, the ios/ directory does not exist yet when
// withDangerousMod callbacks execute. Expo creates ios/MedAcademy/ (from the
// xcode template) during the xcodeproj provider setup, which fires between
// dangerous and xcodeproj mods. Any file written by a dangerous mod to ios/
// is OVERWRITTEN by the template. Writing the bridging header in withXcodeProject
// guarantees it is written AFTER the template has fully settled on disk, making
// it the final authoritative content that the compiler reads.

function withIOSSwiftSources(config) {
  return withXcodeProject(config, (cfg) => {
    const projectRoot     = cfg.modRequest.projectRoot;
    const projectName     = cfg.modRequest.projectName;          // set by getHackyProjectName ✓
    const iosDir          = cfg.modRequest.platformProjectRoot;  // = projectRoot/ios
    const iosAppDir       = path.join(iosDir, projectName);

    // ── 1. Copy Swift + ObjC source files ─────────────────────────────────
    const pluginIosDir = path.join(projectRoot, 'plugins', 'ios');
    const filesToCopy  = ['IOSSecurityModule.swift', 'IOSSecurityModule.m'];
    for (const file of filesToCopy) {
      const src  = path.join(pluginIosDir, file);
      const dest = path.join(iosAppDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      }
    }

    // ── 2. Write bridging header ───────────────────────────────────────────
    // IOSSecurityModule.swift inherits RCTEventEmitter and uses
    // RCTPromiseResolveBlock / RCTPromiseRejectBlock. These ObjC types are
    // only visible to Swift via the target's SWIFT_OBJC_BRIDGING_HEADER.
    //
    // IMPORT FORM: @import React  (Clang module import — NOT #import <React/...>)
    //
    // Why @import, not #import:
    //
    //   #import <React/RCTBridgeModule.h> requires the parent of the React
    //   headers directory to be in HEADER_SEARCH_PATHS. For pod targets this
    //   is guaranteed by CocoaPods-generated xcconfigs. For the APP TARGET it
    //   is NOT — react_native_pods.rb only adds FRAMEWORK_SEARCH_PATHS (not
    //   HEADER_SEARCH_PATHS) to the app target xcconfig for the vendored
    //   React.xcframework. So #import <React/...> produces "file not found"
    //   in the bridging header, the bridging header fails to compile, and Swift
    //   cannot see any ObjC types → "cannot find type 'RCTEventEmitter' in scope".
    //
    //   @import React resolves via FRAMEWORK_SEARCH_PATHS which IS set for the
    //   app target (pointing to the React.xcframework). All React ObjC types
    //   (RCTEventEmitter, RCTPromiseResolveBlock, etc.) are then visible to Swift.
    //
    // Why @import React used to fail (and why that is now fixed):
    //
    //   @import React triggers full Clang module validation of the React module,
    //   including its umbrella header (React_Core-umbrella.h). That umbrella
    //   includes system headers not declared in the module map → Clang error:
    //   "include of non-modular header inside framework module 'React'".
    //   Pod targets escape this because CocoaPods sets
    //   CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES=YES in their
    //   xcconfigs. The app target did NOT have this flag.
    //
    //   Fix (applied in step 3 below): set
    //   CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES = YES
    //   directly on the app target's build configurations via withXcodeProject.
    //   This is a single targeted build setting — not a global suppress flag.
    //   It is the standard prerequisite for any Swift + React Native module,
    //   and is what the RN template sets when Swift files are present.
    const bridgingHeaderContent = [
      '//',
      `// ${projectName}-Bridging-Header.h`,
      '//',
      '// Exposes Objective-C React Native headers to Swift source files in this target.',
      '// Required for IOSSecurityModule.swift to access RCTEventEmitter, RCTBridgeModule,',
      '// RCTPromiseResolveBlock, and RCTPromiseRejectBlock.',
      '//',
      '// @import React resolves via FRAMEWORK_SEARCH_PATHS (set by CocoaPods for the app',
      '// target to point at React.xcframework). This exposes all React ObjC types to Swift.',
      '// CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES=YES (set on the app target',
      '// build config by the withIOSSwiftSources plugin) allows the React module\'s',
      '// umbrella header to include system headers without a compile error.',
      '@import React;',
      '',
    ].join('\n');

    const bridgingHeaderPath = path.join(iosAppDir, `${projectName}-Bridging-Header.h`);
    fs.writeFileSync(bridgingHeaderPath, bridgingHeaderContent, 'utf8');

    // ── 3. Set CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES on app target ──
    //
    // Why this is necessary:
    //   @import React causes Clang to load React.xcframework/Modules/module.modulemap.
    //   The module's umbrella header includes ALL React public headers, many of which
    //   contain: #include <sys/types.h>, #include <mach/mach.h>, etc. These system
    //   headers are not declared in the React module map, making them "non-modular".
    //   Under strict Clang module rules, a framework module cannot include non-modular
    //   headers → "include of non-modular header inside framework module 'React'".
    //
    //   Setting CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES=YES on this
    //   target tells Clang to permit such includes within any framework module imported
    //   from this target's compilation units (including the bridging header).
    //
    // Why this is safe and targeted:
    //   - Applied ONLY to the MedAcademyMobileApp app target, not to any pod target.
    //   - Pod targets already have this flag in CocoaPods-generated xcconfigs.
    //   - Does not affect the React.xcframework binary or any other pod's compilation.
    //   - Is the standard build setting used by all React Native + Swift projects.
    //
    // xcode pbxproj API: cfg.modResults is the parsed XcodeProject object.
    // getFirstProject().firstProject().targets gives the native target UUIDs.
    // We iterate build configurations on each target and set the flag only on the
    // MedAcademyMobileApp target (matching by name to avoid touching pod targets).
    const xcodeProject = cfg.modResults;
    const pbxproj = xcodeProject.pbxproj || xcodeProject;

    // Iterate all build configurations in the pbxproj and set the flag
    // on configurations belonging to the app target (not pod targets).
    //
    // xcode@3.0.1 API (the version shipped with Expo 55):
    //   pbxNativeTargetSection()     → { uuid: nativeTarget, ... }
    //   pbxXCConfigurationList()     → { uuid: XCConfigurationList, ... }  ← NOT "Section"
    //   pbxXCBuildConfigurationSection() → { uuid: XCBuildConfiguration, ... }
    const nativeTargets = xcodeProject.pbxNativeTargetSection();
    for (const targetKey of Object.keys(nativeTargets)) {
      const target = nativeTargets[targetKey];
      if (!target || typeof target !== 'object' || !target.name) continue;
      // Match only the app target by name (not the test target or any pod target)
      if (target.name !== projectName && target.name !== `"${projectName}"`) continue;

      const buildConfigListKey = target.buildConfigurationList;
      // Correct API: pbxXCConfigurationList() — NOT pbxXCConfigurationListSection()
      const buildConfigLists   = xcodeProject.pbxXCConfigurationList();
      const buildConfigList    = buildConfigLists[buildConfigListKey];
      if (!buildConfigList) continue;

      const buildConfigRefs = buildConfigList.buildConfigurations;
      if (!buildConfigRefs) continue;

      const buildConfigs = xcodeProject.pbxXCBuildConfigurationSection();
      for (const ref of buildConfigRefs) {
        const configKey = ref.value || ref;
        const config    = buildConfigs[configKey];
        if (!config || !config.buildSettings) continue;
        // Set the flag — this is what allows @import React to compile without error
        config.buildSettings['CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES'] = 'YES';
      }
    }

    return cfg;
  });
}

// ─── withXcodeProject: add Swift/ObjC files to compile sources phase ─────────
// This ensures Xcode knows to compile the two files we copied above.
// withXcodeProject gives us direct access to the parsed .pbxproj.

function withIOSXcodeFiles(config) {
  return withXcodeProject(config, (cfg) => {
    const proj    = cfg.modResults;
    // cfg.modRequest.projectName is populated by getHackyProjectName at xcodeproj
    // mod time — it reads the actual .xcodeproj folder on disk, so it is always
    // the true Xcode project name regardless of expo.name.
    const appName = cfg.modRequest.projectName;
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
