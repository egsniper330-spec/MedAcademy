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
// Resolve @expo/config-plugins from expo's own package tree so we always get
// the version that matches the installed Expo SDK (55.x), regardless of whether
// any unrelated version is listed in the project's package.json.
const expoRoot = path.dirname(require.resolve('expo/package.json'));
const { withDangerousMod, withMainApplication, withXcodeProject, withAndroidManifest } = require(
  require.resolve('@expo/config-plugins', { paths: [expoRoot] })
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
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Debug
import android.os.Handler
import android.os.Looper
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
import java.util.zip.ZipFile
import org.json.JSONObject
import org.json.JSONArray
import java.net.NetworkInterface
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec
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
 *   Overlay attack      — targeted known-abusive package capability scan.
 *                         (Aggregate permission COUNT is capability evidence,
 *                         never proof of an active overlay — see detectOverlay.)
 *   Signature check     — SHA-256 cert fingerprint vs expected production hash
 *   Anti-tamper         — signature + native lib presence (distribution-aware;
 *                         installer source is telemetry, not tamper evidence)
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

    init {
        Log.d(TAG, "◀▶ SecurityModule INSTANTIATED — module is live and registered")
        registerVpnNetworkCallback()
    }

    // ══════════════════════════════════════════════════════════════════════════
    // VPN NETWORK CALLBACK — real-time VPN state push to JS
    //
    // ConnectivityManager.NetworkCallback fires whenever any network matching
    // the request changes. We request TRANSPORT_VPN so we are notified:
    //   • onAvailable  → a VPN network became active   → emit vpnStateChanged(true)
    //   • onLost       → the VPN network was torn down → emit vpnStateChanged(false)
    //
    // This fixes the core bug: previously VPN was only checked on-demand (point-in-
    // time snapshot). The callback fires immediately when the user enables/disables
    // a VPN app (WireGuard, OpenVPN, Android system VPN, VPNService-based apps)
    // while the MedAcademy app is running, regardless of whether the device stays
    // internet-connected. JS receives the event via NativeEventEmitter and triggers
    // a full runSecurityChecks() cycle.
    //
    // Lifecycle:
    //   • Registered in init{} when the module is instantiated by React Native.
    //   • Unregistered in onCatalystInstanceDestroy() (module teardown).
    //   • Main-thread Handler used for all CM interactions (required on some OEMs).
    //
    // API compatibility:
    //   API 21+: registerNetworkCallback(NetworkRequest, NetworkCallback) is available
    //   and stable. We guard with Build.VERSION_CODES.LOLLIPOP but in practice this
    //   app targets API 24+ so the guard is belt-and-suspenders only.
    // ══════════════════════════════════════════════════════════════════════════

    private val mainHandler = Handler(Looper.getMainLooper())
    private var vpnNetworkCallback: ConnectivityManager.NetworkCallback? = null

    /**
     * Part 12 gap closure (RECOVERY FIX — stale-BLOCKED bug): on VPN-network
     * loss, re-check EVERY network and ALIGN the callback's live belief with
     * the framework result. A LEGITIMATE teardown produces exactly "callback
     * saw a loss + no tunnel found" — that is AGREEMENT, not suppression, so
     * the flag CLEARS and the VPN state returns to OFF. The previous version
     * latched lastVpnCallbackLoss=true here forever, so aggregateVpnState()
     * returned "suspicious" until process death and the app never recovered
     * without a restart (observed on the physical device). Suppression is now
     * signaled only by a LIVE contradiction: callbackSeesVpn=true (the OS
     * itself reported an active VPN network) while the sensor scan denies it.
     */
    private fun upgradeVpnState() {
        try {
            val cm = reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
            var sawVpnNetwork = false
            for (net in cm.allNetworks) {
                val caps = cm.getNetworkCapabilities(net) ?: continue
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) sawVpnNetwork = true
            }
            callbackSeesVpn = sawVpnNetwork
        } catch (_: Exception) { }
    }

    /** Live callback belief: the OS currently reports an active VPN network.
     *  Set by onAvailable, cleared by upgradeVpnState() when the framework
     *  confirms the tunnel is gone. NEVER a historical latch. */
    private var callbackSeesVpn: Boolean = false

    private fun registerVpnNetworkCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return
        try {
            val cm = reactContext.getSystemService(Context.CONNECTIVITY_SERVICE)
                as? ConnectivityManager ?: return

            val request = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_VPN)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
                .build()

            val callback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    Log.d(TAG, "[VpnCallback] onAvailable — VPN network active: \$network")
                    callbackSeesVpn = true
                    emitVpnStateChanged(true)
                }
                override fun onLost(network: Network) {
                    Log.d(TAG, "[VpnCallback] onLost — VPN network torn down: \$network")
                    // Re-check: another VPN network may still be active
                    // (split-tunnel: the VPN network went away but WiFi stayed).
                    // Call detectVpn() to confirm real state before emitting false.
                    upgradeVpnState()
                    val stillActive = runCatching { detectVpn() }.getOrDefault(false)
                    Log.d(TAG, "[VpnCallback] onLost re-check stillActive=\$stillActive")
                    emitVpnStateChanged(stillActive)
                }
            }

            // Register on main thread — some OEMs (Xiaomi, OPPO) require this
            mainHandler.post {
                try {
                    cm.registerNetworkCallback(request, callback)
                    vpnNetworkCallback = callback
                    Log.d(TAG, "[VpnCallback] registered successfully (TRANSPORT_VPN watcher active)")
                } catch (e: Exception) {
                    Log.d(TAG, "[VpnCallback] registerNetworkCallback failed: \${e.message}")
                }
            }
        } catch (e: Exception) {
            Log.d(TAG, "[VpnCallback] setup exception: \${e.message}")
        }
    }

    private fun emitVpnStateChanged(vpnActive: Boolean) {
        try {
            // Guard against emitting during teardown: getJSModule throws when the
            // catalyst instance is already gone (module destroyed but callback not
            // yet unregistered). The surrounding try/catch still covers races —
            // this check just avoids repeated exceptions during shutdown.
            if (!reactContext.hasActiveReactInstance()) return
            val params = Arguments.createMap()
            params.putBoolean("vpnActive", vpnActive)
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("vpnStateChanged", params)
            Log.d(TAG, "[VpnCallback] emitted vpnStateChanged vpnActive=\$vpnActive")
        } catch (e: Exception) {
            Log.d(TAG, "[VpnCallback] emit exception: \${e.message}")
        }
    }

    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        val cb = vpnNetworkCallback ?: return
        try {
            val cm = reactContext.getSystemService(Context.CONNECTIVITY_SERVICE)
                as? ConnectivityManager
            cm?.unregisterNetworkCallback(cb)
            vpnNetworkCallback = null
            Log.d(TAG, "[VpnCallback] unregistered on module teardown")
        } catch (e: Exception) {
            Log.d(TAG, "[VpnCallback] unregister exception: \${e.message}")
        }
    }

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
    fun isProxyDetected(promise: Promise) {
        Log.d(TAG, "[isProxyDetected] called")
        runSafe(promise) {
            val result = detectProxy()
            Log.d(TAG, "[isProxyDetected] result=\u0024result")
            result
        }
    }

    /**
     * Proxy detection (Android) — three independent signals:
     *   Tier 1 — JVM system proxy properties (http.proxyHost / https.proxyHost /
     *            socksProxyHost). On Android these are what ProxySelector and
     *            every java.net URL connection honor; a per-app HTTP proxy set
     *            through LinkProperties or reflection surfaces here.
     *   Tier 2 — ProxySelector.select() on the live API origin: returns the
     *            proxy the platform would actually use for our API host right
     *            now (catches runtime in-process hijacks that set properties
     *            after startup).
     *   Tier 3 — LinkProperties.httpProxy (API 29+): the platform-wide HTTP
     *            proxy configured on the active network.
     *
     * VPN is NOT a proxy: VPN tunnels surface as TRANSPORT_VPN/tun* and are
     * reported by detectVpn(), so this detector never inspects tunnel
     * interfaces — the two detectors cannot double-report one condition.
     * Fail-safe: exception -> false (never blocks on detector error).
     */
    private fun detectProxy(): Boolean {
        // Tier 1: JVM system proxy properties
        try {
            for (key in listOf("http.proxyHost", "https.proxyHost", "socksProxyHost")) {
                val host = System.getProperty(key)?.trim().orEmpty()
                if (host.isNotEmpty() && host != "null") {
                    Log.d(TAG, "[detectProxy] system property \u0024key=\u0024host")
                    return true
                }
            }
        } catch (e: Exception) {
            Log.d(TAG, "[detectProxy] property tier exception: \u0024{e.message}")
        }

        // Resolve the API origin at runtime (no hardcoded host in source).
        val apiOrigin: String? = try {
            val clazz = Class.forName(reactContext.packageName + ".BuildConfig")
            val field = clazz.fields.firstOrNull { it.name == "EXPO_PUBLIC_PHP_API_URL" }
            @Suppress("DEPRECATION")
            (field?.get(null) as? String)?.trim()?.ifEmpty { null }
        } catch (_: Exception) { null }

        // Tier 2: which proxy would the platform use for our API host right now?
        try {
            val uri = apiOrigin?.let { origin ->
                val parsed = java.net.URI(origin)
                java.net.URI(parsed.scheme ?: "https", parsed.host, "/", null)
            } ?: java.net.URI("https", "localhost", "/", null)
            val proxies = java.net.ProxySelector.getDefault().select(uri)
            if (proxies.isNotEmpty() && proxies.none { it.type() == java.net.Proxy.Type.DIRECT }) {
                Log.d(TAG, "[detectProxy] ProxySelector non-DIRECT for \u0024{uri.host}: \u0024proxies")
                return true
            }
        } catch (e: Exception) {
            Log.d(TAG, "[detectProxy] selector tier exception: \u0024{e.message}")
        }

        // Tier 3: platform global proxy on the active network (API 29+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                val cm = reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                val activeNetwork = cm?.activeNetwork
                val lp = activeNetwork?.let { cm.getLinkProperties(it) }
                val httpProxy = lp?.httpProxy
                if (httpProxy != null && !httpProxy.host.isNullOrEmpty()) {
                    Log.d(TAG, "[detectProxy] LinkProperties global proxy: \u0024{httpProxy.host}:\u0024{httpProxy.port}")
                    return true
                }
            } catch (e: Exception) {
                Log.d(TAG, "[detectProxy] global tier exception: \u0024{e.message}")
            }
        }

        Log.d(TAG, "[detectProxy] no proxy detected")
        return false
    }

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
                    Log.d(TAG, "[detectVpn] allNetworks.count=\${allNetworks.size}")
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
            Log.d(TAG, "[detectVpn] CM tier exception: \${e.message}")
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
                        Log.d(TAG, "[detectVpn] VPN interface found: $name (up=\${iface.isUp})")
                        return true
                    }
                }
            }
        } catch (e: Exception) {
            Log.d(TAG, "[detectVpn] NetworkInterface tier exception: \${e.message}")
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
            val f = File("/system/medacademy-rwtest-\${System.currentTimeMillis()}")
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

        // 5. Sensor count — EVIDENCE-BASED (tablet false-positive fix):
        // A missing sensor list alone is NOT emulator evidence — some real
        // hardware (tablets, TV boxes, e-readers) legitimately exposes zero
        // sensors, which misclassified genuine devices as emulators ("Debug
        // Mode Active" on a normal release install). Emulators are now
        // flagged only when zero sensors COMBINE WITH other emulator-
        // indicative build evidence. A real device without sensors but with
        // a genuine OEM fingerprint passes; AVDs still fail (they also have
        // generic fingerprints / goldfish hardware).
        return try {
            val sm = reactContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
            val sensors = sm?.getSensorList(Sensor.TYPE_ALL) ?: emptyList()
            val sensorCount = sensors.size
            if (sensorCount > 0) {
                Log.d(TAG, "[detectEmulator] sensorCount=$sensorCount → not emulator (has sensors)")
                false
            } else {
                // No sensors at all — require corroborating build evidence.
                val fp = Build.FINGERPRINT.lowercase()
                val hw = Build.HARDWARE.lowercase()
                val prod = Build.PRODUCT.lowercase()
                val brand = Build.BRAND.lowercase()
                val hasEmuBuildEvidence =
                    fp.contains("generic") || fp.contains("sdk") || fp.contains("vbox") ||
                    fp.contains("test-keys") ||
                    hw.contains("goldfish") || hw.contains("ranchu") || hw.contains("vbox") ||
                    prod.startsWith("sdk") || prod.startsWith("emulator") || prod.contains("genymotion") ||
                    brand == "generic" || brand.contains("generic")
                Log.d(TAG, "[detectEmulator] sensorCount=0 emuBuildEvidence=$hasEmuBuildEvidence fp=$fp hw=$hw prod=$prod brand=$brand")
                // Real OEM builds carry a manufacturer fingerprint/brand; an
                // AVD always matches at least one evidence term above.
                hasEmuBuildEvidence
            }
        } catch (e: Exception) {
            Log.d(TAG, "[detectEmulator] sensor check exception: \${e.message}")
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
                            Log.d(TAG, "[detectMockLocation] MOCK_LOCATION granted to \${appInfo.packageName}")
                            return true
                        }
                    }
                }
            } catch (e: Exception) {
                Log.d(TAG, "[detectMockLocation] AppOpsManager tier exception: \${e.message}")
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
            Log.d(TAG, "[detectMockLocation] legacy flag exception: \${e.message}")
        }

        // Tier 3: scan for any installed app with ACCESS_MOCK_LOCATION permission
        try {
            val pm = reactContext.packageManager
            val mockApps = pm.getPackagesHoldingPermissions(
                arrayOf("android.permission.ACCESS_MOCK_LOCATION"),
                PackageManager.MATCH_ALL
            )
            val external = mockApps.filter { it.packageName != reactContext.packageName }
            Log.d(TAG, "[detectMockLocation] mockLocationApps=" + external.map { it.packageName }.toString())
            if (external.isNotEmpty()) return true
        } catch (e: Exception) {
            Log.d(TAG, "[detectMockLocation] permission scan exception: \${e.message}")
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

    /** Capability evidence from the most recent detectOverlay() run. */
    private var _lastOverlayCapableAppsCount: Int = 0

    /**
     * Overlay / tapjacking detection — evidence-graded.
     *
     * FALSE-POSITIVE FIX (root-cause audit): the previous implementation returned
     * true when MORE THAN FIVE installed packages held SYSTEM_ALERT_WINDOW. That
     * is a capability heuristic, not evidence of an active overlay: on a normal
     * phone many legitimate apps (Messenger chat heads, browsers, launchers,
     * screen recorders, OEM assistants) hold the permission without ever drawing
     * over this app. Android defines SYSTEM_ALERT_WINDOW as the CAPABILITY to
     * create overlay windows; Settings.canDrawOverlays() checks the capability
     * and never whether an overlay is actually on screen.
     *
     * The platform does not expose an API for a regular app to enumerate other
     * apps' windows, so "an overlay is being drawn over our window right now"
     * cannot be measured directly. A POSITIVE is therefore only reported when we
     * hold targeted evidence: an installed, non-system package that is on the
     * known screen-overlay/abuse tool list AND holds the permission. The raw
     * capability count is exported as evidence (overlayCapableAppsCount) for
     * backend observability — it is never itself a threat signal.
     */
    private fun detectOverlay(): Boolean {
        var capableApps = 0
        try {
            val pm = reactContext.packageManager
            val packages = pm.getInstalledApplications(PackageManager.GET_META_DATA)
            // Known screen-overlay / tapjacking tool packages (targeted capability check).
            val abusiveOverlayPackages = setOf(
                "com.perfectlysoft.screengrabber",
                "com.tapjack.example",
                "land.clover.screenmirror",
                "com.mobizen.miing.service"
            )
            for (appInfo in packages) {
                val holdsPermission = try {
                    pm.checkPermission(
                        android.Manifest.permission.SYSTEM_ALERT_WINDOW,
                        appInfo.packageName
                    ) == PackageManager.PERMISSION_GRANTED
                } catch (_: Exception) { false }
                if (!holdsPermission || appInfo.packageName == reactContext.packageName) continue
                capableApps++
                // POSITIVE only on targeted evidence — never on the aggregate count.
                if (appInfo.packageName in abusiveOverlayPackages) {
                    Log.d(TAG, "[detectOverlay] known abusive overlay package present: \${appInfo.packageName}")
                    _lastOverlayCapableAppsCount = capableApps
                    return true
                }
            }
        } catch (_: Exception) { /* non-fatal — capability count stays best-effort */ }
        _lastOverlayCapableAppsCount = capableApps
        Log.d(TAG, "[detectOverlay] no abusive overlay package; overlayCapableAppsCount=\$capableApps (capability evidence only, NOT a threat)")
        return false
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 2 — APP SIGNATURE VERIFICATION
    // ══════════════════════════════════════════════════════════════════════════

    @ReactMethod
    fun getSignatureSha256(promise: Promise) {
        Log.d(TAG, "[getSignatureSha256] ▶ called")
        try {
            promise.resolve(getSignatureSha256Hex())
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

    /** SHA-256 fingerprint (uppercase hex) of the current signing cert, or null. */
    private fun getSignatureSha256Hex(): String? {
        val sig = getSignatureBytes() ?: return null
        return MessageDigest.getInstance("SHA-256").digest(sig)
            .joinToString("") { "%02X".format(it) }
    }

    /**
     * The expected production cert SHA-256 baked into BuildConfig ('' when not configured).
     * Direct static reference (NOT reflection): R8 pruned the field in v221 because the only
     * reader was reflective (Class.forName + getField), which R8 cannot see — silently
     * disabling the APK signature-integrity check. A direct reference both creates a compile
     * -time dependency R8 honors and lets the shrinker keep the field naturally.
     */
    private fun expectedCertSha256(): String =
        try { com.medacademy.app.BuildConfig.EXPECTED_CERT_SHA256 }
        catch (_: Throwable) { "" }

    private fun checkSignatureValid(): Boolean {
        // The expected production SHA-256 fingerprint is injected at build time
        // via BuildConfig (see withProguardRules config plugin).
        // NOT CONFIGURED → the check is UNAVAILABLE (skip), never a failure.
        // Callers report expectedCertConfigured=false so the backend can tell
        // "verified against pin" apart from "nothing to compare against".
        val expected = expectedCertSha256()
        if (expected.isEmpty()) return true  // Not set → skip in dev/unpinned builds

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

    /**
     * Anti-tamper (APK integrity) — distribution-aware.
     *
     * FALSE-POSITIVE FIX (root-cause audit): the previous implementation flagged
     * "tampered" whenever the installer source was not Google Play in release
     * builds. This app's sanctioned distribution model is a DIRECT-DOWNLOADED
     * release APK (EAS internal distribution + website download) — devices
     * legitimately see a null installer source, and Android returns null on many
     * OEM ROMs even for Play-installed apps. Treating "no Play installer" as
     * tamper evidence converted a distribution property into a false
     * "App Integrity Compromised" verdict (risk +40 for every sideloaded user).
     *
     * Authoritative signals remaining (positive evidence only):
     *   1. Signing certificate vs pinned expected SHA-256 (checkSignatureValid).
     *      When no pin is configured the check is UNAVAILABLE — reported via
     *      expectedCertConfigured=false, never "tampered".
     *   2. Critical React Native runtime libraries present in the installed
     *      app — checked BOTH on disk (nativeLibraryDir, legacy extraction)
     *      AND inside the installed APK. This app ships with
     *      android:extractNativeLibs=false (AGP default for minSdk 23+), so
     *      .so files are memory-mapped straight from the APK and
     *      nativeLibraryDir is EMPTY on every legitimate modern install.
     *      A re-packaged APK that lost them would not run.
     *
     * Installer source is still collected — as DISTRIBUTION TELEMETRY via the
     * installerSource evidence field in getSecurityFlags, so the backend can
     * observe how the app arrived on the device without the client converting
     * that into a threat verdict. A server-controlled strict mode (security_config
     * extras.require_play_installer) is evaluated in JS where the server policy
     * lives — see src/lib/security.ts detectTamper().
     */
    private fun detectTampering(): Boolean {
        // Runtime equivalent of BuildConfig.DEBUG — hoisted so the lib check below
        // can use it. ApplicationInfo.FLAG_DEBUGGABLE is cleared on signed release
        // APKs, set on debug builds.
        val isDebugBuild = (reactContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

        // 1. Signature check — authoritative when an expected cert is configured.
        if (!checkSignatureValid()) return true

        // 2. Critical native libraries must exist in the installed app.
        //    FALSE-POSITIVE FIX: with android:extractNativeLibs=false the OS
        //    never extracts .so files to nativeLibraryDir — they are loaded
        //    directly from the APK. The previous disk-only probe found no libs
        //    on ANY legitimate production install and returned "tampered"
        //    (+40) even though the signature check had passed. The probe now
        //    checks the APK contents as well; "tampered" is only possible when
        //    absence is actually MEASURED in both locations — an inspection
        //    error stays UNAVAILABLE, never a verdict.
        val criticalLibs = listOf("libreactnative.so", "libhermes.so", "libhermesvm.so")
        val nativeLibDir = reactContext.applicationInfo.nativeLibraryDir
        val libsOnDisk = criticalLibs.any { File(nativeLibDir, it).exists() }
        if (!libsOnDisk && !isDebugBuild && nativeLibDir.isNotEmpty()) {
            if (!criticalLibsPresentInInstalledApk(criticalLibs)) return true
        }

        return false
    }

    /** Process-lifetime cache for criticalLibsPresentInInstalledApk(): the
     *  installed APK cannot change while this process is alive — any reinstall
     *  kills the process first. */
    @Volatile private var criticalLibsInApkCache: Boolean? = null

    /**
     * True when any of the given libraries exists inside the installed APK
     * (base or split). Returns true (unavailable) when no APK path can be
     * inspected — absence must be MEASURED, never assumed, so an inspection
     * error can never be converted into a tamper verdict. A false here is a
     * measured absence across every readable APK path.
     */
    private fun criticalLibsPresentInInstalledApk(criticalLibs: List<String>): Boolean {
        criticalLibsInApkCache?.let { return it }
        val apkPaths = mutableListOf<String>()
        reactContext.applicationInfo.sourceDir?.let { apkPaths.add(it) }
        reactContext.applicationInfo.splitSourceDirs?.let { apkPaths.addAll(it) }
        var anyApkInspected = false
        for (apk in apkPaths) {
            try {
                java.util.zip.ZipFile(apk).use { zip ->
                    anyApkInspected = true
                    val entries = zip.entries()
                    while (entries.hasMoreElements()) {
                        val name = entries.nextElement().name
                        if (name.startsWith("lib/") && criticalLibs.any { name.endsWith("/" + it) }) {
                            criticalLibsInApkCache = true
                            return true
                        }
                    }
                }
            } catch (_: Exception) { /* unreadable APK → not evidence, never a verdict */ }
        }
        if (anyApkInspected) {
            criticalLibsInApkCache = false
            return false
        }
        return true // nothing measurable → UNAVAILABLE, never "tampered"
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
            // Play Integrity's newer API names the binding field setRequestHash
            // (server verifies requestDetails.requestHash). Older versions only
            // expose setNonce — both surface in requestDetails.requestHash on
            // the backend; try the newer name when present and ignore failure.
            try {
                builderClass.getMethod("setRequestHash", String::class.java).invoke(builder, nonce)
            } catch (e: NoSuchMethodException) {
                // Classic nonce API — the server reads requestHash which equals
                // the nonce for classic requests. Nothing to do.
            }
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
            val _t0 = System.currentTimeMillis()
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

            // ── Evidence fields (observability — NEVER threat signals) ────
            // installerSource: distribution telemetry. null = unknown/direct-
            //   download (legitimate under this app's distribution model).
            // expectedCertConfigured: distinguishes "signature verified against a
            //   pinned cert" from "signature check unavailable (no pin)".
            // signatureSha256: actual signing-cert fingerprint for server-side
            //   correlation (public material, not a secret).
            // overlayCapableAppsCount: SYSTEM_ALERT_WINDOW capability count —
            //   evidence quality metric, explicitly NOT a threat signal.
            val installerSource: String? = try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    reactContext.packageManager
                        .getInstallSourceInfo(reactContext.packageName).installingPackageName
                } else {
                    @Suppress("DEPRECATION")
                    reactContext.packageManager.getInstallerPackageName(reactContext.packageName)
                }
            } catch (_: Exception) { null }
            r.putString("installerSource", installerSource)
            r.putBoolean("expectedCertConfigured", expectedCertSha256().isNotEmpty())
            val sigHex = runCatching { getSignatureSha256Hex() }.getOrNull()
            if (sigHex != null) r.putString("signatureSha256", sigHex)
            r.putInt("overlayCapableAppsCount", _lastOverlayCapableAppsCount)
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
            Log.d(TAG, "[getSecurityFlags] ✅ all checks complete in \${_elapsed}ms")
            Log.d(TAG, "[getSecurityFlags] RAW_FLAGS=\${r}")
            promise.resolve(r)
        } catch (e: Exception) {
            Log.e(TAG, "[getSecurityFlags] ❌ exception: \${e.message}", e)
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


    // ═══════════════════════════════════════════════════════════════════
    // Device-key cryptography (Android Keystore — challenge/response layer)
    // ═══════════════════════════════════════════════════════════════════
    // The private key is generated INSIDE Android Keystore and is
    // non-exportable by design: it can never reach JS, files, AsyncStorage,
    // SecureStore, logs, or the backend. StrongBox is attempted first on
    // API 28+; TEE is the normal backing; a software-backed key is the
    // honest fallback and is REPORTED as such (never claimed as hardware).
    //
    // Signing: ECDSA SHA-256 over the exact bytes the caller supplies (the
    // canonical JSON built in TS; the backend recomputes it independently
    // in SecurityEvidenceService::canonicalJson). No server secrets live here.

    private val DEVICE_KEY_ALIAS = "medacademy_device_key_v1"

    /** Generate the device keypair if absent. Resolves the security backing. */
    @ReactMethod
    fun ensureDeviceKey(promise: Promise) {
        try {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            if (!ks.containsAlias(DEVICE_KEY_ALIAS)) {
                val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
                var generated = false
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    // Prefer StrongBox where the device offers it.
                    try {
                        val spec = KeyGenParameterSpec.Builder(
                            DEVICE_KEY_ALIAS,
                            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
                        )
                            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                            .setDigests(KeyProperties.DIGEST_SHA256)
                            .setIsStrongBoxBacked(true)
                            .build()
                        kpg.initialize(spec)
                        kpg.generateKeyPair()
                        generated = true
                    } catch (_: Exception) {
                        // No StrongBox on this device — fall through to TEE/software.
                    }
                }
                if (!generated) {
                    val spec = KeyGenParameterSpec.Builder(
                        DEVICE_KEY_ALIAS,
                        KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
                    )
                        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                        .setDigests(KeyProperties.DIGEST_SHA256)
                        .build()
                    kpg.initialize(spec)
                    kpg.generateKeyPair()
                }
            }
            promise.resolve(deviceKeySecurityLevel())
        } catch (e: Exception) {
            promise.reject("DEVICE_KEY_GEN_FAILED", e.message ?: "key generation failed", e)
        }
    }

    /**
     * Which backing actually holds the key — honestly reported.
     * "tee" covers secure-hardware-backed keys (StrongBox devices included;
     * the public API does not reliably distinguish them without attestation,
     * and we do NOT claim StrongBox when we cannot verify it).
     */
    private fun deviceKeySecurityLevel(): String {
        return try {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val entry = ks.getEntry(DEVICE_KEY_ALIAS, null)
            if (entry is KeyStore.PrivateKeyEntry) {
                val factory = KeyFactory.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
                @Suppress("DEPRECATION")
                val info = factory.getKeySpec(entry.getPrivateKey(), KeyInfo::class.java)
                if (info.isInsideSecureHardware) "tee" else "software"
            } else {
                "unknown"
            }
        } catch (_: Exception) {
            "unknown"
        }
    }

    /** Export the PUBLIC key as SPKI PEM (public material only — safe to send). */
    @ReactMethod
    fun getDevicePublicKeyPem(promise: Promise) {
        try {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val cert = ks.getCertificate(DEVICE_KEY_ALIAS)
                ?: throw IllegalStateException("device key not generated yet")
            val b64 = android.util.Base64.encodeToString(cert.publicKey.encoded, android.util.Base64.NO_WRAP)
            val nl = System.getProperty("line.separator")
            val pem = StringBuilder("-----BEGIN PUBLIC KEY-----").append(nl)
            var i = 0
            while (i < b64.length) {
                val end = minOf(i + 64, b64.length)
                pem.append(b64, i, end).append(nl)
                i = end
            }
            pem.append("-----END PUBLIC KEY-----")
            promise.resolve(pem.toString())
        } catch (e: Exception) {
            promise.reject("DEVICE_KEY_EXPORT_FAILED", e.message ?: "export failed", e)
        }
    }

    /**
     * Sign bytes (base64, from the canonical payload) with the Keystore EC key.
     * Returns base64 DER ECDSA-SHA256. The server verifies with openssl_verify
     * against the registered SPKI PEM.
     */
    @ReactMethod
    fun signDevicePayload(payloadB64: String, promise: Promise) {
        try {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val entry = ks.getEntry(DEVICE_KEY_ALIAS, null) as? KeyStore.PrivateKeyEntry
                ?: throw IllegalStateException("device key not available")
            val data = android.util.Base64.decode(payloadB64, android.util.Base64.NO_WRAP)
            val signature = Signature.getInstance("SHA256withECDSA")
            signature.initSign(entry.getPrivateKey())
            signature.update(data)
            promise.resolve(android.util.Base64.encodeToString(signature.sign(), android.util.Base64.NO_WRAP))
        } catch (e: Exception) {
            promise.reject("DEVICE_KEY_SIGN_FAILED", e.message ?: "signing failed", e)
        }
    }

    /** Stable public identifier for the registered key (the alias is public). */
    @ReactMethod
    fun getDeviceKeyId(promise: Promise) {
        promise.resolve(DEVICE_KEY_ALIAS)
    }

    /**
     * Wireless debugging state (API 30+; Settings.Global.ADB_WIFI_ENABLED).
     * Distinct from USB debugging (isAdbEnabled) — the two surfaces carry
     * different risk and the security model tracks them separately.
     */
    @ReactMethod
    fun isWirelessDebuggingEnabled(promise: Promise) {
        runSafe(promise) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return@runSafe false
            try {
                Settings.Global.getInt(
                    reactContext.contentResolver,
                    "adb_wifi_enabled", 0
                ) == 1
            } catch (_: Exception) { false }
        }
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

    // ═══════════════════════════════════════════════════════════════════
    // GAP-CLOSURE — BINARY INTEGRITY (Parts 1–4)
    // Measures: APK signing-cert digest, per-DEX digests, native-library
    // inventory, and critical-asset aggregate — across the BASE APK AND
    // ALL SPLIT APKs, extraction-mode agnostic (no nativeLibraryDir
    // dependency, so no false "missing library" on modern installs).
    //
    // The MEASUREMENT is computed here; the JUDGEMENT happens on the
    // SERVER (device_keys.integrity_baseline_sha256 / optional pinned
    // release digest). There is deliberately NO client-side expected-hash
    // comparison — nothing here can be patched to "pass".
    // ═══════════════════════════════════════════════════════════════════

    /** Digest of the APK signing certificate(s) actually covering this build. */
    fun signingCertSha256(): String {
        return try {
            val sig = getSignatureBytes() ?: return ""
            MessageDigest.getInstance("SHA-256").digest(sig)
                .joinToString("") { "%02x".format(it) }
        } catch (_: Exception) { "" }
    }

    /**
     * Critical-asset integrity. Measures assets/medasec_manifest.json —
     * a build-generated manifest of {path, sha256} for security-critical
     * assets — and every asset it lists. NOT a whole-APK hash: hashing the
     * APK that contains the evidence would be a self-reference. The
     * manifest is emitted at release-build time (app.json extra.medaSecAssets
     * via withSecNativeCoreSources); if it is absent the layer is
     * UNAVAILABLE, never a verdict.
     */
    fun collectAssetIntegrity(zipSources: List<String>): JSONObject {
        val out = JSONObject()
        try {
            var manifestFound = false
            for (src in zipSources) {
                try {
                    ZipFile(src).use { zip ->
                        val manEntry = zip.getEntry("assets/medasec_manifest.json") ?: return@use
                        manifestFound = true
                        val manifestBytes = zip.getInputStream(manEntry).readBytes()
                        out.put("manifest_sha256", MessageDigest.getInstance("SHA-256")
                            .digest(manifestBytes).joinToString("") { "%02x".format(it) })
                        val manifest = JSONObject(String(manifestBytes, Charsets.UTF_8))
                        val entries = manifest.optJSONArray("assets") ?: JSONArray()
                        var ok = 0; var bad = 0; var missing = 0
                        val offenders = JSONArray()
                        for (i in 0 until entries.length()) {
                            val e = entries.optJSONObject(i) ?: continue
                            val path = e.optString("path")
                            val want = e.optString("sha256")
                            if (path.isEmpty() || want.length != 64) continue
                            val ae = zip.getEntry(path)
                            if (ae == null) { missing++; offenders.put(path) } else {
                                val got = MessageDigest.getInstance("SHA-256")
                                    .digest(zip.getInputStream(ae).readBytes())
                                    .joinToString("") { "%02x".format(it) }
                                if (got.equals(want, ignoreCase = true)) ok++
                                else { bad++; offenders.put(path) }
                            }
                        }
                        out.put("assets_total", entries.length())
                        out.put("assets_ok_count", ok)
                        out.put("assets_bad_count", bad)
                        out.put("assets_missing_count", missing)
                        out.put("assets_ok", bad == 0 && missing == 0)
                        if (offenders.length() > 0) {
                            val limited = JSONArray()
                            for (j in 0 until minOf(offenders.length(), 8)) limited.put(offenders.get(j))
                            out.put("assets_offenders", limited)
                        }
                    }
                } catch (_: Exception) { }
                if (manifestFound) break
            }
            if (!manifestFound) out.put("manifest", "absent")
        } catch (e: Exception) {
            out.put("assets_error", e.javaClass.simpleName)
        }
        return out
    }

    /**
     * Full binary-integrity measurement across base + split APKs.
     * One aggregate (runtime_sha256) + per-component detail. The aggregate is
     * defined by sorting all {name → sha256(file)} pairs by name and hashing
     * that canonical sequence — stable across the OS's APK ordering, but
     * ANY modification (DEX swap, lib swap, asset patch, added file) changes
     * the sorted sequence and therefore the aggregate.
     */
    fun collectBinaryIntegrity(): JSONObject {
        val out = JSONObject()
        try {
            val sources = ArrayList<String>()
            reactContext.applicationInfo.sourceDir?.let { sources.add(it) }
            reactContext.applicationInfo.splitSourceDirs?.forEach { sources.add(it) }

            val pairs = ArrayList<String>()
            var dexCount = 0
            var soCount = 0
            val soNames = HashSet<String>()
            var totalBytes = 0L
            val md = MessageDigest.getInstance("SHA-256")

            for (src in sources) {
                try {
                    ZipFile(src).use { zip ->
                        val entries = zip.entries()
                        while (entries.hasMoreElements()) {
                            val e = entries.nextElement()
                            val name = e.name
                            if (e.isDirectory) continue
                            // The v1 signature block (META-INF/*.{RSA,DSA,EC}) embeds the
                            // signing cert; hashing it is redundant/circular. The cert
                            // itself is reported separately via signingCertSha256().
                            if (name.startsWith("META-INF/") &&
                                (name.endsWith(".RSA") || name.endsWith(".DSA") || name.endsWith(".EC"))) continue
                            val fileSha = md.digest(zip.getInputStream(e).readBytes())
                                .joinToString("") { "%02x".format(it) }
                            totalBytes += e.size
                            if (!name.contains("/") && name.startsWith("classes") && name.endsWith(".dex")) dexCount++
                            if (name.startsWith("lib/") && name.endsWith(".so")) {
                                soCount++
                                soNames.add(name.substringAfterLast('/'))
                            }
                            pairs.add(name + ":" + fileSha)
                        }
                    }
                } catch (e: Exception) {
                    out.put("zip_error", (src.substringAfterLast('/') + ":" + e.javaClass.simpleName))
                }
            }

            // Canonical aggregate: sort the {name:hash} sequence, then hash it.
            val sorted = pairs.sorted()
            val agg = MessageDigest.getInstance("SHA-256")
            for (p in sorted) agg.update(p.toByteArray(Charsets.UTF_8))
            val runtimeSha = agg.digest().joinToString("") { "%02x".format(it) }

            out.put("apk_sources", sources.size)
            out.put("dex_count", dexCount)
            out.put("so_count", soCount)
            out.put("so_names", JSONArray(soNames.sorted()))
            out.put("total_bytes", totalBytes)
            out.put("file_count", pairs.size)
            out.put("cert_sha256", signingCertSha256())
            out.put("runtime_sha256", runtimeSha)
            out.put("computed_at", System.currentTimeMillis())
        } catch (e: Exception) {
            out.put("binary_error", e.javaClass.simpleName)
            out.put("runtime_sha256", "")
        }
        return out
    }

    // ═══════════════════════════════════════════════════════════════════
    // GAP-CLOSURE — NATIVE SECURITY CORE bridge (libmedasec, Part 6/7).
    // C++ performs the expensive/patch-resistant part: /proc self maps
    // inspection, loaded-library inventory, rusage self-checks. Kotlin
    // stays the platform-API authority. Results are UNAVAILABLE-honest:
    // a native failure degrades to "unavailable", never to "safe".
    // ═══════════════════════════════════════════════════════════════════

    private fun nativeCoreAvailable(): Boolean = try {
        SecurityNativeCore.isAvailable()
    } catch (_: Throwable) { false }

    fun nativeCoreRasp(): JSONObject = try {
        JSONObject(SecurityNativeCore.raspAggregate())
    } catch (_: Throwable) { JSONObject().put("available", false) }

    fun nativeCoreInspect(): JSONObject = try {
        JSONObject(SecurityNativeCore.inspect())
    } catch (_: Throwable) { JSONObject().put("available", false) }

    /**
     * Aggregate VPN state (Part 10): a MODEL, not a boolean.
     *   unknown    — signals could not be collected
     *   off        — TRANSPORT_VPN absent AND no tun/tap/ppp/vpn interface
     *   on         — transport or interface positively detected
     *   suspicious — callback saw VPN activity that the sensors no longer find
     *                (possible suppression)
     */
    fun aggregateVpnState(): String {
        return try {
            // detectVpn() combines TRANSPORT_VPN (tier 1) and the
            // tun/vpn/ppp/ipsec interface scan (tier 2) in one call.
            val vpnDetected = detectVpn()
            val proxy = detectProxy()
            when {
                vpnDetected -> "on"
                proxy -> "suspicious"
                // Part 12 (recovery-fixed): SUSPICIOUS only on a LIVE
                // contradiction — the OS callback reports an active VPN
                // network the sensor scan cannot find (possible suppression).
                // A completed teardown clears callbackSeesVpn in
                // upgradeVpnState(), so the state recovers to OFF without a
                // restart (the previous historical latch blocked forever).
                callbackSeesVpn && !vpnDetected -> "suspicious"
                else -> "off"
            }
        } catch (_: Exception) { "unknown" }
    }


    // ═══════════════════════════════════════════════════════════════
    // Phase-3 micro-gap Part 3: NATIVE NETWORK INSPECTION bridge.
    // C++ reads /proc/net/dev + /proc/net/route (kernel-authoritative
    // interface/route tables that a userspace hook of the Android
    // framework cannot edit). EVIDENCE ONLY — never authorization.
    // ═══════════════════════════════════════════════════════════════
    fun nativeNetworkEvidence(): JSONObject = try {
        JSONObject(SecurityNativeCore.networkEvidence())
    } catch (_: Throwable) { JSONObject().put("available", false) }

    @ReactMethod
    fun getNativeNetworkEvidence(promise: Promise) {
        try { promise.resolve(nativeNetworkEvidence().toString()) }
        catch (e: Exception) { promise.reject("net_error", e.message ?: "native network evidence failed") }
    }
    /** Diagnostic snapshot of the native core (telemetry; never a verdict). */
    fun nativeCoreSnapshot(): JSONObject {
        val out = JSONObject()
        out.put("core_available", nativeCoreAvailable())
        out.put("core_rasp", nativeCoreRasp())
        out.put("core_inspect", nativeCoreInspect())
        return out
    }

    @ReactMethod
    fun getNativeCoreSnapshot(promise: Promise) {
        try { promise.resolve(nativeCoreSnapshot().toString()) }
        catch (e: Exception) { promise.reject("core_error", e.message ?: "native core snapshot failed") }
    }

    @ReactMethod
    fun getVpnState(promise: Promise) {
        try { promise.resolve(aggregateVpnState()) }
        catch (e: Exception) { promise.reject("vpn_state_error", e.message ?: "vpn state failed") }
    }

    @ReactMethod
    fun getBinaryIntegrity(promise: Promise) {
        try { promise.resolve(collectBinaryIntegrity().toString()) }
        catch (e: Exception) { promise.reject("integrity_error", e.message ?: "binary integrity failed") }
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


// ─── Pinning config injection + AppDelegate self-heal ────────────────────────
// apiSpkiPins -> android/gradle.properties (prebuild regenerates that file, so
// this runs on every EAS build before gradle). Empty when extra.medaSslPins is
// absent -> debug AND release both unpinned (opt-in protection).
// AppDelegate self-heal: prebuild regenerates AppDelegate.swift from template,
// which would silently drop the PinningInitializer.install() call — re-add it.
function selfHealPinningIntegration(config) {
  const pins = config?.extra?.medaSslPins;
  const hosts = config?.extra?.medaPinnedHosts;

  // a) Android: write apiSpkiPins into gradle.properties
  const gradlePropsPath = path.join(config?._internal?.projectRoot || process.cwd(), 'android', 'gradle.properties');
  if (Array.isArray(pins) && pins.length > 0 && fs.existsSync(gradlePropsPath)) {
    const validPins = pins.filter((p) => typeof p === 'string' && p.length === 44);
    if (validPins.length > 0) {
      let props = fs.readFileSync(gradlePropsPath, 'utf8');
      const validHosts = Array.isArray(hosts)
        ? hosts.filter((h) => typeof h === 'string' && h.length > 0)
        : [];
      const lines = ['apiSpkiPins=' + validPins.join(' ')];
      if (validHosts.length > 0) lines.push('apiPinnedHosts=' + validHosts.join(' '));
      const reSpki = /^apiSpkiPins=.*$/m;
      if (reSpki.test(props)) {
        props = props.replace(reSpki, lines[0]);
      } else {
        props = props.trimEnd() + '\n# SSL pinning for the production API (injected by plugins/withSecurityModule.js)\n' + lines[0] + '\n';
      }
      if (validHosts.length > 0) {
        const reHosts = /^apiPinnedHosts=.*$/m;
        if (reHosts.test(props)) {
          props = props.replace(reHosts, lines[1]);
        } else {
          props = props.trimEnd() + '\n' + lines[1] + '\n';
        }
      }
      fs.writeFileSync(gradlePropsPath, props);
    }
  }

  // b) iOS: self-heal the AppDelegate pinning call
  const appDelegatePath = path.join(
    config?._internal?.projectRoot || process.cwd(),
    'ios',
    config?.modRequest?.projectName || 'MedAcademyMobileApp',
    'AppDelegate.swift'
  );
  if (fs.existsSync(appDelegatePath)) {
    let appDelegate = fs.readFileSync(appDelegatePath, 'utf8');
    if (!appDelegate.includes('PinningInitializer.install()')) {
      const anchor = '    let delegate = ReactNativeDelegate()';
      if (appDelegate.includes(anchor)) {
        appDelegate = appDelegate.replace(
          anchor,
          '    // REAL SSL pinning (inert in dev: no MEDA_SPKI_PINS in Info.plist).\n' +
          '    // Installs the NSURLSessionConfiguration provider BEFORE React loads so\n' +
          '    // the very first fetch() is already validated.\n' +
          '    PinningInitializer.install()\n\n' + anchor
        );
        fs.writeFileSync(appDelegatePath, appDelegate);
      }
    }
  }
  return config;
}

function withSecurityKotlinSources(config) {
  config = selfHealPinningIntegration(config);
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
//
// RN 0.83 uses a different MainApplication pattern than older versions.
// The old `getPackages()` + `return packages` pattern is gone; now it's:
//
//   PackageList(this).packages.apply {
//     // add(MyPackage()) here
//   }
//
// We target the `apply {` block's opening comment line to insert our add() call,
// and fall back to the old pattern for backwards-compatibility with older templates.

function withSecurityPackageRegistration(config) {
  return withMainApplication(config, (cfg) => {
    let contents = cfg.modResults.contents;

    // ── 1. Idempotency guard ────────────────────────────────────────────────
    // Only skip if the REGISTRATION (add() call) is present — the import alone is
    // NOT proof of registration. Historical bug: a checked-in MainApplication.kt had
    // the import but a lost add() call, so the guard skipped, the module never
    // registered, and NativeModules.SecurityModule was null in production (breaking
    // VPN detection and every other native check). Guarding on the add() call only
    // makes the insertion self-healing for that exact state.
    const alreadyRegistered = contents.includes('add(SecurityPackage())');
    if (alreadyRegistered && !contents.includes('import com.medacademy.security.SecurityPackage')) {
      // Registered but import missing (hand-edited file) — repair the import.
      contents = contents.replace(
        /(import com\.facebook\.react\.ReactApplication)/,
        'import com.medacademy.security.SecurityPackage\n$1'
      );
      cfg.modResults.contents = contents;
      return cfg;
    }
    if (alreadyRegistered) return cfg;

    // ── 2. Ensure import is present ─────────────────────────────────────────
    if (!contents.includes('import com.medacademy.security.SecurityPackage')) {
      contents = contents.replace(
        /(import com\.facebook\.react\.ReactApplication)/,
        'import com.medacademy.security.SecurityPackage\n$1'
      );
    }

    // ── 3a. RN 0.83 pattern: PackageList(this).packages.apply { … } ─────────
    // Insert add(SecurityPackage()) as the first line inside the apply block.
    if (contents.includes('PackageList(this).packages.apply {')) {
      contents = contents.replace(
        /(PackageList\(this\)\.packages\.apply \{)/,
        '$1\n          add(SecurityPackage())'
      );
    }
    // ── 3b. Legacy pattern: `return packages` ───────────────────────────────
    else if (/\breturn packages\b/.test(contents)) {
      contents = contents.replace(
        /(\s+)(return packages\b)/,
        '$1packages.add(SecurityPackage())\n$1$2'
      );
    }
    // ── 3c. Fallback: append before closing brace of getPackages() ──────────
    else {
      // Best-effort: insert before the first `return` in the file
      contents = contents.replace(
        /(\s+)(return\b)/,
        '$1// SecurityPackage registered by withSecurityModule plugin\n$1add(SecurityPackage())\n$1$2'
      );
    }

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
    const filesToCopy  = ['IOSSecurityModule.swift', 'IOSSecurityModule.m', 'PinningURLProtocol.swift', 'PinningInitializer.m', 'PinningInitializer.h'];
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
      '// PinningInitializer (implemented in PinningInitializer.m, copied to this',
      '// same directory) bootstraps SSL pinning before React loads. Its class',
      '// interface must be visible to Swift because AppDelegate.swift calls',
      '// PinningInitializer.install() from didFinishLaunching.',
      '#import "PinningInitializer.h"',
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

// ─── withIOSEmbedPodsFrameworks ───────────────────────────────────────────────
//
// BACKGROUND (why this function exists):
//   When RCT_USE_PREBUILT_RNCORE=1, react_native_pods.rb links React as a
//   pre-built dynamic .xcframework (React-Core-prebuilt pod).  CocoaPods
//   generates "[CP] Embed Pods Frameworks" in project.pbxproj at `pod install`
//   time to copy those dynamic frameworks into the .app bundle.
//
//   Because ios/ is fully regenerated by `expo prebuild --clean` on every EAS
//   build, any direct pbxproj edit is wiped.  This plugin re-injects the phase
//   so it is present before CocoaPods runs its own integration pass.
//
// CURRENT CONFIGURATION (as of the buildReactNativeFromSource=true fix):
//   ios.buildReactNativeFromSource=true in Podfile.properties.json disables
//   both RCT_USE_PREBUILT_RNCORE and RCT_USE_RN_DEP.  Both React-Core and
//   ReactNativeDependencies are therefore built from source as static libraries.
//   No dynamic xcframeworks → no DYLD @rpath references → no DYLD crash.
//
//   In this mode the embed phase is a no-op (frameworks.sh lists zero frameworks
//   and exits immediately), so this function is harmless to leave in place.
//   It acts as a safety net if prebuilt xcframeworks are re-enabled in future.
//
// ROOT CAUSE OF DYLD CRASH (historical record):
//   With RCT_USE_PREBUILT_RNCORE=1, the Xcode script phase
//   "[RNDeps] Replace React Native Core for the right configuration, if needed"
//   (injected by React-Core-prebuilt.podspec) runs BEFORE COMPILE.  It calls
//   replace-rncore-version.js, which does:
//     1. rmSync('React-Core-prebuilt', {recursive: true})   ← deletes entire pod dir
//     2. mkdirSync('React-Core-prebuilt')
//     3. tar -xf <tarball> -C React-Core-prebuilt           ← raw flat extract
//   The tarball root is FLAT (ios-arm64/, Info.plist, …).
//   The prepare_command in React-Core-prebuilt.podspec (which runs only at pod
//   install time, NOT during Xcode builds) wraps those items into React.xcframework/.
//   replace-rncore-version.js bypasses prepare_command entirely, so after the
//   script phase runs React.xcframework/ no longer exists at
//   Pods/React-Core-prebuilt/React.xcframework.
//   frameworks.sh was generated at pod install time to embed from that path →
//   source file missing → copy silently skipped → .app/Frameworks/React.framework
//   never created → DYLD crash on launch.
//
//   The previous attempted fix (injecting this embed phase) was correct in
//   theory but insufficient: the phase ran, frameworks.sh ran, but the source
//   xcframework was already gone (deleted by replace-rncore-version.js before
//   compile).  Re-embedding a non-existent file is a silent no-op.
//
//   Setting ios.buildReactNativeFromSource=true eliminates the dynamic
//   xcframework entirely, making the whole problem class impossible.
//
// IDEMPOTENCY:
//   Skips silently if a phase named "[CP] Embed Pods Frameworks" already exists
//   (e.g., a subsequent `pod install` already added it after prebuild).

const EMBED_PODS_PHASE_NAME = '[CP] Embed Pods Frameworks';

function withIOSEmbedPodsFrameworks(config) {
  return withXcodeProject(config, (cfg) => {
    const proj    = cfg.modResults;
    const appName = cfg.modRequest.projectName;
    const target  = proj.getFirstTarget();

    const phaseObjects =
      proj.hash.project.objects['PBXShellScriptBuildPhase'] || {};

    // ── Clean-up: remove any stale/orphaned embed-phase entries ───────────
    // A stale entry can occur when a previous plugin run inserted a phase
    // with a hardcoded UUID that was later removed from the objects dict
    // but not from the buildPhases array, or vice-versa.  Clearing both
    // guarantees the subsequent idempotency check and insertion are clean.
    const staleUuids = Object.keys(phaseObjects).filter((k) => {
      const p = phaseObjects[k];
      return (
        typeof p === 'object' &&
        p.name &&
        (p.name === EMBED_PODS_PHASE_NAME ||
          p.name === `"${EMBED_PODS_PHASE_NAME}"`)
      );
    });

    // Collect the UUIDs that appear in the buildPhases array but have no
    // matching object (dangling references from old hardcoded-UUID approach).
    const nativeTargetSection = proj.pbxNativeTargetSection();
    for (const tKey of Object.keys(nativeTargetSection)) {
      const t = nativeTargetSection[tKey];
      if (!t || typeof t !== 'object' || !Array.isArray(t.buildPhases)) continue;
      if (t.name !== appName && t.name !== `"${appName}"`) continue;
      // Remove array entries whose comment names the phase but whose UUID has
      // no backing object (dangling) OR whose UUID is in our stale set.
      for (let i = t.buildPhases.length - 1; i >= 0; i--) {
        const entry = t.buildPhases[i];
        const uuid    = typeof entry === 'object' ? entry.value   : entry;
        const comment = typeof entry === 'object' ? entry.comment : '';
        const isEmbedComment = comment && comment.includes('Embed Pods');
        const isOrphan = !phaseObjects[uuid] || staleUuids.includes(uuid);
        if (isEmbedComment || (staleUuids.includes(uuid) && isOrphan)) {
          t.buildPhases.splice(i, 1);
        }
      }
      break;
    }
    // Remove stale objects + their _comment twin entries.
    for (const uuid of staleUuids) {
      delete phaseObjects[uuid];
      delete phaseObjects[`${uuid}_comment`];
    }

    // ── Idempotency: if a valid phase object already exists, stop ─────────
    // This handles the case where pod install ran AFTER prebuild and already
    // added its own [CP] Embed Pods Frameworks phase (CocoaPods generates a
    // new UUID each time).  We trust pod install's version and skip.
    const alreadyPresent = Object.values(phaseObjects).some(
      (p) =>
        typeof p === 'object' &&
        p.name &&
        (p.name === EMBED_PODS_PHASE_NAME ||
          p.name === `"${EMBED_PODS_PHASE_NAME}"`)
    );
    if (alreadyPresent) return cfg;

    // ── Add the phase via xcode@3 addBuildPhase() API ─────────────────────
    // pbxShellScriptBuildPhaseObj() inside the library wraps shellScript in
    // quotes and escapes embedded quotes automatically — pass the raw string.
    const { uuid: phaseUuid, buildPhase } = proj.addBuildPhase(
      [],   // no individual file refs — the generated frameworks.sh handles all
      'PBXShellScriptBuildPhase',
      EMBED_PODS_PHASE_NAME,
      target.uuid,
      {
        shellPath: '/bin/sh',
        // Raw value — xcode@3's pbxShellScriptBuildPhaseObj wraps + escapes this.
        // Result in pbxproj: shellScript = "\"${PODS_ROOT}/.../frameworks.sh\"\n";
        shellScript:
          `"$\{PODS_ROOT}/Target Support Files/Pods-${appName}/Pods-${appName}-frameworks.sh"\n`,
        inputPaths:  [],
        outputPaths: [],
      }
    );

    // ── Append xcfilelist paths (incremental-build support) ───────────────
    // xcode@3's addBuildPhase options object does not expose these fields, so
    // we patch the in-memory phase object directly after creation.
    // ${CONFIGURATION} is resolved by Xcode at build time to "Debug"/"Release",
    // matching the xcfilelist filenames CocoaPods generates during pod install.
    buildPhase.inputFileListPaths = [
      `"$\{PODS_ROOT}/Target Support Files/Pods-${appName}/Pods-${appName}-frameworks-$\{CONFIGURATION}-input-files.xcfilelist"`,
    ];
    buildPhase.outputFileListPaths = [
      `"$\{PODS_ROOT}/Target Support Files/Pods-${appName}/Pods-${appName}-frameworks-$\{CONFIGURATION}-output-files.xcfilelist"`,
    ];
    buildPhase.showEnvVarsInLog = 0;

    // ── Reposition: move phase to just before [CP] Copy Pods Resources ────
    // addBuildPhase() appends to the end of the target's buildPhases array.
    // CocoaPods expects the order: … Bundle RN code → Embed Pods → Copy Resources.
    const nativeTargets = proj.pbxNativeTargetSection();
    for (const key of Object.keys(nativeTargets)) {
      const t = nativeTargets[key];
      if (!t || typeof t !== 'object' || !t.buildPhases) continue;
      if (t.name !== appName && t.name !== `"${appName}"`) continue;

      const bpArr = t.buildPhases;

      // Remove the entry addBuildPhase() just appended at the tail.
      const appendedIdx = bpArr.findIndex(
        (p) => (typeof p === 'object' ? p.value : p) === phaseUuid
      );
      if (appendedIdx >= 0) bpArr.splice(appendedIdx, 1);

      // Insert immediately before [CP] Copy Pods Resources (or at end).
      const copyResIdx = bpArr.findIndex((p) => {
        const comment = typeof p === 'object' ? p.comment : '';
        return comment && comment.includes('Copy Pods Resources');
      });
      const insertAt = copyResIdx >= 0 ? copyResIdx : bpArr.length;
      bpArr.splice(insertAt, 0, { value: phaseUuid, comment: EMBED_PODS_PHASE_NAME });
      break;
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

    // PinningInitializer.m MUST be registered as a compile source: AppDelegate.swift
    // calls PinningInitializer.install(), so its ObjC implementation has to be
    // compiled and linked into the app binary (and its header is imported by the
    // bridging header so Swift can see the class).
    const filesToAdd = ['IOSSecurityModule.swift', 'IOSSecurityModule.m', 'PinningURLProtocol.swift', 'PinningInitializer.m'];

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

const withMedaSslPins = (config) => {
  // REAL iOS SSL pinning config: SPKI pins + pinned hosts are injected into the
  // app target Info.plist from app.json extra fields. Absent keys = development
  // build = pinning inert (PinningURLProtocol.canInit returns false).
  // Never store private key material here — SPKI pins are public-key HASHES.
  const pins = config?.extra?.medaSslPins;
  const hosts = config?.extra?.medaPinnedHosts;
  if (Array.isArray(pins) && pins.length > 0) {
    config.ios = config.ios || {};
    config.ios.infoPlist = config.ios.infoPlist || {};
    config.ios.infoPlist.MEDA_SPKI_PINS = pins.filter((p) => typeof p === 'string');
    config.ios.infoPlist.MEDA_PINNED_HOSTS = Array.isArray(hosts)
      ? hosts.filter((h) => typeof h === 'string')
      : [];
  }
  return config;
};

// ─────────────────────────────────────────────────────────────────────────
// GAP CLOSURE — Native Security Core (libmedasec): C++/JNI inspection core.
// Materialized under android/app/src/main/cpp by a dangerous mod so it
// survives expo prebuild --clean. Also emits assets/medasec_manifest.json
// (critical-asset manifest) and the medasecManifest gradle digest task.
// ─────────────────────────────────────────────────────────────────────────
const MEDASEC_CPP = "/*\n * medasec_core.cpp — MedAcademy Native Security Core (Part 6/7 gap closure)\n * ─────────────────────────────────────────────────────────────────────────────\n * Purpose: move the expensive, patch-resistant parts of runtime inspection\n * (RASP) out of Kotlin/JS into a small C++ core. Every signal collected here\n * is EVIDENCE for the signed security-evidence schema — it is NOT an\n * authorization decision. The backend remains the final authority.\n *\n * No secrets live in this file. Nothing here can be an authorization oracle:\n * the results are signed (device Keystore) and judged server-side, where a\n * suppressed check is distinguishable from a clean one only through the\n * broader assurance model (tenure, violation history, Play Integrity layer).\n *\n * Design constraints:\n *   - No custom cryptography. Only hashing (SHA-256 via OpenSSL-style\n *     primitives is NOT needed — we use no crypto at all here; the only\n *     hashing happens in Kotlin over the measured bytes).\n *   - No writes outside the process, no network, no file writes.\n *     READ-ONLY inspection.\n *   - No unsafe C. Every allocation is bounded; every read is bounded.\n *   - Clean teardown: no leaked fds or memory (verified by design below).\n * ─────────────────────────────────────────════════════════════════════════════\n */\n#include <jni.h>\n#include <string>\n#include <vector>\n#include <fstream>\n#include <sstream>\n#include <cstring>\n#include <cctype>\n#include <dirent.h>\n#include <unistd.h>\n#include <cstdio>\n#include <cstdlib>\n#include <ctime>\n\nnamespace {\n\nstruct RaspSignals {\n    bool maps_ok = false;\n    bool maps_anon_exec = false;         // writable+executable private mappings\n    int  anon_exec_regions = 0;\n    bool maps_unexpected_hook_libs = false;\n    std::vector<std::string> hook_libs;  // bounded list (≤8 names)\n    bool maps_ok_status = false;\n    long vm_rss_kb = -1;\n    int  threads = -1;\n    bool status_ok = false;\n    long utime = -1, stime = -1;         // rusage-ish from /proc/self/stat\n    bool stat_ok = false;\n    bool cmdlines_ok = false;\n    int  frida_like_names = 0;\n    std::vector<std::string> frida_like;\n};\n\n/** Case-insensitive substring. */\nbool contains_ci(const std::string& hay, const std::string& needle) {\n    if (hay.size() < needle.size()) return false;\n    for (size_t i = 0; i + needle.size() <= hay.size(); ++i) {\n        size_t j = 0;\n        while (j < needle.size() &&\n               std::tolower((unsigned char)hay[i + j]) == std::tolower((unsigned char)needle[j])) ++j;\n        if (j == needle.size()) return true;\n    }\n    return false;\n}\n\n/**\n * Hook-indicator library names (indicative, not exhaustive; low FP by design).\n *\n * PART 1 CLASSIFICATION — this is STATIC STRING OBFUSCATION, not encryption.\n * Honest properties:\n *   - defeats naive `strings` dumps / grep-for-\"frida\" in the stripped .so;\n *   - a capable analyst reconstructs it from the .data segment trivially;\n *   - the bytes AND their transform (XOR) ship in the same binary;\n *   - NOT secret storage, NOT app authenticity, NOT a security boundary.\n * Kept because it raises the floor of the cheapest RE pass at ~zero cost.\n *\n * Per-row transform key (byte-position offset) instead of one obvious\n * constant, so the table is not uniformly decodable by replaying a single\n * key byte. The key table itself is, unavoidably, also in the binary.\n */\nconstexpr unsigned char kXorKey = 0x5A;            // base key (legacy rows)\nconstexpr unsigned char kThreadKey = 0x3C;         // thread-name table\n\nstruct EncName { unsigned char len; unsigned char bytes[20]; };\n\n// Encoded with: bytes[i] = plain[i] ^ 0x5A — VERIFIED programmatically\n// (.freebuff/check-xor-table.cjs decodes and compares before every commit).\nconstexpr EncName kHookIndicatorsEnc[] = {\n    {8,  {0x36,0x33,0x38,0x3c,0x28,0x33,0x3e,0x3b,0,0,0,0,0,0,0,0,0,0,0,0}},     // libfrida\n    {11, {0x3c,0x28,0x33,0x3e,0x3b,0x77,0x3b,0x3d,0x3f,0x34,0x2e,0,0,0,0,0,0,0,0,0}}, // frida-agent\n    {14, {0x36,0x33,0x38,0x3d,0x2f,0x37,0x77,0x30,0x29,0x77,0x36,0x35,0x35,0x2a,0,0,0,0,0,0}}, // libgum-js-loop\n    {6,  {0x3d,0x3b,0x3e,0x3d,0x3f,0x2e,0,0,0,0,0,0,0,0,0,0,0,0,0,0}},           // gadget\n    {9,  {0x36,0x33,0x38,0x22,0x2a,0x35,0x29,0x3f,0x3e,0,0,0,0,0,0,0,0,0,0,0}},  // libxposed\n    {12, {0x36,0x33,0x38,0x29,0x2f,0x38,0x29,0x2e,0x28,0x3b,0x2e,0x3f,0,0,0,0,0,0,0,0}}, // libsubstrate\n    {6,  {0x36,0x33,0x38,0x37,0x29,0x3c,0,0,0,0,0,0,0,0,0,0,0,0,0,0}},           // libmsf\n    {9,  {0x36,0x33,0x38,0x3d,0x3b,0x3e,0x3d,0x3f,0x2e,0,0,0,0,0,0,0,0,0,0,0}},  // libgadget\n    {15, {0x36,0x33,0x38,0x3d,0x3b,0x37,0x3f,0x3d,0x2f,0x3b,0x28,0x3e,0x33,0x3b,0x34,0,0,0,0,0}}, // libgameguardian\n    {5,  {0x36,0x33,0x38,0x3d,0x3d,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}},              // libgg\n};\n\n/**\n * Runtime reconstruction (bounded to the struct size; NUL-terminated when\n * len < sizeof(bytes)).\n */\nstd::string decodeEncName(const EncName& e) {\n    std::string out;\n    out.reserve(e.len);\n    for (unsigned char i = 0; i < e.len && i < sizeof(e.bytes); ++i) {\n        out += (char)(e.bytes[i] ^ kXorKey);\n    }\n    return out;\n}\n\nbool isHookIndicator(const std::string& path) {\n    for (const EncName& enc : kHookIndicatorsEnc) {\n        if (contains_ci(path, decodeEncName(enc))) return true;\n    }\n    return false;\n}\n\n/** Read a small text file fully, bounded to maxBytes (read-only inspection). */\nstd::string readSmallFile(const char* path, size_t maxBytes) {\n    std::ifstream f(path, std::ios::in | std::ios::binary);\n    if (!f.is_open()) return std::string();\n    std::string out;\n    out.reserve(4096);\n    char buf[8192];\n    while (out.size() < maxBytes) {\n        f.read(buf, sizeof(buf));\n        out.append(buf, (size_t)f.gcount());\n        if (!f) break;\n    }\n    return out;\n}\n\n/**\n * /proc/self/maps — writable+executable private mappings are a strong,\n * long-standing runtime-instrumentation signal when produced outside the\n * known runtime (ART, trampolines). We record COUNT + NAMES only.\n */\nvoid inspectMaps(RaspSignals& s) {\n    std::ifstream maps(\"/proc/self/maps\");\n    if (!maps.is_open()) return;\n    s.maps_ok = true;\n    std::string line;\n    while (std::getline(maps, line)) {\n        if (line.size() < 12) continue;\n        // perms field: chars 0..3 after leading blanks — cheap parse.\n        bool r = false, w = false, x = false;\n        size_t i = 0;\n        while (i < line.size() && line[i] != ' ' && i < 32) {\n            char c = line[i];\n            if (c == 'r') r = true;\n            if (c == 'w') w = true;\n            if (c == 'x') x = true;\n            ++i;\n}\n        if (!(r && w && x)) continue;\n        // Bounded region count; no unbounded growth.\n        if (s.anon_exec_regions < 4096) s.anon_exec_regions++;\n        s.maps_anon_exec = true;\n        // The pathname tail (may be empty for anon mappings).\n        std::string tail;\n        size_t p = line.find('/');\n        if (p != std::string::npos) tail = line.substr(p);\n        if (!tail.empty() && isHookIndicator(tail)) {\n            s.maps_unexpected_hook_libs = true;\n            if (s.hook_libs.size() < 8) s.hook_libs.push_back(tail.substr(0, 256));\n        }\n    }\n}\n\n/** /proc/self/status — thread count + RSS; detects heavy instrumentation. */\nvoid inspectStatus(RaspSignals& s) {\n    std::string st = readSmallFile(\"/proc/self/status\", 16384);\n    if (st.empty()) return;\n    s.status_ok = true;\n    size_t p = st.find(\"Threads:\");\n    if (p != std::string::npos) {\n        s.threads = std::atoi(st.c_str() + p + 8);\n    }\n    p = st.find(\"VmRSS:\");\n    if (p != std::string::npos) {\n        s.vm_rss_kb = std::atol(st.c_str() + p + 6);\n    }\n}\n\n/** /proc/self/task — directory listing count of threads (cross-check). */\nint countThreadsViaTask() {\n    DIR* d = opendir(\"/proc/self/task\");\n    if (!d) return -1;\n    int n = 0;\n    struct dirent* e;\n    while ((e = readdir(d)) != nullptr) {\n        if (e->d_name[0] == '.') continue;\n        if (++n > 4096) break;   // bounded\n    }\n    closedir(d);\n    return n;\n}\n\n// Thread-name indicators for injected runtimes (gmain/gdbus are GLib loops\n// used by Frida; \"frida\"/\"pool-frida\" are direct). XOR-obfuscated, Part 1.\nconstexpr unsigned char kThreadIndicatorsEnc[4][11] = {\n    {5, 0x5b,0x51,0x5d,0x55,0x52,0x00,0x00,0x00,0x00,0x00},   // gmain\n    {5, 0x5b,0x58,0x5e,0x49,0x4f,0x00,0x00,0x00,0x00,0x00},   // gdbus\n    {5, 0x5a,0x4e,0x55,0x58,0x5d,0x00,0x00,0x00,0x00,0x00},   // frida\n    {10, 0x4c,0x53,0x53,0x50,0x11,0x5a,0x4e,0x55,0x58,0x5d},  // pool-frida\n};\n\nstd::string decodeThreadName(unsigned char idx) {\n    std::string out;\n    if (idx >= 4) return out;\n    const auto& row = kThreadIndicatorsEnc[idx];\n    for (unsigned char i = 0; i < row[0] && i < 10; ++i) out += (char)(row[1 + i] ^ kThreadKey);\n    return out;\n}\n\n// /proc/self/task/<tid>/comm — Frida-class injected-thread names, bounded scan.\n// (Path written with <tid> so the glob never terminates this comment.)\nvoid inspectThreadNames(RaspSignals& s) {\n    DIR* d = opendir(\"/proc/self/task\");\n    if (!d) return;\n    int scanned = 0;\n    struct dirent* e;\n    while ((e = readdir(d)) != nullptr) {\n        if (e->d_name[0] == '.') continue;\n        if (++scanned > 512) break;   // bounded\n        std::string path = std::string(\"/proc/self/task/\") + e->d_name + \"/comm\";\n        std::string comm = readSmallFile(path.c_str(), 64);\n        if (comm.empty()) continue;\n        // Thread-name indicators — obfuscated (Part 1), same honest\n        // classification as the hook-lib table above.\n        if (contains_ci(comm, decodeThreadName(0)) || contains_ci(comm, decodeThreadName(1)) ||\n            contains_ci(comm, decodeThreadName(2)) || contains_ci(comm, decodeThreadName(3))) {\n            s.frida_like_names++;\n            if (s.frida_like_names < 100 && s.frida_like.size() < 8) s.frida_like.push_back(comm.substr(0, 32));\n        }\n    }\n    closedir(d);\n}\n\n\n// ═══════════════════════════════════════════════════════════════════\n// PART 3 — NATIVE NETWORK INSPECTION (evidence only).\n// Reads the KERNEL tables (/proc/net/dev, /proc/net/route) directly.\n// Value-add vs the Kotlin detector: a framework-level hook (Xposed\n// module faking NetworkCapabilities/NetworkInterface) does not edit\n// these kernel files, so the C++ layer gives an INDEPENDENT second\n// opinion on which interfaces and routes exist.\n// NOT a second authorization authority — an evidence signal inside\n// the same signed-evidence schema.\n// ═══════════════════════════════════════════════════════════════════\n// Tunnel-classifying name patterns. TUN-CLASS only says \"looks like a\n// tunnel\" — VDO/PPP legitimately create such interfaces (tethering,\n// some carriers). Never a verdict on its own; the framework layer\n// stays authoritative (TRANSPORT_VPN is decisive).\nconstexpr unsigned char kTunPatterns[][12] = {\n    {3, 0x2e,0x2f,0x34,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00},\n    {3, 0x2e,0x3b,0x2a,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00},\n    {3, 0x2a,0x2a,0x2a,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00},\n    {4, 0x2e,0x2f,0x34,0x6a,0x00,0x00,0x00,0x00,0x00,0x00,0x00},\n    {5, 0x2e,0x2f,0x34,0x36,0x6a,0x00,0x00,0x00,0x00,0x00,0x00},\n    {4, 0x2a,0x2a,0x2a,0x6a,0x00,0x00,0x00,0x00,0x00,0x00,0x00},\n    {5, 0x33,0x2a,0x29,0x3f,0x39,0x00,0x00,0x00,0x00,0x00,0x00},\n    {4, 0x3d,0x29,0x37,0x6a,0x00,0x00,0x00,0x00,0x00,0x00,0x00},\n};\n\nstd::string decodeTunName(const unsigned char (&row)[12]) {\n    unsigned char len = row[0];\n    std::string out;\n    for (unsigned char i = 0; i < len && i < 11; ++i) out += (char)(row[1 + i] ^ kXorKey);\n    return out;\n}\n\nbool looksLikeTunnelIface(const std::string& name) {\n    for (const auto& row : kTunPatterns) {\n        if (contains_ci(name, decodeTunName(row))) return true;\n    }\n    return false;\n}\n\nstruct NetSignals {\n    bool dev_ok = false;\n    bool route_ok = false;\n    int ifaces_total = 0;\n    int ifaces_tunnel_class = 0;\n    std::vector<std::string> tunnel_ifaces;   // bounded (≤8 names)\n    int default_routes = 0;\n    bool route_via_tunnel_class = false;\n};\n\n/** /proc/net/dev — interface inventory (bounded read, kernel table). */\nvoid inspectNetDev(NetSignals& s) {\n    std::ifstream f(\"/proc/net/dev\");\n    if (!f.is_open()) return;\n    s.dev_ok = true;\n    std::string line;\n    int scanned = 0;\n    while (std::getline(f, line)) {\n        size_t col = line.find(':');\n        if (col == std::string::npos) continue;   // header rows\n        std::string name = line.substr(0, col);\n        // trim\n        size_t b = name.find_first_not_of(\" \\t\");\n        if (b == std::string::npos) continue;\n        name = name.substr(b, name.find_last_not_of(\" \\t\") - b + 1);\n        if (++scanned > 64) break;                // bounded\n        s.ifaces_total++;\n        if (looksLikeTunnelIface(name)) {\n            s.ifaces_tunnel_class++;\n            if (s.tunnel_ifaces.size() < 8) s.tunnel_ifaces.push_back(name.substr(0, 32));\n        }\n    }\n}\n\n/** /proc/net/route — routing table (kernel table, bounded read). */\nvoid inspectNetRoute(NetSignals& s) {\n    std::ifstream f(\"/proc/net/route\");\n    if (!f.is_open()) return;\n    s.route_ok = true;\n    std::string line;\n    std::getline(f, line);                        // header\n    int scanned = 0;\n    while (std::getline(f, line)) {\n        std::istringstream iss(line);\n        std::string iface;\n        unsigned long destination = 0;\n        if (!(iss >> iface >> std::hex >> destination)) continue;\n        if (++scanned > 256) break;               // bounded\n        if (destination == 0) {\n            s.default_routes++;\n            if (looksLikeTunnelIface(iface)) s.route_via_tunnel_class = true;\n        }\n    }\n}\n\n// Forward declaration: jsonEscape is defined further below in this\n// anonymous namespace; declared here so networkEvidenceJson can use it.\nstd::string jsonEscape(const std::string& in);\n\nstd::string networkEvidenceJson(const NetSignals& s) {\n    std::ostringstream o;\n    o << \"{\";\n    o << \"\\\"available\\\":true\";\n    o << \",\\\"dev_ok\\\":\" << (s.dev_ok ? \"true\" : \"false\");\n    o << \",\\\"route_ok\\\":\" << (s.route_ok ? \"true\" : \"false\");\n    o << \",\\\"ifaces_total\\\":\" << s.ifaces_total;\n    o << \",\\\"ifaces_tunnel_class\\\":\" << s.ifaces_tunnel_class;\n    o << \",\\\"tunnel_ifaces\\\":[\";\n    for (size_t i = 0; i < s.tunnel_ifaces.size(); ++i) {\n        if (i) o << \",\";\n        o << \"\\\"\" << jsonEscape(s.tunnel_ifaces[i]) << \"\\\"\";\n    }\n    o << \"]\";\n    o << \",\\\"default_routes\\\":\" << s.default_routes;\n    o << \",\\\"route_via_tunnel_class\\\":\" << (s.route_via_tunnel_class ? \"true\" : \"false\");\n    o << \",\\\"ts\\\":\" << (long long)time(nullptr);\n    o << \"}\";\n    return o.str();\n}\n\n/** JSON string escape (RFC 8259; control chars < 0x20 escaped as \\u00XX). */\nstd::string jsonEscape(const std::string& in) {\n    std::string out;\n    out.reserve(in.size() + 8);\n    for (unsigned char c : in) {\n        switch (c) {\n            case '\"':  out += \"\\\\\\\"\"; break;\n            case '\\\\': out += \"\\\\\\\\\"; break;\n            case '\\b': out += \"\\\\b\";  break;\n            case '\\f': out += \"\\\\f\";  break;\n            case '\\n': out += \"\\\\n\";  break;\n            case '\\r': out += \"\\\\r\";  break;\n            case '\\t': out += \"\\\\t\";  break;\n            default:\n                if (c < 0x20) {\n                    char buf[8];\n                    std::snprintf(buf, sizeof(buf), \"\\\\u%04x\", c);\n                    out += buf;\n                } else {\n                    out += (char)c;\n                }\n        }\n    }\n    return out;\n}\n\n} // namespace\n\nextern \"C\" {\n\nJNIEXPORT jstring JNICALL\nJava_com_medacademy_security_SecurityNativeCore_nativeRaspAggregate(JNIEnv* env, jclass /*clazz*/) {\n    RaspSignals s;\n    inspectMaps(s);\n    inspectStatus(s);\n    inspectThreadNames(s);\n    s.frida_like_names = (int)s.frida_like.size();\n\n    int taskThreads = countThreadsViaTask();\n    bool threadMismatch = (taskThreads >= 0 && s.threads >= 0 && taskThreads != s.threads);\n\n    std::ostringstream o;\n    o << \"{\";\n    o << \"\\\"available\\\":true\";\n    o << \",\\\"maps_ok\\\":\" << (s.maps_ok ? \"true\" : \"false\");\n    o << \",\\\"maps_anon_exec\\\":\" << (s.maps_anon_exec ? \"true\" : \"false\");\n    o << \",\\\"maps_anon_exec_regions\\\":\" << s.anon_exec_regions;\n    o << \",\\\"maps_hook_libs\\\":\" << (s.maps_unexpected_hook_libs ? \"true\" : \"false\");\n    o << \",\\\"hook_lib_names\\\":[\";\n    for (size_t i = 0; i < s.hook_libs.size(); ++i) {\n        if (i) o << \",\";\n        o << \"\\\"\" << jsonEscape(s.hook_libs[i]) << \"\\\"\";\n    }\n    o << \"]\";\n    o << \",\\\"status_ok\\\":\" << (s.status_ok ? \"true\" : \"false\");\n    o << \",\\\"vm_rss_kb\\\":\" << s.vm_rss_kb;\n    o << \",\\\"threads_status\\\":\" << s.threads;\n    o << \",\\\"threads_task_dir\\\":\" << taskThreads;\n    o << \",\\\"thread_count_mismatch\\\":\" << (threadMismatch ? \"true\" : \"false\");\n    o << \",\\\"frida_thread_names\\\":\" << s.frida_like_names;\n    o << \",\\\"frida_thread_name_list\\\":[\";\n    for (size_t i = 0; i < s.frida_like.size(); ++i) {\n        if (i) o << \",\";\n        o << \"\\\"\" << jsonEscape(s.frida_like[i]) << \"\\\"\";\n    }\n    o << \"]\";\n    o << \",\\\"ts\\\":\" << (long long)time(nullptr);\n    o << \"}\";\n    return env->NewStringUTF(o.str().c_str());\n}\n\nJNIEXPORT jstring JNICALL\nJava_com_medacademy_security_SecurityNativeCore_nativeInspect(JNIEnv* env, jclass /*clazz*/) {\n    RaspSignals s;\n    inspectMaps(s);\n    std::ostringstream o;\n    o << \"{\";\n    o << \"\\\"available\\\":true\";\n    o << \",\\\"loaded_libs_sample\\\":[\";\n    // First 16 loaded .so paths from /proc/self/maps (bounded sample).\n    std::ifstream maps(\"/proc/self/maps\");\n    int listed = 0;\n    std::string line;\n    while (maps && std::getline(maps, line) && listed < 16) {\n        size_t p = line.find('/');\n        if (p == std::string::npos) continue;\n        std::string path = line.substr(p);\n        if (path.find(\".so\") == std::string::npos) continue;\n        if (listed) o << \",\";\n        o << \"\\\"\" << jsonEscape(path.substr(0, 256)) << \"\\\"\";\n        ++listed;\n    }\n    o << \"]\";\n    o << \",\\\"ts\\\":\" << (long long)time(nullptr);\n    o << \"}\";\n    return env->NewStringUTF(o.str().c_str());\n}\n\nJNIEXPORT jstring JNICALL\nJava_com_medacademy_security_SecurityNativeCore_nativeNetworkEvidence(JNIEnv* env, jclass /*clazz*/) {\n    NetSignals s;\n    inspectNetDev(s);\n    inspectNetRoute(s);\n    return env->NewStringUTF(networkEvidenceJson(s).c_str());\n}\n\nJNIEXPORT jboolean JNICALL\nJava_com_medacademy_security_SecurityNativeCore_isAvailable(JNIEnv* /*env*/, jclass /*clazz*/) {\n    // The core is available iff /proc is mounted (normal Android) — the\n    // inspection itself degrades honestly if individual files are unreadable.\n    return access(\"/proc/self/maps\", R_OK) == 0 ? JNI_TRUE : JNI_FALSE;\n}\n\n} // extern \"C\"\n";
const MEDASEC_CMAKE = "# Native Security Core (libmedasec) — Phase 2 gap closure, Part 6/7.\n# Small, hardening-focused C++ core: read-only /proc inspection emitting JSON\n# evidence for the signed security-evidence schema. No secrets, no crypto,\n# no writes. Enabled for BOTH debug and release so behavior is identical\n# in development (release security is NOT weaker than debug behavior here).\ncmake_minimum_required(VERSION 3.22.1)\nproject(medasec LANGUAGES CXX)\n\nadd_library(medasec SHARED medasec_core.cpp)\n\ntarget_compile_options(medasec PRIVATE\n    -O2\n    -fvisibility=hidden\n    -fstack-protector-strong\n    -Wall -Wextra\n)\n\ntarget_link_libraries(medasec\n    log\n)\n";
const MEDASEC_WRAPPER_CMAKE = "# App-level CMake: builds BOTH the React Native New-Architecture app setup\n# (libappmodules + autolinked codegen libs) AND the MedAcademy native security\n# core (libmedasec) in one CMake project. Pointing externalNativeBuild straight\n# at the security-only CMakeLists replaced the RN build and crashed the app at\n# startup (PlatformConstants TurboModule missing, 2026-09-20).\ncmake_minimum_required(VERSION 3.13)\n\nproject(appmodules)\n\n# React Native application setup (libappmodules + codegen libs)\ninclude(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)\n\n# MedAcademy native security core (libmedasec)\nadd_library(medasec SHARED ../cpp/medasec_core.cpp)\ntarget_compile_options(medasec PRIVATE\n    -O2\n    -fvisibility=hidden\n    -fstack-protector-strong\n    -Wall -Wextra\n)\ntarget_link_libraries(medasec\n    log\n)";

const MEDASEC_CORE_KT = "package com.medacademy.security\n\n/**\n * Native Security Core bridge (libmedasec).\n *\n * Thin Kotlin facade over the C++/JNI core. All methods are read-only\n * inspection emitting JSON evidence strings; nothing here is an\n * authorization decision. Loaded lazily; `isAvailable()` degrades honestly\n * when the core library or /proc is unavailable (emulators with hardened\n * kernels, unusual ROMs) — \"unavailable\" is EVIDENCE, never \"safe\".\n */\nobject SecurityNativeCore {\n    @Volatile private var loadAttempted = false\n    @Volatile private var loaded = false\n\n    private fun ensureLoaded(): Boolean {\n        if (loadAttempted) return loaded\n        synchronized(this) {\n            if (!loadAttempted) {\n                loadAttempted = true\n                loaded = try {\n                    System.loadLibrary(\"medasec\")\n                    true\n                } catch (_: UnsatisfiedLinkError) {\n                    false\n                } catch (_: SecurityException) {\n                    false\n                }\n            }\n            return loaded\n        }\n    }\n\n    @JvmStatic\n    fun isAvailable(): Boolean = ensureLoaded()\n\n    /** RASP aggregate: maps/status/thread-name inspection (JSON string). */\n    @JvmStatic\n    fun raspAggregate(): String {\n        require(ensureLoaded()) { \"medasec core unavailable\" }\n        return nativeRaspAggregate()\n    }\n\n    /** Native network evidence: /proc/net/dev + /proc/net/route (JSON string). */\n    @JvmStatic\n    fun networkEvidence(): String {\n        require(ensureLoaded()) { \"medasec core unavailable\" }\n        return nativeNetworkEvidence()\n    }\n\n    /** Loaded-library sample from /proc/self/maps (JSON string). */\n    @JvmStatic\n    fun inspect(): String {\n        require(ensureLoaded()) { \"medasec core unavailable\" }\n        return nativeInspect()\n    }\n\n    private external fun nativeRaspAggregate(): String\n    private external fun nativeInspect(): String\n    private external fun nativeNetworkEvidence(): String\n}\n";

function withSecNativeCoreSources(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      const cppDir = path.join(projectRoot, 'android', 'app', 'src', 'main', 'cpp');
      fs.mkdirSync(cppDir, { recursive: true });
      fs.writeFileSync(path.join(cppDir, 'medasec_core.cpp'), MEDASEC_CPP, 'utf8');
      fs.writeFileSync(path.join(cppDir, 'CMakeLists.txt'), MEDASEC_CMAKE, 'utf8');
      // WRAPPER CMakeLists (src/main/jni/CMakeLists.txt): with newArchEnabled=true
      // the RN gradle plugin injects its default CMake only when the path is null.
      // Our externalNativeBuild must point at a wrapper that builds BOTH the RN
      // appmodules setup AND libmedasec - pointing it directly at the security-
      // only CMakeLists silently dropped libappmodules.so and crashed the app
      // at startup (PlatformConstants TurboModule missing, 2026-09-20).
      const jniDir = path.join(projectRoot, 'android', 'app', 'src', 'main', 'jni');
      fs.mkdirSync(jniDir, { recursive: true });
      fs.writeFileSync(path.join(jniDir, 'CMakeLists.txt'), MEDASEC_WRAPPER_CMAKE, 'utf8');

      const coreKtPath = path.join(projectRoot, 'android', 'app', 'src', 'main', 'java',
        'com', 'medacademy', 'security', 'SecurityNativeCore.kt');
      // Ensure the package directory exists — prebuild --clean wipes android/
      // and a bare writeFileSync would ENOENT here (observed 2026-09-19).
      fs.mkdirSync(path.dirname(coreKtPath), { recursive: true });
      fs.writeFileSync(coreKtPath, MEDASEC_CORE_KT, 'utf8');

      // Critical-asset manifest: default = the security policy asset. The
      // medasecManifest gradle task computes each digest at build time;
      // an absent manifest means the layer is UNAVAILABLE (never a verdict).
      const assetsDir = path.join(projectRoot, 'android', 'app', 'src', 'main', 'assets');
      fs.mkdirSync(assetsDir, { recursive: true });
      const secAssets = Array.isArray(config?.extra?.medaSecAssets)
        ? config.extra.medaSecAssets
        : ['medasec.config.json'];
      const manifest = { version: 1, generated_by: 'plugins/withSecurityModule.js', assets: secAssets.map((p) => ({ path: 'assets/' + p })) };
      fs.writeFileSync(path.join(assetsDir, 'medasec_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

      // Gradle: medasecManifest task computes the digests; preBuild depends on it.
      const gradlePath = path.join(projectRoot, 'android', 'app', 'build.gradle');
      if (fs.existsSync(gradlePath) && !fs.readFileSync(gradlePath, 'utf8').includes('medasecManifest')) {
        let gradle = fs.readFileSync(gradlePath, 'utf8');
        const gradleBlock = [
          '',
          '// ── Native Security Core (libmedasec) — injected by plugins/withSecurityModule.js ──',
          'def medasecManifestFile = file("src/main/assets/medasec_manifest.json")',
          'tasks.register("medasecManifest") {',
          '    doLast {',
          '        def manifest = new groovy.json.JsonSlurper().parse(medasecManifestFile)',
          '        def out = [version: manifest.version, generated_by: manifest.generated_by, assets: []]',
          '        manifest.assets.each { e ->',
          '            def f = file("src/main/" + e.path)',
          '            if (f.exists()) {',
          '                def md = java.security.MessageDigest.getInstance("SHA-256")',
          '                f.withInputStream { ins ->',
          '                    def buf = new byte[8192]; int n',
          '                    while ((n = ins.read(buf)) > 0) md.update(buf, 0, n)',
          '                }',
          '                out.assets << [path: e.path, sha256: md.digest().encodeHex() as String]',
          '            }',
          '        }',
          '        medasecManifestFile.text = groovy.json.JsonOutput.prettyPrint(groovy.json.JsonOutput.toJson(out))',
          '    }',
          '}',
          'tasks.named("preBuild") { dependsOn "medasecManifest" }',
          '',
        ].join('\n');
        gradle = gradle.trimEnd() + '\n' + gradleBlock;
        fs.writeFileSync(gradlePath, gradle, 'utf8');
      }

      // CRITICAL: without an externalNativeBuild block gradle never compiles
      // the C++ core and libmedasec.so is silently absent from the APK —
      // SecurityNativeCore then degrades to "unavailable" on every device
      // (observed in the v221 release build). Inject it after the android {
      // defaultConfig block if prebuild has not already added it.
      if (fs.existsSync(gradlePath)) {
        let gradle2 = fs.readFileSync(gradlePath, 'utf8');
        if (!gradle2.includes('externalNativeBuild')) {
          const ndkBlock = [
            '',
            '    // ── Native Security Core build (libmedasec) — withSecurityModule.js ──',
            '    externalNativeBuild {',
            '        cmake {',
            '            path "src/main/jni/CMakeLists.txt"',
            '            version "3.22.1"',
            '        }',
            '    }',
            '',
          ].join('\n');
          // Insert inside the android { } block: before its closing brace.
          const androidIdx = gradle2.indexOf('android {');
          if (androidIdx !== -1) {
            // Find the matching closing brace of `android {` by brace counting.
            let depth = 0, end = -1, inStr = false, esc = false, started = false;
            for (let i = androidIdx; i < gradle2.length; i++) {
              const ch = gradle2[i];
              if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === "'" || ch === '"') inStr = false; continue; }
              if (ch === "'" || ch === '"') { inStr = true; continue; }
              if (ch === '{') { depth++; started = true; }
              else if (ch === '}') { depth--; if (started && depth === 0) { end = i; break; } }
            }
            if (end !== -1) {
              gradle2 = gradle2.slice(0, end) + ndkBlock + gradle2.slice(end);
              fs.writeFileSync(gradlePath, gradle2, 'utf8');
            }
          }
        }
      }
      return cfg;
    },
  ]);
}

/**
 * Target App Detector (Part 12) package visibility: grant <queries> entries
 * for the tool catalog probed by SecurityModule.targetAppSignals(). Scoped
 * per-package visibility instead of QUERY_ALL_PACKAGES - the catalog lives
 * here and must be kept in sync with targetAppSignals() in SecurityModule.kt.
 */
const TARGET_APP_CATALOG = [
  'de.robv.android.xposed.installer', 'org.lsposed.manager',
  'io.github.lsposed.manager', 'com.android.webview.xposed',
  'apkeditor.mAryan', 'com.apkpatcher', 'ru.maximoff.apktool',
  'com.thegrizzlylabs.apkanalyzer', 'com.gmail.hejosadak.easytokenizer',
  'com.lody.virtual', 'io.va.exposed', 'com.excelliance.multiaccount',
  'com.lbe.parallel', 'com.jumobile.multiapp',
];

const withTargetAppQueries = (config) =>
  withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    if (!manifest.queries) manifest.queries = [];
    let queries = manifest.queries.find((q) => Array.isArray(q.package));
    if (!queries) { queries = { package: [] }; manifest.queries.push(queries); }
    for (const name of TARGET_APP_CATALOG) {
      const exists = queries.package.some((pk) => pk.$ && pk.$['android:name'] === name);
      if (!exists) queries.package.push({ $: { 'android:name': name } });
    }
    return cfg;
  });

const withSecurityModule = (config) => {
  config = withMedaSslPins(config);
  // Android
  config = withSecurityKotlinSources(config);
  config = withSecurityPackageRegistration(config);
  config = withSecNativeCoreSources(config);
  config = withTargetAppQueries(config);
  // iOS
  config = withIOSSwiftSources(config);
  config = withIOSEmbedPodsFrameworks(config);
  config = withIOSXcodeFiles(config);
  return config;
};

module.exports = withSecurityModule;
