/**
 * StorageMonitor.tsx
 * Doctor storage usage widget — neumorphic card showing video storage stats.
 */

import { useCallback, useState } from 'react';
import { Text, useColorScheme, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { HardDrive, Film, TrendingUp, Maximize2 } from 'lucide-react-native';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, neuFlatStyle, neuPressedStyle } from '@/lib/neu';
import { getDoctorStorageStats, formatBytes, type DoctorStorageStats } from '@/lib/videoUploadEngine';
import { useProfileStore } from '@/lib/store';

function StatRow({
  icon: Icon, label, value, color, isDark,
}: {
  icon: any; label: string; value: string; color: string; isDark: boolean;
}) {
  const c = isDark ? neuColors.dark : neuColors.light;
  return (
    <View style={[neuFlatStyle(isDark), { borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
      <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={16} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, fontWeight: '600' }}>{label}</Text>
        <Text style={{ fontSize: 14, fontWeight: '800', color: c.text, marginTop: 1 }}>{value}</Text>
      </View>
    </View>
  );
}

export function StorageMonitor() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { profile } = useProfileStore();
  const [stats, setStats] = useState<DoctorStorageStats | null>(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(useCallback(() => {
    if (!profile?.id) return;
    (async () => {
      setLoading(true);
      const s = await getDoctorStorageStats(profile.id);
      setStats(s);
      setLoading(false);
    })();
  }, [profile?.id]));

  if (loading || !stats) return null;
  if (stats.totalVideos === 0) return null;

  return (
    <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 18, padding: 16, gap: 12 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 }}>
        <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
          <HardDrive size={16} color={c.primary} />
        </View>
        <Text style={{ fontSize: 14, fontWeight: '800', color: c.text }}>Storage Usage</Text>
      </View>

      <StatRow icon={Film}       label="Uploaded Videos"  value={`${stats.totalVideos}`}                       color={c.primary}  isDark={isDark} />
      <StatRow icon={HardDrive}  label="Total Storage"    value={formatBytes(stats.totalBytes)}                 color="#7C3AED"    isDark={isDark} />
      <StatRow icon={TrendingUp} label="Avg. File Size"   value={formatBytes(stats.avgFileSizeBytes)}           color="#D97706"    isDark={isDark} />
      <StatRow icon={Maximize2}  label="Largest Video"    value={stats.largestFileName.replace(/\.[^.]+$/, '')} color="#16A34A"    isDark={isDark} />
    </NeuCard>
  );
}
