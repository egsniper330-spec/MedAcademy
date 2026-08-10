/**
 * Security Diagnostics Screen
 *
 * Shows every security detector's raw native result, final JS decision,
 * native execution time, whether the native module was actually invoked,
 * and any exception thrown. Accessible to superadmin only.
 *
 * This screen DIRECTLY calls NativeModules.SecurityModule — it does NOT
 * use the security.ts pipeline — so it proves module registration
 * independently of any caching layer.
 */

import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, useColorScheme,
  ActivityIndicator, useWindowDimensions,
} from 'react-native';
import { NativeModules } from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  ShieldCheck, ShieldAlert, ShieldX, RefreshCw,
  CheckCircle, XCircle, AlertCircle, Clock, Cpu, Activity,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { DrawerProvider } from '@/components/DrawerContext';
import DrawerNav from '@/components/DrawerNav';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout, neuFlatStyle, neuMicroStyle, safeBottom } from '@/lib/neu';
import type { NativeSecurityFlags } from '@/lib/nativeSecurity';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DetectorResult {
  key:         string;
  label:       string;
  value:       boolean | null;
  error:       string | null;
  /** native API(s) used and why each returns what it returns */
  apiExplain:  string;
  /** set to true if a false result is expected on stock/non-rooted devices */
  falseOnStock: boolean;
  /** set to true for flags that are IMPOSSIBLE to get reliably due to Android restrictions */
  restricted:  boolean;
  restrictedReason?: string;
}

interface DiagState {
  moduleFound:   boolean;
  moduleMethods: string[];
  rawFlags:      NativeSecurityFlags | null;
  rawError:      string | null;
  elapsedMs:     number | null;
  detectors:     DetectorResult[];
  runAt:         Date | null;
}

// ─── Per-detector metadata ────────────────────────────────────────────────────

