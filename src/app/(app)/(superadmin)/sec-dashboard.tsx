import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  useColorScheme, RefreshControl, FlatList,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  ShieldAlert, ShieldCheck, Wifi, Globe, Bug, Lock,
  Fingerprint, Camera, AlertTriangle, TrendingUp,
  Users, BarChart3, Download, Filter,
} from 'lucide-react-native';
import { neuColors, useLayout, neuFlatStyle, neuPressedStyle, safeBottom } from '@/lib/neu';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { PageHeader } from '@/components/PageHeader';
import { useToast } from '@/components/Toast';
import { supabase } from '@/client/supabase';
import { friendlyError } from '@/lib/validation';
import { Share } from 'react-native';

interface SecurityStats {
  total_events:    number;
  root_jailbreak:  number;
  vpn:             number;
  proxy:           number;
  ssl_pinning:     number;
  screenshot:      number;
  screen_recording:number;
  debug:           number;
  app_integrity:   number;
}

interface RiskyDevice {
  device_id:      string;
  user_id:        string;
  user_name:      string;
  user_email:     string;
  max_risk_score: number;
  event_types:    string[];
  last_seen:      string;
  platform:       string;
}

interface SecurityEvent {
  id:               string;
  user_id:          string | null;
  device_id:        string | null;
  event_type:       string;
  detection_method: string | null;
  policy_action:    string | null;
  risk_score:       number;
  ip_address:       string | null;
  platform:         string | null;
  created_at:       string;
  profiles?:        { full_name: string; email: string } | null;
}

const EVENT_META: Record<string, { label: string; color: string; icon: React.ComponentType<{ size: number; color: string }> }> = {
  root_detected:             { label: 'Root',          color: '#EF4444', icon: ShieldAlert },
  jailbreak_detected:        { label: 'Jailbreak',     color: '#EF4444', icon: ShieldAlert },
  vpn_detected:              { label: 'VPN',           color: '#F59E0B', icon: Wifi },
  proxy_detected:            { label: 'Proxy',         color: '#F59E0B', icon: Globe },
  debug_detected:            { label: 'Debug',         color: '#8B5CF6', icon: Bug },
  frida_detected:            { label: 'Frida',         color: '#8B5CF6', icon: Fingerprint },
  xposed_detected:           { label: 'Xposed',        color: '#8B5CF6', icon: Fingerprint },
  ssl_pinning_failure:       { label: 'SSL Pinning',   color: '#EF4444', icon: Lock },
  screenshot_detected:       { label: 'Screenshot',    color: '#06B6D4', icon: Camera },
  screen_recording_detected: { label: 'Recording',     color: '#06B6D4', icon: Camera },
  app_integrity_compromised: { label: 'Integrity',     color: '#EF4444', icon: Lock },
};

const DAYS_OPTIONS = [7, 14, 30, 90];

