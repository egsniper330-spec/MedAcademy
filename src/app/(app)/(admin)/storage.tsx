/**
 * Storage Monitor — Admin & Super Admin
 * Shows Supabase Storage bucket info and usage.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, ActivityIndicator,
  RefreshControl, useColorScheme,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Database, HardDrive, Image, Film, FileText } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { getStorageStats } from '@/lib/api';
import { formatBytes } from '@/lib/videoUploadEngine';
import { NeuCard } from '@/components/NeuCard';
import { neuColors } from '@/lib/neu';

const BUCKET_ICONS: Record<string, React.ElementType> = {
  videos: Film, images: Image, avatars: Image, documents: FileText,
};

export default function StorageMonitorScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setStats(await getStorageStats()); } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const bucketColors = ['#1E90FF', '#7C3AED', '#16A34A', '#D97706', '#2DA8FF', '#DC2626'];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }} contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}>
      <View style={{ padding: 20 }}>
        <PageHeader title="Storage Monitor" subtitle="Supabase Storage + VdoCipher usage" accentColor="#2DA8FF" />

        {loading ? <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} /> : stats && (
          <>
            {/* Summary row */}
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
              <NeuCard style={{ flex: 1, padding: 14, alignItems: 'center', gap: 4 }}>
                <HardDrive size={18} color={c.primary} />
                <Text style={{ fontSize: 20, fontWeight: '900', color: c.primary }}>{stats.totalBuckets}</Text>
                <Text style={{ fontSize: 10, color: c.text, opacity: 0.5 }}>Buckets</Text>
              </NeuCard>
              <NeuCard style={{ flex: 1, padding: 14, alignItems: 'center', gap: 4 }}>
                <Film size={18} color="#7C3AED" />
                <Text style={{ fontSize: 20, fontWeight: '900', color: '#7C3AED' }}>
                  {formatBytes(stats.plyrStorage ?? 0)}
                </Text>
                <Text style={{ fontSize: 10, color: c.text, opacity: 0.5 }}>Plyr Storage</Text>
              </NeuCard>
              <NeuCard style={{ flex: 1, padding: 14, alignItems: 'center', gap: 4 }}>
                <Film size={18} color="#2DA8FF" />
                <Text style={{ fontSize: 20, fontWeight: '900', color: '#2DA8FF' }}>
                  {stats.vdoVideoCount ?? 0}
                </Text>
                <Text style={{ fontSize: 10, color: c.text, opacity: 0.5 }}>VdoCipher Videos</Text>
              </NeuCard>
            </View>

            {/* Provider breakdown */}
            <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 10 }}>Provider Breakdown</Text>
            <NeuCard style={{ marginBottom: 16, padding: 16, gap: 12 }}>
              {/* Plyr row */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#7C3AED18', alignItems: 'center', justifyContent: 'center' }}>
                  <Film size={18} color="#7C3AED" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>Plyr (Supabase Storage)</Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>Active uploads only (excludes failed/canceled)</Text>
                </View>
                <Text style={{ fontSize: 15, fontWeight: '800', color: '#7C3AED' }}>
                  {formatBytes(stats.plyrStorage ?? 0)}
                </Text>
              </View>

              <View style={{ height: 1, backgroundColor: `${c.text}10` }} />

              {/* VdoCipher row */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#2DA8FF18', alignItems: 'center', justifyContent: 'center' }}>
                  <Film size={18} color="#2DA8FF" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>VdoCipher (External CDN)</Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{stats.vdoStorageNote}</Text>
                </View>
                <Text style={{ fontSize: 15, fontWeight: '800', color: '#2DA8FF' }}>
                  {stats.vdoVideoCount ?? 0} videos
                </Text>
              </View>

              <View style={{ height: 1, backgroundColor: `${c.text}10` }} />

              {/* Total row */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
                  <Database size={18} color={c.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>Total Local Storage</Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>Supabase-hosted files</Text>
                </View>
                <Text style={{ fontSize: 15, fontWeight: '800', color: c.primary }}>
                  {formatBytes(stats.totalLocalBytes ?? 0)}
                </Text>
              </View>
            </NeuCard>

            <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 14 }}>Buckets</Text>
            {stats.buckets.length === 0 ? (
              <NeuCard style={{ padding: 40, alignItems: 'center' }}>
                <Database size={36} color={c.primary} opacity={0.25} />
                <Text style={{ color: c.text, opacity: 0.4, marginTop: 16 }}>No storage buckets found</Text>
              </NeuCard>
            ) : stats.buckets.map((bucket: any, i: number) => {
              const color = bucketColors[i % bucketColors.length];
              const BucketIcon = BUCKET_ICONS[bucket.name] ?? Database;
              return (
                <NeuCard key={bucket.id} style={{ marginBottom: 12, padding: 16 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{ width: 46, height: 46, borderRadius: 14, backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
                      <BucketIcon size={20} color={color} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{bucket.name}</Text>
                      <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>ID: {bucket.id}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 6 }}>
                      <View style={{ backgroundColor: bucket.public ? '#16A34A18' : '#DC262618', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: bucket.public ? '#16A34A' : '#DC2626' }}>
                          {bucket.public ? 'Public' : 'Private'}
                        </Text>
                      </View>
                      {bucket.file_size_limit && (
                        <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>
                          Limit: {(bucket.file_size_limit / 1024 / 1024).toFixed(0)} MB
                        </Text>
                      )}
                    </View>
                  </View>
                  {bucket.allowed_mime_types?.length > 0 && (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10, marginLeft: 60 }}>
                      {bucket.allowed_mime_types.slice(0, 4).map((mime: string) => (
                        <View key={mime} style={{ backgroundColor: `${color}15`, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
                          <Text style={{ fontSize: 10, color, fontWeight: '600' }}>{mime}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                </NeuCard>
              );
            })}
          </>
        )}
      </View>
    </ScrollView>
  );
}
