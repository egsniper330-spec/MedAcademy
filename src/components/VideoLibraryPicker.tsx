/**
 * VideoLibraryPicker.tsx
 *
 * Bottom-sheet modal that lets a doctor choose a video from their library
 * instead of uploading a new copy. Features:
 *   - Live search + sort
 *   - Status filter chips
 *   - Per-item: thumbnail, title, duration, file size, upload date, usage count
 *   - Confirms selection and returns the chosen VideoAsset
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import {
  Check, ChevronDown, Clock, Film, Search, SortAsc, SortDesc, X,
} from 'lucide-react-native';
import { neuColors, neuFlatStyle, neuPressedStyle } from '@/lib/neu';
import {
  getMyVideoLibrary, type VideoAsset, type LibraryFilters,
} from '@/lib/videoLibraryApi';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (asset: VideoAsset) => void;
}

function formatDuration(sec: number | null): string {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATUS_FILTERS = [
  { value: 'all',        label: 'All' },
  { value: 'ready',      label: 'Ready' },
  { value: 'processing', label: 'Processing' },
  { value: 'failed',     label: 'Failed' },
] as const;

const SORT_OPTIONS = [
  { value: 'created_at',       label: 'Date' },
  { value: 'title',            label: 'Title' },
  { value: 'duration_seconds', label: 'Duration' },
  { value: 'file_size_bytes',  label: 'Size' },
] as const;

export function VideoLibraryPicker({ visible, onClose, onSelect }: Props) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const [assets, setAssets] = useState<VideoAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<LibraryFilters['status']>('all');
  const [sortBy, setSortBy] = useState<LibraryFilters['sortBy']>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getMyVideoLibrary({ search, status: statusFilter, sortBy, sortDir });
      setAssets(data);
    } catch (_) {
      setAssets([]);
    }
    setLoading(false);
  }, [search, statusFilter, sortBy, sortDir]);

  useEffect(() => {
    if (visible) {
      setSelectedId(null);
      load();
    }
  }, [visible, load]);

  const handleSelect = (asset: VideoAsset) => {
    setSelectedId(asset.id);
    // Delay 120 ms for the pressed highlight to be visible
    setTimeout(() => {
      onSelect(asset);
      onClose();
    }, 120);
  };

  const statusColor = (status: VideoAsset['status']) => {
    switch (status) {
      case 'ready':      return '#16A34A';
      case 'processing': return '#D97706';
      case 'failed':     return '#DC2626';
      case 'missing':    return '#EF4444';
      default:           return c.text;
    }
  };

  const renderItem = ({ item }: { item: VideoAsset }) => {
    const isSelected = selectedId === item.id;
    return (
      <Pressable
        onPress={() => handleSelect(item)}
        style={[
          isSelected ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
          { borderRadius: 16, marginBottom: 10, flexDirection: 'row', overflow: 'hidden' },
        ]}>
        {/* Thumbnail */}
        <View style={{ width: 100, height: 72 }}>
          {item.thumbnail_url ? (
            <Image
              source={{ uri: item.thumbnail_url }}
              style={{ width: 100, height: 72 }}
              contentFit="cover"
            />
          ) : (
            <View style={{ width: 100, height: 72, alignItems: 'center', justifyContent: 'center', backgroundColor: `${c.primary}15` }}>
              <Film size={24} color={c.primary} opacity={0.4} />
            </View>
          )}
          {/* Duration badge */}
          {item.duration_seconds && (
            <View style={{ position: 'absolute', bottom: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2 }}>
              <Text style={{ fontSize: 10, color: '#fff', fontWeight: '700' }}>{formatDuration(item.duration_seconds)}</Text>
            </View>
          )}
        </View>

        {/* Metadata */}
        <View style={{ flex: 1, padding: 10, gap: 4 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }} numberOfLines={2}>{item.title || 'Untitled Video'}</Text>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {/* Status pill */}
            <View style={{ backgroundColor: `${statusColor(item.status)}18`, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6 }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: statusColor(item.status) }}>
                {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
              </Text>
            </View>
            {/* File size */}
            {item.file_size_bytes && (
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>{formatBytes(item.file_size_bytes)}</Text>
            )}
          </View>

          <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{formatDate(item.created_at)}</Text>

          {/* VdoCipher ID */}
          <Text style={{ fontSize: 10, color: c.text, opacity: 0.3, fontFamily: 'monospace' }} numberOfLines={1}>
            {item.provider_video_id}
          </Text>

          {/* Usage count */}
          {(item.lesson_count ?? 0) > 0 && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
              <Film size={10} color={c.primary} />
              <Text style={{ fontSize: 11, color: c.primary, fontWeight: '600' }}>
                Used in {item.lesson_count} {item.lesson_count === 1 ? 'lesson' : 'lessons'}
              </Text>
            </View>
          )}
        </View>

        {/* Selection check */}
        {isSelected && (
          <View style={{ alignItems: 'center', justifyContent: 'center', paddingRight: 12 }}>
            <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' }}>
              <Check size={14} color="#fff" />
            </View>
          </View>
        )}
      </Pressable>
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.base }}>
        {/* ── Header ── */}
        <View style={{ paddingTop: 20, paddingHorizontal: 20, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: c.text }}>My Video Library</Text>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 2 }}>
              Select a video to reuse — no re-upload needed
            </Text>
          </View>
          <Pressable
            onPress={onClose}
            style={[neuFlatStyle(isDark), { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }]}>
            <X size={18} color={c.text} opacity={0.5} />
          </Pressable>
        </View>

        {/* ── Search + Sort row ── */}
        <View style={{ paddingHorizontal: 16, paddingBottom: 10, flexDirection: 'row', gap: 10 }}>
          <View style={[neuPressedStyle(isDark), { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, paddingHorizontal: 12, height: 40 }]}>
            <Search size={15} color={c.text} opacity={0.4} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search videos…"
              placeholderTextColor={`${c.text}55`}
              style={{ flex: 1, fontSize: 14, color: c.text }}
              returnKeyType="search"
            />
            {search.length > 0 && (
              <Pressable onPress={() => setSearch('')}>
                <X size={14} color={c.text} opacity={0.4} />
              </Pressable>
            )}
          </View>

          {/* Sort button */}
          <View>
            <Pressable
              onPress={() => setShowSortMenu(v => !v)}
              style={[neuFlatStyle(isDark), { height: 40, paddingHorizontal: 12, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
              {sortDir === 'asc' ? <SortAsc size={15} color={c.primary} /> : <SortDesc size={15} color={c.primary} />}
              <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>
                {SORT_OPTIONS.find(o => o.value === sortBy)?.label ?? 'Sort'}
              </Text>
              <ChevronDown size={13} color={c.primary} />
            </Pressable>

            {showSortMenu && (
              <View style={[neuFlatStyle(isDark), {
                position: 'absolute', top: 44, right: 0, zIndex: 99,
                borderRadius: 14, padding: 8, minWidth: 160, gap: 2,
              }]}>
                {SORT_OPTIONS.map(opt => (
                  <Pressable
                    key={opt.value}
                    onPress={() => {
                      if (sortBy === opt.value) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
                      else { setSortBy(opt.value as any); setSortDir('desc'); }
                      setShowSortMenu(false);
                    }}
                    style={[
                      sortBy === opt.value ? neuPressedStyle(isDark) : {},
                      { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
                    ]}>
                    <Text style={{ fontSize: 13, fontWeight: sortBy === opt.value ? '700' : '500', color: sortBy === opt.value ? c.primary : c.text }}>
                      {opt.label}
                    </Text>
                    {sortBy === opt.value && (
                      sortDir === 'asc'
                        ? <SortAsc size={12} color={c.primary} />
                        : <SortDesc size={12} color={c.primary} />
                    )}
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        </View>

        {/* ── Status filter chips ── */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12, gap: 8, flexDirection: 'row' }}>
          {STATUS_FILTERS.map(f => (
            <Pressable
              key={f.value}
              onPress={() => setStatusFilter(f.value as any)}
              style={[
                statusFilter === f.value ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
                { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
              ]}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: statusFilter === f.value ? c.primary : c.text, opacity: statusFilter === f.value ? 1 : 0.55 }}>
                {f.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        {/* ── List ── */}
        {loading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <ActivityIndicator color={c.primary} size="large" />
            <Text style={{ fontSize: 13, color: c.text, opacity: 0.45 }}>Loading library…</Text>
          </View>
        ) : assets.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 }}>
            <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: `${c.primary}15`, alignItems: 'center', justifyContent: 'center' }}>
              <Film size={32} color={c.primary} opacity={0.4} />
            </View>
            <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, textAlign: 'center' }}>
              {search ? 'No videos match your search' : 'No videos in your library yet'}
            </Text>
            <Text style={{ fontSize: 13, color: c.text, opacity: 0.45, textAlign: 'center', lineHeight: 19 }}>
              {search ? 'Try a different keyword.' : 'Upload your first video to a lesson — it will appear here for reuse.'}
            </Text>
          </View>
        ) : (
          <FlatList
            data={assets}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
            contentInsetAdjustmentBehavior="automatic"
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>
    </Modal>
  );
}