export default function SecurityDashboard() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const insets = layout.insets;
  const flat = neuFlatStyle(isDark);
  const router = useRouter();
  const { showToast } = useToast();

  const [stats, setStats]           = useState<SecurityStats | null>(null);
  const [riskyDevices, setRiskyDevices] = useState<RiskyDevice[]>([]);
  const [recentEvents, setRecentEvents] = useState<SecurityEvent[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [days, setDays]             = useState(30);

  const load = useCallback(async () => {
    try {
      const startDate = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

      const [statsRes, devicesRes, eventsRes] = await Promise.all([
        supabase.rpc('get_security_stats', {
          p_start_date: startDate,
          p_end_date: new Date().toISOString(),
        }),
        supabase.rpc('get_risky_devices', { p_min_score: 20, p_limit: 20, p_offset: 0 }),
        supabase
          .from('security_events')
          .select('*, profiles(full_name, email)')
          .order('created_at', { ascending: false })
          .limit(50),
      ]);

      if (statsRes.data)   setStats(statsRes.data as SecurityStats);
      if (devicesRes.data) setRiskyDevices(devicesRes.data as RiskyDevice[]);
      if (eventsRes.data)  setRecentEvents(eventsRes.data as SecurityEvent[]);
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to load security data.') });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [days, showToast]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const onRefresh = () => { setRefreshing(true); void load(); };

  const handleExport = async () => {
    if (!recentEvents.length) return;
    const lines = [
      'Timestamp,User,Device,Event Type,Detection Method,Risk Score,Platform,Policy Action',
      ...recentEvents.map((e) =>
        `"${e.created_at}","${e.profiles?.full_name ?? e.user_id ?? ''}","${e.device_id ?? ''}","${e.event_type}","${e.detection_method ?? ''}",${e.risk_score},"${e.platform ?? ''}","${e.policy_action ?? ''}"`
      ),
    ];
    const csv = lines.join('\n');
    if (process.env.EXPO_OS === 'web') {
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'security-events.csv'; a.click();
      URL.revokeObjectURL(url);
    } else {
      await Share.share({ message: csv, title: 'Security Events Report' });
    }
  };

  const StatCard = ({
    label, value, icon: Icon, color,
  }: { label: string; value: number; icon: React.ComponentType<{ size: number; color: string }>; color: string }) => (
    <View style={[flat, {
      flex: 1, minWidth: 140, borderRadius: layout.cardRadius, padding: layout.cardPx,
      gap: layout.pad.sm, alignItems: 'flex-start',
    }]}>
      <View style={{
        width: layout.touchTarget * 0.82, height: layout.touchTarget * 0.82,
        borderRadius: layout.cardRadius / 1.5,
        backgroundColor: `${color}18`,
        alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={Math.round(layout.touchTarget * 0.42)} color={color} />
      </View>
      <Text style={{ fontSize: layout.titleSize, fontWeight: '800', color }}>{value ?? 0}</Text>
      <Text style={{ fontSize: layout.captionSize, color: `${c.text}77`, fontWeight: '600' }}>{label}</Text>
    </View>
  );

  const riskColor = (score: number) =>
    score >= 60 ? '#EF4444' : score >= 30 ? '#F59E0B' : '#22C55E';

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: c.base, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={c.primary} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <PageHeader title="Security Dashboard" />
      <ScrollView
        contentContainerStyle={{ padding: layout.screenPx, gap: layout.sectionGap, paddingBottom: layout.scrollBottom() }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
        contentInsetAdjustmentBehavior="automatic"
      >
        {/* Day Filter + Export */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: layout.pad.sm, flexWrap: 'wrap' }}>
          <Filter size={layout.bodySize} color={`${c.text}77`} />
          {DAYS_OPTIONS.map((d) => (
            <Pressable key={d} onPress={() => setDays(d)}
              style={[flat, {
                paddingHorizontal: layout.pad.md, paddingVertical: layout.pad.xs + 1, borderRadius: 20,
                backgroundColor: days === d ? c.primary : undefined,
              }]}>
              <Text style={{ fontSize: layout.captionSize, fontWeight: '600', color: days === d ? '#fff' : `${c.text}88` }}>
                {d}d
              </Text>
            </Pressable>
          ))}
          <View style={{ flex: 1 }} />
          <Pressable onPress={() => void handleExport()}
            style={[flat, { paddingHorizontal: layout.pad.md, paddingVertical: layout.pad.sm, borderRadius: 20, flexDirection: 'row', alignItems: 'center', gap: layout.pad.sm }]}>
            <Download size={layout.captionSize + 2} color={c.primary} />
            <Text style={{ fontSize: layout.captionSize, fontWeight: '600', color: c.primary }}>Export</Text>
          </Pressable>
        </View>

        {/* Overview Stats */}
        <Text style={{ fontSize: layout.bodySize + 2, fontWeight: '700', color: c.text }}>
          Overview — Last {days} Days
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: layout.itemGap }}>
          <StatCard label="Total Events"      value={stats?.total_events ?? 0}    icon={BarChart3}    color={c.primary} />
          <StatCard label="Root / Jailbreak"  value={stats?.root_jailbreak ?? 0}  icon={ShieldAlert}  color="#EF4444" />
          <StatCard label="VPN Detections"    value={stats?.vpn ?? 0}             icon={Wifi}         color="#F59E0B" />
          <StatCard label="Proxy Attempts"    value={stats?.proxy ?? 0}           icon={Globe}        color="#F59E0B" />
          <StatCard label="SSL Failures"      value={stats?.ssl_pinning ?? 0}     icon={Lock}         color="#EF4444" />
          <StatCard label="Screenshots"       value={stats?.screenshot ?? 0}      icon={Camera}       color="#06B6D4" />
          <StatCard label="Recordings"        value={stats?.screen_recording ?? 0}icon={Camera}       color="#06B6D4" />
          <StatCard label="Debug / Frida"     value={stats?.debug ?? 0}           icon={Bug}          color="#8B5CF6" />
          <StatCard label="Integrity Issues"  value={stats?.app_integrity ?? 0}   icon={ShieldAlert}  color="#EF4444" />
        </View>

        {/* Risky Devices */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: layout.pad.sm }}>
          <Users size={layout.bodySize + 2} color={c.primary} />
          <Text style={{ fontSize: layout.bodySize + 2, fontWeight: '700', color: c.text }}>
            Risky Devices ({riskyDevices.length})
          </Text>
        </View>
        {riskyDevices.length === 0 ? (
          <View style={[flat, { borderRadius: layout.cardRadius, padding: layout.cardPx * 1.5, alignItems: 'center', gap: layout.pad.sm }]}>
            <ShieldCheck size={Math.round(layout.touchTarget * 0.72)} color="#22C55E" />
            <Text style={{ fontSize: layout.bodySize, color: `${c.text}77` }}>No risky devices detected</Text>
          </View>
        ) : (
          riskyDevices.map((dev) => (
            <View key={dev.device_id} style={[flat, {
              borderRadius: layout.cardRadius, padding: layout.cardPx, gap: layout.pad.sm,
            }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: layout.pad.md }}>
                <View style={{
                  width: layout.touchTarget, height: layout.touchTarget,
                  borderRadius: layout.cardRadius,
                  backgroundColor: `${riskColor(dev.max_risk_score)}18`,
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <AlertTriangle size={Math.round(layout.touchTarget * 0.46)} color={riskColor(dev.max_risk_score)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.text }}>
                    {dev.user_name || 'Unknown User'}
                  </Text>
                  <Text style={{ fontSize: layout.captionSize, color: `${c.text}77` }}>{dev.user_email}</Text>
                </View>
                <View style={{
                  paddingHorizontal: layout.pad.sm, paddingVertical: layout.pad.xs, borderRadius: 20,
                  backgroundColor: `${riskColor(dev.max_risk_score)}18`,
                }}>
                  <Text style={{ fontSize: layout.bodySize, fontWeight: '800', color: riskColor(dev.max_risk_score) }}>
                    {dev.max_risk_score}
                  </Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: layout.pad.sm }}>
                {(dev.event_types ?? []).map((et) => {
                  const meta = EVENT_META[et];
                  if (!meta) return null;
                  return (
                    <View key={et} style={{
                      paddingHorizontal: layout.pad.sm, paddingVertical: layout.pad.xs, borderRadius: 20,
                      backgroundColor: `${meta.color}18`,
                    }}>
                      <Text style={{ fontSize: layout.captionSize, fontWeight: '600', color: meta.color }}>
                        {meta.label}
                      </Text>
                    </View>
                  );
                })}
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontSize: layout.captionSize, color: `${c.text}55` }}>
                  {dev.platform?.toUpperCase()} · {new Date(dev.last_seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </Text>
              </View>
            </View>
          ))
        )}

        {/* Recent Events */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: layout.pad.sm }}>
          <TrendingUp size={layout.bodySize + 2} color={c.primary} />
          <Text style={{ fontSize: layout.bodySize + 2, fontWeight: '700', color: c.text }}>
            Recent Events ({recentEvents.length})
          </Text>
        </View>
        {recentEvents.slice(0, 20).map((evt) => {
          const meta = EVENT_META[evt.event_type] ?? { label: evt.event_type, color: c.primary, icon: ShieldAlert };
          const Icon = meta.icon;
          return (
            <View key={evt.id} style={[flat, {
              borderRadius: layout.cardRadius, padding: layout.cardPx, flexDirection: 'row',
              alignItems: 'center', gap: layout.pad.md,
            }]}>
              <View style={{
                width: layout.touchTarget * 0.82, height: layout.touchTarget * 0.82,
                borderRadius: layout.cardRadius / 1.5,
                backgroundColor: `${meta.color}18`,
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Icon size={Math.round(layout.touchTarget * 0.42)} color={meta.color} />
              </View>
              <View style={{ flex: 1, gap: layout.pad.xs }}>
                <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.text }}>{meta.label}</Text>
                <Text style={{ fontSize: layout.captionSize, color: `${c.text}66` }}>
                  {evt.profiles?.full_name ?? evt.user_id?.slice(0, 8) ?? 'Unknown'} · {evt.platform ?? 'unknown'}
                </Text>
                <Text style={{ fontSize: layout.captionSize, color: `${c.text}55` }}>
                  {new Date(evt.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })}
                </Text>
              </View>
              <View style={{
                paddingHorizontal: layout.pad.sm, paddingVertical: layout.pad.xs, borderRadius: 20,
                backgroundColor: `${meta.color}18`,
              }}>
                <Text style={{ fontSize: layout.captionSize + 1, fontWeight: '700', color: meta.color }}>
                  {evt.risk_score}
                </Text>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
