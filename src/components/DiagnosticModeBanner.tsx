/**
 * DiagnosticModeBanner — the VISIBLE marker of a diagnostic (security-test) build.
 *
 * WHY IT EXISTS
 * ─────────────
 * A build that waives local device-environment checks must be impossible to
 * confuse with a protected production build — by the developer, by a tester, or
 * by anyone glancing at the screen. This banner is rendered ABOVE the navigator
 * at the app root, so it is present on the login screen, on the dashboard and on
 * every other route, and it takes layout space so it cannot be missed.
 *
 * RENDERS NOTHING in a production build: the only condition is the build-time
 * constant from `@/lib/securityTestBuild`, which is statically `false` there.
 * There is no runtime, storage, remote or prop input that can turn it on.
 *
 * The same module writes the one-shot `[DIAG-BUILD]` Logcat marker, so the
 * build's status is verifiable from `adb logcat` alone.
 */
import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  DIAGNOSTIC_WAIVED_CHECKS,
  SECURITY_TEST_BUILD,
  logDiagnosticBuildStatus,
} from '@/lib/securityTestBuild';

export default function DiagnosticModeBanner() {
  const insets = useSafeAreaInsets();

  useEffect(() => {
    // No-op in production (the constant is false there).
    logDiagnosticBuildStatus();
  }, []);

  if (!SECURITY_TEST_BUILD) return null;

  return (
    <View
      testID="diagnostic-build-banner"
      accessibilityRole="alert"
      accessibilityLabel="Diagnostic build. Security checks are waived. Not for production."
      style={[styles.wrap, { paddingTop: insets.top + 6 }]}
    >
      <Text style={styles.title}>DIAGNOSTIC BUILD — SECURITY CHECKS WAIVED</Text>
      <Text style={styles.body} numberOfLines={2}>
        NOT FOR PRODUCTION · waived locally: {DIAGNOSTIC_WAIVED_CHECKS.join(', ')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    // Deliberately theme-independent and high-contrast: this must never be
    // mistaken for one of the app's own surfaces.
    backgroundColor: '#B00020',
    paddingHorizontal: 12,
    paddingBottom: 6,
    borderBottomWidth: 2,
    borderBottomColor: '#FFD400',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  body: {
    color: '#FFE9EC',
    fontSize: 9.5,
    fontWeight: '700',
    marginTop: 2,
  },
});
