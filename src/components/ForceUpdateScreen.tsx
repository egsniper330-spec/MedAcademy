/**
 * ForceUpdateScreen — the UI face of the remote version-enforcement system.
 *
 * Rendered by the root ForceUpdateGate whenever the authoritative update state
 * (src/lib/updateConfigService.ts) is UPDATE_REQUIRED (or UNKNOWN during the
 * fail-closed startup check). This screen is NOT the security boundary — the
 * server's HTTP 426 enforcement is; this screen reflects the authoritative
 * state maintained by updateConfigService.
 *
 * Version names are display-only. The FORCED/OPTIONAL decision is made from
 * the integer versionCode comparison (authoritative) — never string compare.
 */

import React, { useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useUpdate } from '@/lib/useForceUpdate';

// MedAcademy palette (matches the security-gate styling conventions).
const C = {
  bg: '#0B1120',
  card: '#111A2E',
  border: '#1E2A44',
  text: '#E6EDF7',
  sub: '#8FA3C0',
  accent: '#3B82F6',
  accentPress: '#2D6FD2',
  ok: '#22C55E',
  warn: '#F59E0B',
  err: '#EF4444',
};

function openExternal(url: string): void {
  void Linking.openURL(url);
}

export default function ForceUpdateScreen(): React.JSX.Element {
  const update = useUpdate();
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const required = update.verdict === 'UPDATE_REQUIRED';
  const forced = update.mode === 'FORCED';
  const showGate = required || (update.verdict === 'UNKNOWN' && update.evaluating);

  // Fail-closed startup wall — first check still in flight.
  if (update.verdict === 'UNKNOWN' && update.evaluating) {
    return (
      <View style={[styles.root, styles.center]} accessibilityLabel="Checking for updates">
        <ActivityIndicator size="large" color={C.accent} />
        <Text style={styles.checkingTitle}>Checking for updates…</Text>
        <Text style={styles.checkingSub}>
          This will only take a moment.{'\n'}You need the latest MedAcademy to continue.
        </Text>
      </View>
    );
  }

  // OPTIONAL mode → dismissible banner over normal app content.
  if (!showGate) {
    return (
      <View style={styles.optionalWrap} pointerEvents="box-none">
        <View style={styles.optionalBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.optionalTitle}>New version available</Text>
            <Text style={styles.optionalSub} numberOfLines={1}>
              {update.latestVersionName
                ? `${update.installedVersionName} → ${update.latestVersionName}`
                : 'An update is available for MedAcademy.'}
            </Text>
          </View>
          <Pressable style={styles.optionalBtn} onPress={() => openExternal(update.updateUrl)}>
            <Text style={styles.optionalBtnText}>Update</Text>
          </Pressable>
          <Pressable style={styles.laterBtn} onPress={update.dismissOptional}>
            <Text style={styles.laterBtnText}>Later</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const onPrimary = async (): Promise<void> => {
    setLaunching(true);
    setLaunchError(null);
    const r = await update.openUpdateUrl();
    if (!r.ok) setLaunchError(r.error ?? 'Could not open the update link.');
    setLaunching(false);
  };

  const onManualRecheck = async (): Promise<void> => {
    setChecking(true);
    await update.recheck();
    setChecking(false);
  };

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        bounces={false}
        // FORCED: the screen itself is the whole app until the verdict clears.
        // No gesture dismiss, no backdoor, no skip.
      >
        <View style={styles.hero}>
          <View style={styles.badgeRow}>
            <View style={[styles.badge, forced ? styles.badgeForced : styles.badgeOptional]}>
              <Text style={styles.badgeText}>{forced ? 'UPDATE REQUIRED' : 'OPTIONAL UPDATE'}</Text>
            </View>
            {update.usingCachedVerdict ? (
              <View style={[styles.badge, styles.badgeWarn]}>
                <Text style={styles.badgeText}>OFFLINE — USING LAST VERDICT</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.title}>
            {forced ? 'Update Required' : 'New version available'}
          </Text>
          <Text style={styles.subtitle}>
            {forced
              ? "You're using an older version of MedAcademy.\nPlease update to continue using the app."
              : 'A newer version of MedAcademy is available.\nUpdating is recommended.'}
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Current version</Text>
            <Text style={styles.rowValue}>{update.installedVersionName}</Text>
          </View>
          <View style={[styles.row, styles.rowLast]}>
            <Text style={styles.rowLabel}>Latest version</Text>
            <Text style={[styles.rowValue, styles.rowValueAccent]}>
              {update.latestVersionName || '—'}
            </Text>
          </View>
        </View>

        {update.releaseNotes ? (
          <View style={styles.card}>
            <Text style={styles.notesTitle}>What's new</Text>
            <Text style={styles.notes}>{update.releaseNotes}</Text>
          </View>
        ) : null}

        {launchError ? (
          <View style={[styles.card, styles.cardError]}>
            <Text style={styles.errorTitle}>Update link problem</Text>
            <Text style={styles.errorText}>{launchError}</Text>
            {update.updateUrl ? (
              <Text style={styles.errorUrl} numberOfLines={1} selectable>
                {update.updateUrl}
              </Text>
            ) : null}
          </View>
        ) : null}

        <Pressable
          style={({ pressed }) => [
            styles.primaryBtn,
            pressed && { backgroundColor: C.accentPress },
          ]}
          onPress={onPrimary}
          disabled={launching}
          accessibilityRole="button"
          accessibilityLabel="Update now"
        >
          {launching ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>Update Now</Text>
          )}
        </Pressable>

        <Text style={styles.hint}>
          {forced
            ? 'MedAcademy cannot be used until it is updated.'
            : 'You can keep using the app and update later.'}
        </Text>

        <Pressable onPress={onManualRecheck} disabled={checking} style={styles.recheckBtn}>
          {checking ? (
            <ActivityIndicator size="small" color={C.sub} />
          ) : (
            <Text style={styles.recheckText}>Check again</Text>
          )}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center', padding: 32 },
  scroll: { padding: 20, paddingBottom: 48 },
  checkingTitle: { color: C.text, fontSize: 17, fontWeight: '600', marginTop: 18, textAlign: 'center' },
  checkingSub: { color: C.sub, fontSize: 13, marginTop: 8, textAlign: 'center', lineHeight: 19 },
  hero: { marginTop: 28, marginBottom: 20 },
  badgeRow: { flexDirection: 'row', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
  badge: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999,
    backgroundColor: C.border, alignSelf: 'flex-start',
  },
  badgeForced: { backgroundColor: 'rgba(239,68,68,0.16)' },
  badgeOptional: { backgroundColor: 'rgba(59,130,246,0.16)' },
  badgeWarn: { backgroundColor: 'rgba(245,158,11,0.16)' },
  badgeText: { color: C.text, fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  title: { color: C.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.4 },
  subtitle: { color: C.sub, fontSize: 14, lineHeight: 21, marginTop: 8 },
  card: {
    backgroundColor: C.card, borderColor: C.border, borderWidth: 1,
    borderRadius: 14, padding: 16, marginBottom: 12,
  },
  cardError: { borderColor: 'rgba(239,68,68,0.5)' },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: { color: C.sub, fontSize: 14 },
  rowValue: { color: C.text, fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  rowValueAccent: { color: C.ok },
  notesTitle: { color: C.text, fontSize: 13, fontWeight: '700', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  notes: { color: C.sub, fontSize: 14, lineHeight: 20 },
  errorTitle: { color: C.err, fontSize: 13, fontWeight: '700', marginBottom: 4 },
  errorText: { color: C.text, fontSize: 14, lineHeight: 20 },
  errorUrl: { color: C.sub, fontSize: 12, marginTop: 6 },
  primaryBtn: {
    backgroundColor: C.accent, borderRadius: 14, paddingVertical: 16,
    alignItems: 'center', marginTop: 8,
  },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: 0.2 },
  hint: { color: C.sub, fontSize: 12, textAlign: 'center', marginTop: 14, lineHeight: 18 },
  recheckBtn: { alignSelf: 'center', padding: 12, marginTop: 4 },
  recheckText: { color: C.sub, fontSize: 13, fontWeight: '600' },
  optionalWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center' },
  optionalBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: C.card, borderColor: C.border, borderWidth: 1,
    borderRadius: 14, padding: 12, margin: 12,
  },
  optionalTitle: { color: C.text, fontSize: 14, fontWeight: '700' },
  optionalSub: { color: C.sub, fontSize: 12, marginTop: 2 },
  optionalBtn: { backgroundColor: C.accent, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 },
  optionalBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  laterBtn: { paddingHorizontal: 8, paddingVertical: 9 },
  laterBtnText: { color: C.sub, fontSize: 13, fontWeight: '600' },
});
