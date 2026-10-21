/**
 * ForceUpdateScreen — the UI face of the remote version-enforcement system.
 *
 * Rendered ONLY for a CONFIRMED mandatory update (verdict UPDATE_REQUIRED): by
 * the root ForceUpdateGate / (app) gate for the protected shell, and by
 * UpdateAuthGate for the authentication screens.
 *
 * There is deliberately no "checking for updates" state here: the version check
 * is a background request, so an unresolved verdict renders the normal app
 * instead of this page (that blocking startup screen was the reported defect).
 * This screen is NOT the security boundary — the server's HTTP 426 enforcement
 * is; this screen reflects the authoritative state in updateConfigService.
 *
 * Version names are display-only. The FORCED/OPTIONAL decision is made from
 * the integer versionCode comparison (authoritative) — never string compare.
 */

import React, { useEffect, useRef, useState } from 'react';
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

import { BrandLogo } from '@/components/BrandLogo';
import { NeuButton } from '@/components/NeuButton';
import { useUpdate } from '@/lib/useForceUpdate';
import { t } from '@/lib/i18n';

// MedAcademy palette (matches the security-gate styling conventions).
const C = {
  bg: '#0B1120',
  card: '#111A2E',
  border: '#1E2A44',
  text: '#E6EDF7',
  sub: '#8FA3C0',
  accent: '#3B82F6',
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

  // UNMOUNT SAFETY: both handlers below await asynchronous work (opening the
  // update URL, re-running the remote check) and the screen is unmounted the
  // instant the verdict clears or the shell re-renders without a block. Without
  // this guard a late resolution would call setState on an unmounted component.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const required = update.verdict === 'UPDATE_REQUIRED';
  const forced = update.mode === 'FORCED';
  // Only a confirmed requirement takes over the screen. An unresolved check
  // never renders a blocking state (see the header note).
  const showGate = required;

  // OPTIONAL mode → dismissible banner over normal app content.
  if (!showGate) {
    return (
      <View style={styles.optionalWrap} pointerEvents="box-none">
        <View style={styles.optionalBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.optionalTitle}>{t('update.newVersion')}</Text>
            <Text style={styles.optionalSub} numberOfLines={1}>
              {update.latestVersionName
                ? `${update.installedVersionName} → ${update.latestVersionName}`
                : t('update.optionalSubFallback')}
            </Text>
          </View>
          <Pressable style={styles.optionalBtn} onPress={() => openExternal(update.updateUrl)}>
            <Text style={styles.optionalBtnText}>{t('update.update')}</Text>
          </Pressable>
          <Pressable style={styles.laterBtn} onPress={update.dismissOptional}>
            <Text style={styles.laterBtnText}>{t('update.later')}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const onPrimary = async (): Promise<void> => {
    setLaunching(true);
    setLaunchError(null);
    const r = await update.openUpdateUrl();
    if (!mountedRef.current) return;
    if (!r.ok) setLaunchError(r.error ?? t('update.couldNotOpen'));
    setLaunching(false);
  };

  const onManualRecheck = async (): Promise<void> => {
    setChecking(true);
    try {
      await update.recheck();
    } finally {
      if (mountedRef.current) setChecking(false);
    }
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
          <View style={styles.logo}>
            <BrandLogo variant="icon" size={82} />
          </View>
          <View style={styles.badgeRow}>
            <View style={[styles.badge, forced ? styles.badgeForced : styles.badgeOptional]}>
              <Text style={styles.badgeText}>{forced ? t('update.badgeRequired') : t('update.badgeOptional')}</Text>
            </View>
            {update.usingCachedVerdict ? (
              <View style={[styles.badge, styles.badgeWarn]}>
                <Text style={styles.badgeText}>{t('update.badgeOffline')}</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.title}>
            {forced ? t('update.required') : t('update.newVersion')}
          </Text>
          <Text style={styles.subtitle}>
            {forced ? t('update.subtitleForced') : t('update.subtitleOptional')}
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>{t('update.currentVersion')}</Text>
            <Text style={styles.rowValue}>
              {update.installedVersionName || '—'}
              {update.installedVersionCode > 0 ? ` (build ${update.installedVersionCode})` : ''}
            </Text>
          </View>
          <View style={[styles.row, styles.rowLast]}>
            <Text style={styles.rowLabel}>{t('update.latestVersion')}</Text>
            <Text style={[styles.rowValue, styles.rowValueAccent]}>
              {update.latestVersionName
                ? `${update.latestVersionName}${update.latestVersionCode > 0 ? ` (build ${update.latestVersionCode})` : ''}`
                : '—'}
            </Text>
          </View>
        </View>

        {update.releaseNotes ? (
          <View style={styles.card}>
            <Text style={styles.notesTitle}>{t('update.whatsNew')}</Text>
            <Text style={styles.notes}>{update.releaseNotes}</Text>
          </View>
        ) : null}

        {launchError ? (
          <View style={[styles.card, styles.cardError]}>
            <Text style={styles.errorTitle}>{t('update.linkProblem')}</Text>
            <Text style={styles.errorText}>{launchError}</Text>
            {update.updateUrl ? (
              <Text style={styles.errorUrl} numberOfLines={1} selectable>
                {update.updateUrl}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* PRIMARY CTA — the exact shared component the Login screen's
            "Sign In" button uses: NeuButton variant="primary" + fullWidth.
            Design-token background (neuColors.primary), white label
            typography, neumorphic press feedback, haptics — visually
            identical to Sign In. fullWidth centers it across the scroll
            content by construction on every device class/orientation;
            paddingVertical (spacing.md) + label line height give a ~48pt
            touch target (≥44pt accessibility minimum). The accessible name
            is the label itself: "Update Now". */}
        <NeuButton
          label={t('update.updateNow')}
          onPress={onPrimary}
          loading={launching}
          variant="primary"
          fullWidth
          style={styles.primaryBtn}
        />

        <Text style={styles.hint}>
          {forced
            ? t('update.cannotUse')
            : t('update.keepUsing')}
        </Text>

        <Pressable onPress={onManualRecheck} disabled={checking} style={styles.recheckBtn}>
          {checking ? (
            <ActivityIndicator size="small" color={C.sub} />
          ) : (
            <Text style={styles.recheckText}>{t('update.checkAgain')}</Text>
          )}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 20, paddingBottom: 48 },
  hero: { marginTop: 28, marginBottom: 20 },
  logo: {
    overflow: 'hidden',
    width: 84, height: 84, borderRadius: 20, marginBottom: 18,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
  },
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
  primaryBtn: { marginTop: 8 },
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
