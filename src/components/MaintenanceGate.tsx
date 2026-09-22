/**
 * MaintenanceGate — rendered at the ROOT level (inside ForceUpdateGate).
 *
 * Shows a full-screen MAINTENANCE page when the server-authoritative verdict
 * is MAINTENANCE, and automatically recovers (re-renders the app) when the
 * maintenance service polls GET /maintenance and the backend reports
 * enabled=false. Never shows for offline, never logs out, never blocks
 * security checks.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import { useColorScheme } from 'react-native';
import { Wrench } from 'lucide-react-native';
import { subscribeMaintenance } from '@/lib/maintenanceService';
import { neuColors, useLayout } from '@/lib/neu';
import { DEFAULT_MAINTENANCE_MESSAGE } from '@/lib/maintenanceStateModel';

export function MaintenanceGate({ children }: { children: React.ReactNode }) {
  const [verdict, setVerdict] = useState<{ state: string; message?: string; retryAfter?: number }>({ state: 'NORMAL' });
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  useEffect(() => subscribeMaintenance((v) => setVerdict(v)), []);

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
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: layout.pad.lg }}>
          <ActivityIndicator size="small" color={c.primary} />
          <Text style={{ color: c.text, opacity: 0.5, marginLeft: layout.pad.sm, fontSize: layout.captionSize }}>
            Checking availability…
          </Text>
        </View>
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
