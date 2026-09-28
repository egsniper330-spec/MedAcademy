/**
 * VideoLibrary — Doctor-facing standalone video library management screen.
 *
 * Route: /(app)/(doctor)/video-library
 *
 * Shows all videos uploaded by the current doctor with:
 *   - Thumbnail, title, duration, file size, upload date, VdoCipher ID
 *   - Lesson usage count + expandable usage list
 *   - Search, sort, status filter
 *   - Delete (with protection when lessons use the video)
 *   - Rename
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Modal,
  Pressable, ScrollView, Text, TextInput, useColorScheme, View,
} from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import {
  BookOpen, ChevronDown, ChevronUp, Clock, CloudOff, Edit2, Film, RefreshCw,
  Search, SortAsc, SortDesc, Trash2, X, Upload,
} from 'lucide-react-native';
import { neuColors, useLayout, neuFlatStyle, neuPressedStyle, safeBottom, zIndex } from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { useToast } from '@/components/Toast';
import { useProfileStore } from '@/lib/store';
import { friendlyError } from '@/lib/validation';
import * as DocumentPicker from 'expo-document-picker';
import { randomUUID } from 'expo-crypto';
import { useUploadQueueStore } from '@/lib/uploadQueueStore';
import { createUploadRecord, type UploadTask } from '@/lib/videoUploadEngine';
import { useVideoUploader } from '@/lib/useVideoUploader';
import { resolveUploadMime, validateVideoFile } from '@/lib/videoFormats';
import {
  deleteVideoAsset, getMyVideoLibrary, getVideoAssetUsage,
  syncVideoLibraryWithVdoCipher,
  updateVideoAsset,
  type LibraryFilters, type VideoAsset, type VideoAssetUsage,
} from '@/lib/videoLibraryApi';

// At most one automatic reconciliation per focused session per interval.
// A screen focus must never trigger a VdoCipher API call storm (rate limits).
const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;

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
  { value: 'all',              label: 'All' },
  { value: 'ready',            label: 'Ready' },
  { value: 'processing',       label: 'Processing' },
  { value: 'failed',           label: 'Failed' },
]

const SORT_OPTIONS = [
  { value: 'created_at',       label: 'Date' },
  { value: 'title',            label: 'Title' },
  { value: 'duration_seconds', label: 'Duration' },
  { value: 'file_size_bytes',  label: 'Size' },
] as const;

export default function VideoLibraryScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const layout = useLayout();
  const insets = layout.insets;
  const c = isDark ? neuColors.dark : neuColors.light;
  const { showToast } = useToast();
  const { addTask, setQueueVisible } = useUploadQueueStore();
  const { retryUpload } = useVideoUploader();
  const profile = useProfileStore((s) => s.profile);
  const [uploadingVideo, setUploadingVideo] = useState(false);

  const [assets, setAssets] = useState<VideoAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<LibraryFilters['status']>('all');
  const [sortBy, setSortBy] = useState<LibraryFilters['sortBy']>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [expandedUsage, setExpandedUsage] = useState<Record<string, VideoAssetUsage[]>>({});
  const [loadingUsage, setLoadingUsage] = useState<string | null>(null);

  // Rename modal
  const [renameAsset, setRenameAsset] = useState<VideoAsset | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);

  // Permanent deletion requires an explicit confirmation after the current
  // usage list has been loaded.
  const [deleteConfirm, setDeleteConfirm] = useState<{
    asset: VideoAsset;
    usages: VideoAssetUsage[];
  } | null>(null);
  const [deleteSaving, setDeleteSaving] = useState(false);

  // ── VdoCipher ↔ library reconciliation ──
  // Detects videos deleted from the VdoCipher Dashboard and duplicates.
  // Admins reconcile the whole platform; DOCTORS reconcile their own library
  // (scope='mine', enforced server-side) — both roles get the Sync control.
  const isStaff = profile?.role === 'super_admin' || profile?.role === 'admin';
  const canSync = !!profile && (isStaff || profile.role === 'doctor');
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<string | null>(null);
  const [syncFailed, setSyncFailed] = useState(false);

  // Throttle: at most one auto-sync per 5 minutes per mounted session.
  const lastAutoSyncRef = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getMyVideoLibrary({ search, status: statusFilter, sortBy, sortDir });
      setAssets(data);
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to load library.') });
    }
    setLoading(false);
  }, [search, statusFilter, sortBy, sortDir]);

  // ── Doctor auto-reconciliation on screen focus ──
  // Doctors don't have a maintenance window; their library must reconcile
  // itself when they open it (throttled). Admins keep the manual Sync button
  // flow. Failure is non-blocking: the library stays usable with last-known
  // state and the deferred-sync note below explains what happened.
  useFocusEffect(useCallback(() => {
    load();
    if (!isStaff && canSync) {
      const now = Date.now();
      if (now - lastAutoSyncRef.current > AUTO_SYNC_INTERVAL_MS) {
        lastAutoSyncRef.current = now;
        syncVideoLibraryWithVdoCipher(true, 'mine')
          .then((s) => {
            if (s.status === 'ok') {
              setSyncFailed(false);
              setSyncSummary(
                `Synchronized ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}` +
                ` · ${s.remote_videos} remote · ${s.removed ?? s.marked_unavailable ?? 0} removed`,
              );
              // Re-fetch: confirmed-remotely-deleted videos are removed by
              // the sync itself, so the library must reflect the cleanup.
              load();
            } else {
              setSyncFailed(true);
            }
          })
          .catch(() => setSyncFailed(true));
      }
    }
  }, [load, isStaff, canSync]));

  // Re-fetch library when any upload reaches 'ready' — the new video should
  // appear immediately without requiring the user to leave and re-enter.
  // Track which task IDs have ever reached 'ready' so we refresh exactly
  // once per completed upload — not on every task patch, not on mount.
  const readyIdsRef = useRef(new Set<string>());
  const tasks = useUploadQueueStore((s) => s.tasks);

  // Live upload status, surfaced directly in the library (not only in the
  // global queue panel): the most recent non-terminal task first.
  const activeUpload = tasks.find((t) =>
    ['waiting', 'uploading', 'paused', 'resuming', 'processing', 'encoding', 'generating_streams', 'verifying', 'recovering'].includes(t.status),
  ) ?? null;
  const recentFailed = tasks.find((t) => t.status === 'failed' || t.status === 'timeout') ?? null;
  useEffect(() => {
    const currentReadyIds = new Set(
      tasks.filter((t) => t.status === 'ready').map((t) => t.id),
    );
    // Find newly completed uploads (in current but not in previous set)
    let hasNewReady = false;
    for (const id of currentReadyIds) {
      if (!readyIdsRef.current.has(id)) {
        hasNewReady = true;
        break;
      }
    }
    if (hasNewReady) {
      load();
    }
    readyIdsRef.current = currentReadyIds;
  }, [tasks, load]);

  const handleUploadVideo = async () => {
    if (uploadingVideo) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ['video/*'], multiple: false });
      if (result.canceled || !result.assets?.[0]) return;
      const file = result.assets[0];
      const validation = validateVideoFile(file.name, file.mimeType, file.size ?? 0);
      if (!validation.ok) {
        showToast({ type: 'error', message: validation.error?.message ?? 'Invalid video file.' });
        return;
      }
      setUploadingVideo(true);
      const task = {
        id: randomUUID(),
        ownerUserId: profile?.id,
        lessonId: null,
        courseId: null,
        doctorId: profile?.id,
        fileUri: file.uri,
        fileName: file.name,
        fileSize: file.size ?? 0,
        mimeType: resolveUploadMime(file.name, file.mimeType),
        status: 'waiting' as const,
        progress: 0,
        bytesUploaded: 0,
        speedBps: 0,
        etaSeconds: 0,
        retryCount: 0,
        createdAt: Date.now(),
      };
      await createUploadRecord(task);
      addTask(task);
      setQueueVisible(true);
      showToast({ type: 'success', message: `Queued: ${file.name}` });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Could not queue video.') });
    } finally {
      setUploadingVideo(false);
    }
  };

  const toggleUsage = async (asset: VideoAsset) => {
    if (expandedUsage[asset.id]) {
      setExpandedUsage(prev => { const n = { ...prev }; delete n[asset.id]; return n; });
      return;
    }
    setLoadingUsage(asset.id);
    try {
      const usages = await getVideoAssetUsage(asset.id);
      setExpandedUsage(prev => ({ ...prev, [asset.id]: usages }));
    } catch (_) {}
    setLoadingUsage(null);
  };

  const handleDelete = async (asset: VideoAsset) => {
    try {
      const usages = await getVideoAssetUsage(asset.id);
      setDeleteConfirm({ asset, usages });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Could not inspect video usage.') });
    }
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    setDeleteSaving(true);
    try {
      const result = await deleteVideoAsset(deleteConfirm.asset.id);
      if (!result.deleted) throw new Error('The video was not deleted.');
      setAssets(prev => prev.filter(a => a.id !== deleteConfirm.asset.id));
      setDeleteConfirm(null);
      const affected = result.affected_lessons ?? [];
      if (affected.length > 0) {
        const lessonNames = affected.map(l => l.lesson_title).join(', ');
        showToast({ type: 'info', message: `Video deleted. ${affected.length} lesson(s) changed to Draft: ${lessonNames}` });
      } else {
        showToast({ type: 'success', message: 'Video permanently deleted from library and VdoCipher.' });
      }
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Permanent video deletion failed. Nothing was removed.') });
    }
    setDeleteSaving(false);
  };

  // ── Sync VdoCipher (Super Admin / Admin) ──────────────────────────
  // Remote-first reconciliation: proven-missing assets are flagged
  // Remote-first reconciliation: locally-confirmed-deleted videos are
  // REMOVED by the sync itself (no intermediate user-facing state); a
  // listing failure leaves the library untouched and surfaces an error.
  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncSummary(null);
    setSyncFailed(false);
    try {
      const s = await syncVideoLibraryWithVdoCipher(true, isStaff ? 'all' : 'mine');
      if (s.status === 'ok') {
        setSyncSummary(
          `Last synchronized: ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}` +
          ` · ${s.remote_videos} remote · ${s.removed ?? s.marked_unavailable ?? 0} removed · ${s.reconciled} reconciled`,
        );
        await load();
        showToast({ type: 'success', message: 'Video library synchronized with VdoCipher.' });
      } else {
        setSyncSummary(null);
        setSyncFailed(true);
        showToast({ type: 'error', message: s.error ?? 'Sync failed — library left unchanged. Nothing was marked deleted.' });
      }
    } catch (e) {
      setSyncSummary(null);
      setSyncFailed(true);
      showToast({ type: 'error', message: friendlyError(e, 'Sync failed — library left unchanged.') });
    }
    setSyncing(false);
  };

  const handleRename = async () => {
    if (!renameAsset || !renameTitle.trim()) return;
    setRenameSaving(true);
    try {
      await updateVideoAsset(renameAsset.id, { title: renameTitle.trim() });
      setAssets(prev => prev.map(a => a.id === renameAsset.id ? { ...a, title: renameTitle.trim() } : a));
      setRenameAsset(null);
      showToast({ type: 'success', message: 'Video renamed.' });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Rename failed.') });
    }
    setRenameSaving(false);
  };

  const statusColor = (status: VideoAsset['status']) => {
    switch (status) {
      case 'ready':      return '#16A34A';
      case 'processing': return '#D97706';
      case 'failed':     return '#DC2626';
      case 'missing':
      case 'remotely_deleted': return '#EF4444'; // legacy rows are filtered out client-side
      case 'duplicate_removed': return '#9CA3AF';
      default:           return c.text;
    }
  };

  const renderItem = ({ item }: { item: VideoAsset }) => {
    const usages = expandedUsage[item.id];
    const isExpanded = !!usages;
    const usageLoading = loadingUsage === item.id;

    return (
      <NeuCard style={{ marginBottom: 14, borderRadius: 18, overflow: 'hidden', padding: 0 }}>
        {/* ── Thumbnail row ── */}
        <View style={{ flexDirection: 'row' }}>
          <View style={{ width: 112, aspectRatio: 112/80 }}>
            {item.thumbnail_url ? (
              <Image source={{ uri: item.thumbnail_url }} style={{ width: 112, aspectRatio: 112/80 }} contentFit="cover" />
            ) : (
              <View style={{ width: 112, aspectRatio: 112/80, backgroundColor: `${c.primary}12`, alignItems: 'center', justifyContent: 'center' }}>
                <Film size={28} color={c.primary} opacity={0.35} />
              </View>
            )}
            {item.duration_seconds && (
              <View style={{ position: 'absolute', bottom: 5, right: 5, backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2 }}>
                <Text style={{ fontSize: 10, color: '#fff', fontWeight: '700' }}>{formatDuration(item.duration_seconds)}</Text>
              </View>
            )}
          </View>

          <View style={{ flex: 1, padding: 12, gap: 4 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }} numberOfLines={2}>{item.title || 'Untitled Video'}</Text>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <View style={{ backgroundColor: `${statusColor(item.status)}18`, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6 }}>
                <Text style={{ fontSize: 10, fontWeight: '700', color: statusColor(item.status) }}>
                  {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                </Text>
              </View>
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>{formatBytes(item.file_size_bytes)}</Text>
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.35 }}>{formatDate(item.created_at)}</Text>
            </View>

            {/* VdoCipher ID */}
            <Text style={{ fontSize: 10, color: c.text, opacity: 0.3 }} numberOfLines={1}>
              ID: {item.provider_video_id}
            </Text>
          </View>
        </View>

        {/* Sync removes confirmed-remotely-deleted videos automatically —
            there is no user-facing "deleted remotely" card/button anymore. */}

        {/* ── Action row ── */}
        <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: `${c.text}10` }}>
          {/* Usage toggle */}
          <Pressable
            onPress={() => toggleUsage(item)}
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10 }}>
            {usageLoading ? (
              <ActivityIndicator size="small" color={c.primary} />
            ) : (
              <>
                <BookOpen size={13} color={c.primary} />
                <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>
                  {item.lesson_count ?? 0} {(item.lesson_count ?? 0) === 1 ? 'lesson' : 'lessons'}
                </Text>
                {isExpanded ? <ChevronUp size={12} color={c.primary} /> : <ChevronDown size={12} color={c.primary} />}
              </>
            )}
          </Pressable>

          {/* Rename */}
          <Pressable
            onPress={() => { setRenameAsset(item); setRenameTitle(item.title); }}
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderLeftWidth: 1, borderLeftColor: `${c.text}10` }}>
            <Edit2 size={13} color={c.text} opacity={0.5} />
            <Text style={{ fontSize: 12, fontWeight: '700', color: c.text, opacity: 0.6 }}>Rename</Text>
          </Pressable>

          {/* Delete */}
          <Pressable
            onPress={() => handleDelete(item)}
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderLeftWidth: 1, borderLeftColor: `${c.text}10` }}>
            <Trash2 size={13} color="#DC2626" />
            <Text style={{ fontSize: 12, fontWeight: '700', color: '#DC2626' }}>Delete</Text>
          </Pressable>
        </View>

        {/* ── Usage list (expanded) ── */}
        {isExpanded && (
          <View style={{ borderTopWidth: 1, borderTopColor: `${c.text}10`, padding: 12, gap: 8 }}>
            {usages.length === 0 ? (
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.4, textAlign: 'center' }}>
                Not used in any lesson yet.
              </Text>
            ) : (
              <>
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Used In
                </Text>
                {usages.map((u) => (
                  <View key={u.lesson_id} style={[neuPressedStyle(isDark), { borderRadius: 10, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
                    <Film size={12} color={c.primary} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: c.text }} numberOfLines={1}>{u.lesson_title}</Text>
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }} numberOfLines={1}>{u.course_title}</Text>
                    </View>
                  </View>
                ))}
              </>
            )}
          </View>
        )}
      </NeuCard>
    );
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.base }} behavior={process.env.EXPO_OS === 'ios' ? 'padding' : 'height'}>

      {/* ── Rename modal ── */}
      <Modal visible={!!renameAsset} transparent animationType="fade" onRequestClose={() => setRenameAsset(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <View style={[neuFlatStyle(isDark), { width: '100%', maxWidth: 380, borderRadius: 22, padding: 24, gap: 16 }]}>
            <Text style={{ fontSize: 17, fontWeight: '800', color: c.text }}>Rename Video</Text>
            <View style={[neuPressedStyle(isDark), { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, minWidth: 0 }]}>
              <TextInput
                value={renameTitle}
                onChangeText={setRenameTitle}
                placeholder="Video title"
                placeholderTextColor={`${c.text}55`}
                style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text, paddingVertical: 0 }}
                autoFocus
              />
            </View>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Pressable onPress={() => setRenameAsset(null)}
                style={[neuFlatStyle(isDark), { flex: 1, padding: 13, borderRadius: 12, alignItems: 'center' }]}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, opacity: 0.6 }}>Cancel</Text>
              </Pressable>
              <Pressable onPress={handleRename} disabled={renameSaving}
                style={{ flex: 1, padding: 13, borderRadius: 12, alignItems: 'center', backgroundColor: c.primary, flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
                {renameSaving && <ActivityIndicator size="small" color="#fff" />}
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Permanent deletion confirmation ── */}
      <Modal visible={!!deleteConfirm} transparent animationType="fade" onRequestClose={() => setDeleteConfirm(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <View style={[neuFlatStyle(isDark), { width: '100%', maxWidth: 420, borderRadius: 22, padding: 24, gap: 16 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
                <Trash2 size={20} color="#DC2626" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 16, fontWeight: '800', color: '#DC2626' }}>Delete Video Permanently?</Text>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.55, marginTop: 2 }}>
                  Used in {deleteConfirm?.usages.length ?? 0} {(deleteConfirm?.usages.length ?? 0) === 1 ? 'lesson' : 'lessons'}.
                </Text>
              </View>
            </View>
            <Text style={{ fontSize: 13, color: c.text, opacity: 0.7, lineHeight: 19 }}>
              This removes the video from every listed lesson and permanently deletes the VdoCipher resource. Published lessons that lose their video will be automatically set to Draft.
            </Text>
            <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 220 }}>
              {(deleteConfirm?.usages ?? []).map((u) => (
                <View key={u.lesson_id} style={[neuPressedStyle(isDark), { borderRadius: 10, padding: 10, marginBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
                  <Film size={12} color={c.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: c.text }} numberOfLines={1}>{u.lesson_title}</Text>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }} numberOfLines={1}>{u.course_title}</Text>
                  </View>
                </View>
              ))}
              {(deleteConfirm?.usages.length ?? 0) === 0 && (
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, textAlign: 'center', padding: 10 }}>Not used in any lesson.</Text>
              )}
            </ScrollView>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Pressable onPress={() => setDeleteConfirm(null)} disabled={deleteSaving}
                style={[neuFlatStyle(isDark), { flex: 1, padding: 13, borderRadius: 14, alignItems: 'center' }]}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, opacity: 0.65 }}>Keep Video</Text>
              </Pressable>
              <Pressable onPress={confirmDelete} disabled={deleteSaving}
                style={{ flex: 1, padding: 13, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#DC2626', flexDirection: 'row', gap: 8 }}>
                {deleteSaving && <ActivityIndicator size="small" color="#fff" />}
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }}>Delete Permanently</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Header — standard PageHeader: hamburger (drawer), title, right actions.
          Replaces the old custom title row which had no hamburger, breaking the
          drawer-navigation pattern every other hub/root page follows. ── */}
      <PageHeader
        title="Video Library"
        subtitle="One upload, reusable across any lesson"
        rightAction={
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            {canSync && (
              <Pressable
                onPress={handleSync}
                disabled={syncing}
                accessibilityRole="button"
                accessibilityLabel="Sync library with VdoCipher"
                style={{ backgroundColor: syncing ? `${c.primary}66` : c.primary, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {syncing
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <RefreshCw size={15} color="#fff" />}
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>
                  {syncing ? 'Syncing…' : 'Sync'}
                </Text>
              </Pressable>
            )}
            <Pressable
              onPress={handleUploadVideo}
              disabled={uploadingVideo}
              style={{ backgroundColor: c.primary, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {uploadingVideo ? <ActivityIndicator size="small" color="#fff" /> : <Upload size={15} color="#fff" />}
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>Upload</Text>
            </Pressable>
          </View>
        }
      />

      {/* ── Sync status banner ── */}
      {syncing && (
        <View style={{ marginHorizontal: 16, marginBottom: 10, padding: 12, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: `${c.primary}14` }}>
          <ActivityIndicator size="small" color={c.primary} />
          <Text style={{ fontSize: 13, color: c.text, opacity: 0.7 }}>Syncing video library with VdoCipher…</Text>
        </View>
      )}
      {!syncing && syncFailed && (
        <View style={{ marginHorizontal: 16, marginBottom: 10, padding: 12, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#D9770612' }}>
          <CloudOff size={13} color="#D97706" />
          <Text style={{ fontSize: 12, color: '#92400E', flex: 1 }}>
            VdoCipher sync was unavailable — showing last known state. Nothing was changed.
          </Text>
          <Pressable onPress={handleSync} disabled={syncing} hitSlop={6}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: '#D97706' }}>Retry</Text>
          </Pressable>
        </View>
      )}
      {/* ── Live upload status strip (engine state, shown even when the queue panel is closed) ── */}
      {(activeUpload || recentFailed) && (() => {
        const t: UploadTask = (activeUpload ?? recentFailed) as UploadTask;
        const stageLabel =
          t.status === 'waiting' ? 'Preparing…' :
          t.status === 'uploading' || t.status === 'resuming' ? `Uploading ${Math.round(t.progress)}%` :
          t.status === 'paused' ? `Paused — ${Math.round(t.progress)}% uploaded` :
          t.status === 'processing' ? 'Processing…' :
          t.status === 'encoding' ? 'Processing video…' :
          t.status === 'generating_streams' ? 'Processing video…' :
          t.status === 'verifying' ? 'Verifying…' :
          t.status === 'recovering' ? 'Restoring upload…' :
          t.status === 'timeout' ? 'Processing timed out' : 'Upload failed';
        const failed = t.status === 'failed' || t.status === 'timeout';
        const indeterminate = ['waiting', 'processing', 'encoding', 'generating_streams', 'verifying', 'recovering'].includes(t.status);
        return (
          <View style={{ marginHorizontal: 16, marginBottom: 10, padding: 12, borderRadius: 14, backgroundColor: failed ? '#DC262612' : `${c.primary}14`, gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: '800', color: failed ? '#B91C1C' : c.text, flex: 1 }}>
                {t.fileName}
              </Text>
              <Text style={{ fontSize: 12, fontWeight: '700', color: failed ? '#B91C1C' : c.text, opacity: 0.75 }}>
                {stageLabel}
              </Text>
            </View>
            {failed
              ? (
                <Pressable onPress={() => retryUpload(t.id)} hitSlop={6} style={{ alignSelf: 'flex-start', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#DC262618' }}>
                  <Text style={{ fontSize: 12, fontWeight: '800', color: '#B91C1C' }}>Retry upload</Text>
                </Pressable>
              )
              : (
                <View style={{ height: 6, borderRadius: 3, backgroundColor: `${c.text}14`, overflow: 'hidden' }}>
                  <View style={{ height: 6, borderRadius: 3, width: indeterminate ? '40%' : `${Math.min(100, Math.max(2, t.progress))}%`, backgroundColor: c.primary, opacity: indeterminate ? 0.5 : 1 }} />
                </View>
              )}
          </View>
        );
      })()}

      {!syncing && syncSummary && (
        <View style={{ marginHorizontal: 16, marginBottom: 10, padding: 12, borderRadius: 14, backgroundColor: `${c.primary}0D` }}>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.55 }}>{syncSummary}</Text>
        </View>
      )}

      {/* ── Search + Sort ── */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 10, flexDirection: 'row', gap: 10 }}>
        <View style={[neuPressedStyle(isDark), { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 11, minWidth: 0 }]}>
          <Search size={15} color={c.text} opacity={0.4} style={{ flexShrink: 0 }} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search by title…"
            placeholderTextColor={`${c.text}55`}
            style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text, paddingVertical: 0 }}
            returnKeyType="search"
          />
          {search.length > 0 && (
            <Pressable onPress={() => setSearch('')}>
              <X size={14} color={c.text} opacity={0.4} />
            </Pressable>
          )}
        </View>

        <View>
          <Pressable
            onPress={() => setShowSortMenu(v => !v)}
            style={[neuFlatStyle(isDark), { height: 42, paddingHorizontal: 12, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
            {sortDir === 'asc' ? <SortAsc size={15} color={c.primary} /> : <SortDesc size={15} color={c.primary} />}
            <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>
              {SORT_OPTIONS.find(o => o.value === sortBy)?.label ?? 'Sort'}
            </Text>
            <ChevronDown size={13} color={c.primary} />
          </Pressable>

          {showSortMenu && (
            <View style={[neuFlatStyle(isDark), {
              position: 'absolute', top: 46, right: 0, zIndex: zIndex.dropdown,
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
                  {sortBy === opt.value && (sortDir === 'asc' ? <SortAsc size={12} color={c.primary} /> : <SortDesc size={12} color={c.primary} />)}
                </Pressable>
              ))}
            </View>
          )}
        </View>
      </View>

      {/* ── Status filter chips ── */}
      {/* COMPACT CHIPS: the scroller must NOT grow vertically (react-native-web
          bases ScrollView on flexGrow:1 — in a column parent that made the row
          inflate and alignItems:'stretch' blew every chip up to a tall block).
          flexGrow:0 shrinks the scroller to its content height; the content
          row centers its chips so they stay content-sized (~36px). */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 0 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12, gap: 8, flexDirection: 'row', alignItems: 'center' }}>
        {STATUS_FILTERS.map(f => (
          <Pressable
            key={f.value}
            onPress={() => setStatusFilter(f.value as any)}
            style={[
              statusFilter === f.value ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
              { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 20 },
            ]}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: statusFilter === f.value ? c.primary : c.text, opacity: statusFilter === f.value ? 1 : 0.55 }}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* ── Content ── */}
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <ActivityIndicator color={c.primary} size="large" />
          <Text style={{ fontSize: 13, color: c.text, opacity: 0.45 }}>Loading your library…</Text>
        </View>
      ) : (
        <FlatList
          data={assets}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingHorizontal: 16 }}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', justifyContent: 'center', gap: 16, paddingTop: 80 }}>
              <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: `${c.primary}12`, alignItems: 'center', justifyContent: 'center' }}>
                <Film size={36} color={c.primary} opacity={0.35} />
              </View>
              <Text style={{ fontSize: 17, fontWeight: '700', color: c.text }}>
                {search ? 'No videos found' : 'Your library is empty'}
              </Text>
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.45, textAlign: 'center', lineHeight: 19, maxWidth: 280 }}>
                {search ? 'Try a different search term.' : 'Videos you upload to lessons will appear here and can be reused across any course.'}
              </Text>
            </View>
          }
          onRefresh={load}
          refreshing={loading}
        />
      )}
    </KeyboardAvoidingView>
  );
}
