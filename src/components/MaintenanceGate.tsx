/**
 * MaintenanceGate — rendered at the ROOT level (inside ForceUpdateGate).
 *
 * UX CONTRACT (the "Checking availability…" bug):
 * The screen is STATIC the moment it appears — icon, title, server message,
 * "Please try again later." NO spinner, NO "Checking availability…" text, no
 * retry UI. Recovery polling happens invisibly in the background
 * (maintenanceService.probeMaintenanceStatus); the ONLY visible change is the
 * transition back to the normal app when the server reports maintenance OFF.
 *
 * ─── RECOVERY (epoch-based, no restart/re-login) ─────────────────────────────
 * When the gate is mounted, a maintenance epoch is active. On transition back
 * to NORMAL with a session still present, maintenanceEpoch() increments and
 * the shell re-runs its normal server-authoritative bootstrap (profile
 * refresh, revocation poll — see (app)/_layout.tsx). Whitelist add/remove is
 * therefore effective immediately: the next server request re-evaluates the
 * gate per-request; the client never caches a bypass.
 *
 * Offline while the screen is up: probes skip (NetInfo) and the UI stays
 * exactly as-is; when connectivity returns the poll resumes silently.
 */

import React, { useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useColorScheme } from 'react-native';
import { Wrench } from 'lucide-react-native';
import {
  subscribeMaintenance,
  getMaintenanceVerdict,
} from '@/lib/maintenanceService';
import { neuColors, useLayout } from '@/lib/neu';
import { DEFAULT_MAINTENANCE_MESSAGE } from '@/lib/maintenanceStateModel';

/** Bumped every time a MAINTENANCE→NORMAL recovery completes. */
let recoveryEpoch = 0;
export function maintenanceEpoch(): number {
  return recoveryEpoch;
}

export function MaintenanceGate({ children }: { children: React.ReactNode }) {
  const [verdict, setVerdict] = React.useState(getMaintenanceVerdict());
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  // Silent recovery → re-bootstrap the authenticated shell. The epoch bumps
  // ONLY on a real transition (subscribeMaintenance's initial callback fires
  // with the CURRENT verdict — counting it would re-bootstrap on mount), and
  // (app)/_layout re-runs its normal server-authoritative bootstrap when it
  // changes. Whitelist changes take effect without restart or re-login.
  useEffect(
    () =>
      subscribeMaintenance((v) => {
        setVerdict((prev) => {
          if (prev.state === 'MAINTENANCE' && v.state === 'NORMAL') {
            recoveryEpoch += 1;
          }
          return v;
        });
      }),
    []
  );

  if (verdict.state !== 'MAINTENANCE') {
    return <>{children}</>;
  }

  return (
    <View style={[styles.container, { backgroundColor: c.base }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={[styles.iconWrap, { backgroundColor: `${c.primary}18` }]}>
          <Wrench size={Math.round(layout.touchTarget * 1.4)} color={c.primary} />
        </View>
        <Text style={[styles.title, { color: c.text }]}>Maintenance Mode</Text>
        <Text style={[styles.message, { color: c.text }]}>
          {verdict.message?.trim() || DEFAULT_MAINTENANCE_MESSAGE}
        </Text>
        <Text style={[styles.sub, { color: c.text }]}>Please try again later.</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  iconWrap: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  title: { fontSize: 22, fontWeight: '800', marginBottom: 12, textAlign: 'center' },
  message: { fontSize: 15, textAlign: 'center', lineHeight: 22, opacity: 0.75, marginBottom: 8 },
  sub: { fontSize: 13, opacity: 0.45, textAlign: 'center' },
});