const DETECTOR_META: Record<string, { label: string; apiExplain: string; falseOnStock: boolean; restricted?: boolean; restrictedReason?: string }> = {
  developerOptionsEnabled: {
    label: 'Developer Options',
    apiExplain: 'Settings.Global.DEVELOPMENT_SETTINGS_ENABLED — reads the Settings DB integer. Returns true when the user has toggled "Developer Options" in Settings → About Phone → 7× build-number taps. Always false on a factory-reset device with no dev options enabled.',
    falseOnStock: true,
  },
  adbEnabled: {
    label: 'USB Debugging (ADB)',
    apiExplain: 'Settings.Global.ADB_ENABLED — reads the Settings DB integer. Returns true only when "USB Debugging" is explicitly enabled inside Developer Options. Requires Developer Options to be on first.',
    falseOnStock: true,
  },
  debuggerAttached: {
    label: 'Debugger Attached',
    apiExplain: 'android.os.Debug.isDebuggerConnected() — checks the JDWP handshake flag. Returns true only when an actual debugger (Android Studio, jdb) is attached. Always false in normal use.',
    falseOnStock: true,
  },
  testOnlyBuild: {
    label: 'Test-Only Build',
    apiExplain: 'ApplicationInfo.FLAG_TEST_ONLY — set by AGP when android:testOnly="true" in the manifest. Only true on special test APKs; never set on production or normal debug builds.',
    falseOnStock: true,
  },
  screenBeingRecorded: {
    label: 'Screen Recording',
    apiExplain: 'Android 14+ (API 34): WindowManager.isScreenRecorded(). API 33-: scans ActivityManager.getRunningServices() for known screen-capture service class names (screencapture, mediaprojection, etc.). Returns false when no recording service is active.',
    falseOnStock: true,
  },
  vpnDetected: {
    label: 'VPN Active',
    apiExplain: 'Tier-1: ConnectivityManager.getNetworkCapabilities(network).hasTransport(TRANSPORT_VPN) across ALL active networks (catches VPN-over-WiFi, VPN-over-LTE). Tier-2: NetworkInterface scan for tun*, vpn*, ppp*, ipsec* interfaces that VPN kernel drivers create. Either positive triggers detection.',
    falseOnStock: true,
  },
  rootDetected: {
    label: 'Root / Superuser',
    apiExplain: '6 independent heuristics: (1) su binary path scan (17 locations), (2) ro.debuggable=1 + ro.secure=0 system props, (3) Build.TAGS contains "test-keys", (4) /system write-test (rooted devices mount /system r/w), (5) shell "which su" output, (6) known root-manager package scan (Magisk, SuperSU, KingRoot). Stock unrooted devices return false on all 6.',
    falseOnStock: true,
  },
  emulatorDetected: {
    label: 'Emulator / AVD',
    apiExplain: '5 heuristics: (1) Build.FINGERPRINT starts with "generic"/"unknown" or contains "vbox"/"sdk", (2) Build.MODEL contains "emulator"/"genymotion"/"android sdk" or Build.HARDWARE is "goldfish"/"ranchu", (3) Build.MANUFACTURER is "unknown" or "Genymotion", (4) ro.kernel.qemu system property = "1", (5) SensorManager sensor count = 0 (physical phones always have ≥1 sensor). Real devices return false on all 5.',
    falseOnStock: true,
  },
  mockLocationDetected: {
    label: 'Mock Location',
    apiExplain: 'API 23+: AppOpsManager.checkOpNoThrow(OPSTR_MOCK_LOCATION) — returns MODE_ALLOWED only if the user explicitly granted mock-location permission to a specific app in Developer Options → Mock location app. API <23 fallback: Settings.Secure.ALLOW_MOCK_LOCATION. Returns false when no mock-location app is configured.',
    falseOnStock: true,
  },
  fridaDetected: {
    label: 'Frida / Dynamic Instrumentation',
    apiExplain: '6 methods: (1) TCP port 27042-27045 probe (Frida server default ports), (2) /proc/self/maps scan for "frida"/"gadget" memory-mapped libs, (3) /proc/*/cmdline scan for frida processes, (4) /proc/self/maps for loaded frida-agent .so, (5) known frida temp files in /data/local/tmp, (6) /proc/self/maps for gum-js-loop (Gum runtime). All return false on a clean device.',
    falseOnStock: true,
  },
  xposedDetected: {
    label: 'Xposed / LSPosed / EdXposed',
    apiExplain: '4 methods: (1) Class.forName("de.robv.android.xposed.XposedBridge") — ClassNotFoundException on clean devices, (2) Thread.currentThread().stackTrace scan for xposed/lsposed class names, (3) installed package scan (8 known Xposed manager packages), (4) known file paths (/system/framework/XposedBridge.jar, libxposed_art.so). All false on stock.',
    falseOnStock: true,
  },
  magiskDetected: {
    label: 'Magisk / Zygisk',
    apiExplain: '5 methods: (1) known Magisk path scan (/sbin/.magisk, /data/adb/magisk, etc.), (2) 5 known Magisk app packages (com.topjohnwu.magisk, etc.), (3) /proc/modules for "zygisk"/"magisk" kernel modules, (4) /proc/self/mounts for Magisk mirror mount points, (5) /proc/self/maps for /data/adb entries. DenyList can hide paths — combine with root check.',
    falseOnStock: true,
  },
  overlayDetected: {
    label: 'Overlay / Tapjacking',
    apiExplain: 'Checks which installed packages hold SYSTEM_ALERT_WINDOW permission (>5 suspicious). RESTRICTED: getRunningAppProcesses() and BIND_ACCESSIBILITY_SERVICE enumeration are blocked on Android 11+ for third-party apps. This check is a best-effort heuristic only.',
    falseOnStock: true,
    restricted: true,
    restrictedReason: 'Android 11+ blocks getRunningAppProcesses() for apps not in the same UID group. Overlay enumeration requires BIND_ACCESSIBILITY_SERVICE which the app does not hold. Detection is package-permission-based only — a sophisticated attacker can bypass by not holding the permission globally.',
  },
  signatureValid: {
    label: 'App Signature Valid',
    apiExplain: 'PackageManager.GET_SIGNING_CERTIFICATES (API 28+) or GET_SIGNATURES (API <28) — reads the APK signing certificate. Computes SHA-256 of the signing cert bytes and compares against BuildConfig.EXPECTED_CERT_SHA256 injected at build time. Returns TRUE (valid) in debug builds where EXPECTED_CERT_SHA256 is empty — the check is intentionally skipped.',
    falseOnStock: false,
  },
  tampered: {
    label: 'App Tampered / Repackaged',
    apiExplain: '3 checks: (1) installer package name must be com.android.vending (Play Store) in release builds, (2) signature SHA-256 must match expected fingerprint, (3) critical native libs (libreactnative.so or libhermes.so) must be present in nativeLibraryDir. In debug builds check (1) is skipped (installer = null is allowed).',
    falseOnStock: false,
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatusIcon({ value, restricted }: { value: boolean | null; restricted?: boolean }) {
  if (value === null) return <AlertCircle size={18} color="#F59E0B" />;
  if (restricted)      return <AlertCircle size={18} color="#F59E0B" />;
  // For signatureValid: true = good (green); for all others: false = good (green)
  return value
    ? <XCircle size={18} color="#EF4444" />
    : <CheckCircle size={18} color="#22C55E" />;
}

function statusColor(key: string, value: boolean | null): string {
  if (value === null) return '#F59E0B';
  if (key === 'signatureValid') return value ? '#22C55E' : '#EF4444';
  return value ? '#EF4444' : '#22C55E';
}

// ─── Main content ─────────────────────────────────────────────────────────────

function DiagnosticsContent() {
  const scheme  = useColorScheme();
  const isDark  = scheme === 'dark';
  const c       = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const insets = layout.insets;
  const { width } = useWindowDimensions();

  const [state, setState] = useState<DiagState>({
    moduleFound:   false,
    moduleMethods: [],
    rawFlags:      null,
    rawError:      null,
    elapsedMs:     null,
    detectors:     [],
    runAt:         null,
  });
  const [running, setRunning] = useState(false);

  const runDiagnostics = useCallback(async () => {
    setRunning(true);
    try {
      // ── Step 1: Prove module registration ─────────────────────────────
      const mod = NativeModules.SecurityModule ?? null;
      const moduleFound   = mod !== null;
      const moduleMethods = moduleFound ? Object.keys(mod).filter(k => typeof mod[k] === 'function') : [];

      // ── Step 2: Call getSecurityFlags directly, measure time ───────────
      let rawFlags:  NativeSecurityFlags | null = null;
      let rawError:  string | null = null;
      let elapsedMs: number | null = null;

      if (moduleFound) {
        const t0 = Date.now();
        try {
          rawFlags  = await (mod.getSecurityFlags() as Promise<NativeSecurityFlags>);
          elapsedMs = Date.now() - t0;
        } catch (e: unknown) {
          rawError  = e instanceof Error ? e.message : String(e);
          elapsedMs = Date.now() - t0;
        }
      }

      // ── Step 3: Build per-detector results ─────────────────────────────
      const detectors: DetectorResult[] = Object.entries(DETECTOR_META).map(([key, meta]) => ({
        key,
        label:           meta.label,
        value:           rawFlags ? (rawFlags as unknown as Record<string, boolean>)[key] ?? null : null,
        error:           rawError,
        apiExplain:      meta.apiExplain,
        falseOnStock:    meta.falseOnStock,
        restricted:      meta.restricted ?? false,
        restrictedReason: meta.restrictedReason,
      }));

      setState({
        moduleFound, moduleMethods, rawFlags, rawError,
        elapsedMs, detectors, runAt: new Date(),
      });
    } finally {
      setRunning(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void runDiagnostics(); }, [runDiagnostics]));

  const sectionPad = { paddingHorizontal: layout.screenPx };

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <PageHeader
        title="Security Diagnostics"
        rightAction={
          <Pressable
            onPress={() => { if (!running) void runDiagnostics(); }}
            accessibilityLabel="Rerun diagnostics"
            accessibilityRole="button"
            style={[{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }, neuMicroStyle(isDark)]}
          >
            {running
              ? <ActivityIndicator size="small" color={c.primary} />
              : <RefreshCw size={18} color={c.primary} />}
          </Pressable>
        }
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: 16, paddingBottom: layout.scrollBottom() }}
        contentInsetAdjustmentBehavior="automatic"
      >
        {/* ── Module registration proof ──────────────────────────────── */}
        <View style={sectionPad}>
          <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>
            Module Registration
          </Text>
          <NeuCard style={{ padding: 16, marginBottom: 20 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              {state.moduleFound
                ? <ShieldCheck size={22} color="#22C55E" />
                : <ShieldX size={22} color="#EF4444" />}
              <Text style={{ fontSize: 16, fontWeight: '800', color: c.text }}>
                NativeModules.SecurityModule {state.moduleFound ? '✓ registered' : '✗ NULL'}
              </Text>
            </View>

            {state.moduleFound && (
              <>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginBottom: 6 }}>
                  {state.moduleMethods.length} exported methods:
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {state.moduleMethods.map(m => (
                    <View key={m} style={{ backgroundColor: `${c.primary}18`, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
                      <Text style={{ fontSize: 11, color: c.primary, fontWeight: '600' }}>{m}()</Text>
                    </View>
                  ))}
                </View>
              </>
            )}

            {!state.moduleFound && (
              <Text style={{ fontSize: 13, color: '#EF4444', lineHeight: 20 }}>
                Module is null. This means SecurityModule was not compiled into the APK. Most likely cause: SecurityModule.kt contains a compile error (null byte, syntax error) OR SecurityPackage was not added to PackageList in MainApplication.kt. Check `adb logcat | grep -i "SecurityModule"` after a fresh build.
              </Text>
            )}
          </NeuCard>

          {/* ── Timing ──────────────────────────────────────────────── */}
          <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>
            Execution
          </Text>
          <NeuCard style={{ padding: 16, marginBottom: 20 }}>
            <View style={{ flexDirection: 'row', gap: 24 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Clock size={16} color={c.primary} />
                <Text style={{ fontSize: 14, color: c.text }}>
                  {state.elapsedMs !== null ? `${state.elapsedMs} ms` : '—'}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Activity size={16} color={c.primary} />
                <Text style={{ fontSize: 14, color: c.text }}>
                  {state.runAt ? state.runAt.toLocaleTimeString() : '—'}
                </Text>
              </View>
            </View>
            {state.rawError && (
              <View style={{ marginTop: 10, backgroundColor: '#EF444420', borderRadius: 8, padding: 10 }}>
                <Text style={{ fontSize: 12, color: '#EF4444', fontFamily: 'monospace' }}>
                  Exception: {state.rawError}
                </Text>
              </View>
            )}
          </NeuCard>

          {/* ── Raw native flags ──────────────────────────────────────── */}
          <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>
            Raw Native Result (unfiltered)
          </Text>
          <NeuCard style={{ padding: 16, marginBottom: 20 }}>
            {state.rawFlags ? (
              <Text style={{ fontSize: 11, color: c.primary, fontFamily: 'monospace', lineHeight: 18 }}>
                {JSON.stringify(state.rawFlags, null, 2)}
              </Text>
            ) : (
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.5 }}>
                {running ? 'Running…' : (state.rawError ? 'Error — see above' : 'No data yet')}
              </Text>
            )}
          </NeuCard>

          {/* ── Per-detector breakdown ────────────────────────────────── */}
          <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>
            Per-Detector Analysis
          </Text>
        </View>

        {/* detector cards */}
        <View style={sectionPad}>
          {state.detectors.length === 0 && !running && (
            <Text style={{ fontSize: 14, color: c.text, opacity: 0.45, textAlign: 'center', marginTop: 20 }}>
              Tap ↻ to run diagnostics
            </Text>
          )}

          {state.detectors.map((d) => {
            const valColor = statusColor(d.key, d.value);
            return (
              <NeuCard key={d.key} style={{ padding: 16, marginBottom: 12 }}>
                {/* header row */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <StatusIcon value={d.value} restricted={d.restricted} />
                  <Text style={{ flex: 1, fontSize: 14, fontWeight: '800', color: c.text }}>
                    {d.label}
                  </Text>
                  <View style={{ backgroundColor: `${valColor}20`, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: valColor }}>
                      {d.value === null ? 'N/A' : String(d.value).toUpperCase()}
                    </Text>
                  </View>
                </View>

                {/* key name */}
                <Text style={{ fontSize: 10, color: c.primary, fontFamily: 'monospace', marginBottom: 6, opacity: 0.7 }}>
                  flags.{d.key}
                </Text>

                {/* API explanation */}
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.65, lineHeight: 18 }}>
                  {d.apiExplain}
                </Text>

                {/* restricted warning */}
                {d.restricted && d.restrictedReason && (
                  <View style={{ marginTop: 8, backgroundColor: '#F59E0B18', borderRadius: 8, padding: 10 }}>
                    <Text style={{ fontSize: 11, color: '#F59E0B', lineHeight: 16 }}>
                      ⚠ API Restriction: {d.restrictedReason}
                    </Text>
                  </View>
                )}

                {/* "false on stock" note */}
                {d.falseOnStock && d.value === false && (
                  <View style={{ marginTop: 8, backgroundColor: '#22C55E18', borderRadius: 8, padding: 8 }}>
                    <Text style={{ fontSize: 11, color: '#22C55E', lineHeight: 16 }}>
                      ✓ Expected: false on a clean, unmodified device. Test by enabling the condition to confirm detection fires.
                    </Text>
                  </View>
                )}

                {/* unexpected false warning */}
                {d.value === false && !d.falseOnStock && (
                  <View style={{ marginTop: 8, backgroundColor: '#EF444418', borderRadius: 8, padding: 8 }}>
                    <Text style={{ fontSize: 11, color: '#EF4444', lineHeight: 16 }}>
                      ⚠ This detector should not return false on a production device. Investigate.
                    </Text>
                  </View>
                )}
              </NeuCard>
            );
          })}
        </View>

        {/* ── API restriction documentation ─────────────────────────── */}
        <View style={sectionPad}>
          <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10, marginTop: 8 }}>
            Android API Restrictions (Why Some Checks Have Limits)
          </Text>
          <NeuCard style={{ padding: 16, marginBottom: 8 }}>
            {[
              {
                title: 'Overlay Detection — getRunningAppProcesses()',
                body: 'Android 11+ (API 30+): apps can only see their own processes and selected system processes. Third-party overlay apps are invisible. No workaround exists without BIND_ACCESSIBILITY_SERVICE or a privileged system permission.',
              },
              {
                title: 'Root Detection — /proc/self/status TracerPid',
                body: 'Android 10+ restricts /proc/*/status reads. tracerpid= field is hidden from unprivileged readers. Use Debug.isDebuggerConnected() instead (already implemented).',
              },
              {
                title: 'Mock Location — GPS provider mock flag',
                body: 'LocationManager.isProviderEnabled(GPS_PROVIDER) no longer exposes whether the provider is mocked in API 31+. AppOpsManager.OPSTR_MOCK_LOCATION is the only reliable path (already implemented).',
              },
              {
                title: 'Screen Recording — MediaProjection session list',
                body: 'Android 14+ deprecated ActivityManager.getRunningServices(). WindowManager.isScreenRecorded() (API 34+) is the correct replacement and is already used. On API 33-, the service scan is a best-effort heuristic.',
              },
              {
                title: 'Emulator — sys.qemu.sf.lcd_density',
                body: 'Some QEMU properties (like sys.qemu.sf.lcd_density) require READ_PRIVILEGED_PHONE_STATE from API 29+. The implemented checks (Build.FINGERPRINT, model, hardware, sensor count) do not require any permission.',
              },
              {
                title: 'Certificate Pinning / Play Integrity',
                body: 'Play Integrity API requires Google Play Services. On devices without Play Services (AOSP, some Chinese ROMs), requestIntegrityToken() will throw PLAY_INTEGRITY_UNAVAILABLE. This is expected and handled gracefully.',
              },
            ].map((item, i) => (
              <View key={i} style={i > 0 ? { borderTopWidth: 1, borderTopColor: `${c.text}10`, paddingTop: 12, marginTop: 12 } : {}}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <Cpu size={13} color={c.primary} />
                  <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{item.title}</Text>
                </View>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.6, lineHeight: 18 }}>
                  {item.body}
                </Text>
              </View>
            ))}
          </NeuCard>
        </View>
      </ScrollView>
    </View>
  );
}

export default function SecurityDiagnosticsScreen() {
  return (
    <DrawerProvider>
      <View style={{ flex: 1 }}>
        <DiagnosticsContent />
        <DrawerNav />
      </View>
    </DrawerProvider>
  );
}
