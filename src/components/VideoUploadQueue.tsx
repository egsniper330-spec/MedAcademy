/**
 * VideoUploadQueue.tsx
 * Floating upload queue panel — neumorphic design.
 * Adds: recovery dialog, verifying state, thumbnail preview, replace badge.
 */

import { useEffect, useRef } from 'react';
import {
  Animated, FlatList, Image, Modal, Pressable, Text, useColorScheme, View,
} from 'react-native';
import {
  Upload, X, Pause, Play, RefreshCw, Trash2,
  CheckCircle, XCircle, Clock, Loader, ShieldCheck, ShieldAlert,
  Wifi, AlertTriangle, Film, RotateCcw,
} from 'lucide-react-native';
import { useUploadQueueStore } from '@/lib/uploadQueueStore';
import { useVideoUploader } from '@/lib/useVideoUploader';
import { neuColors, neuFlatStyle, neuPressedStyle } from '@/lib/neu';
import {
  formatBytes, formatSpeed, formatEta, type UploadTask, type UploadStatus,
} from '@/lib/videoUploadEngine';

// ─── Status display config ────────────────────────────────────────────────────
const STATUS_CONFIG: Record<string, { label: string; color: string; Icon: any }> = {
  waiting:            { label: 'Waiting…',              color: '#6B7280', Icon: Clock },
  uploading:          { label: 'Uploading…',            color: '#3B82F6', Icon: Upload },
  paused:             { label: 'Paused',                color: '#D97706', Icon: Pause },
  resuming:           { label: 'Resuming…',             color: '#2DA8FF', Icon: RotateCcw },
  processing:         { label: 'Processing…',           color: '#7C3AED', Icon: Loader },
  encoding:           { label: 'Encoding…',             color: '#7C3AED', Icon: Loader },
  generating_streams: { label: 'Generating streams…',   color: '#2563EB', Icon: Loader },
  verifying:          { label: 'Verifying…',            color: '#2DA8FF', Icon: ShieldCheck },
  ready:              { label: 'Ready to Watch',         color: '#16A34A', Icon: CheckCircle },
  failed:             { label: 'Upload Failed',          color: '#DC2626', Icon: XCircle },
  timeout:            { label: 'Processing Timed Out',   color: '#F97316', Icon: AlertTriangle },
  canceled:           { label: 'Canceled',               color: '#9CA3AF', Icon: X },
  recovering:         { label: 'Recovering…',            color: '#D97706', Icon: RotateCcw },
};

const STAGE_PROGRESS: Record<string, number> = {
  waiting: 0, uploading: 0, paused: 0, resuming: 0,
  processing: 68, encoding: 76, generating_streams: 88, verifying: 94, ready: 100,
  failed: 0, timeout: 76, canceled: 0, recovering: 0,
};

// ─── Animated progress bar ────────────────────────────────────────────────────
function ProgressBar({ pct, color, isDark }: { pct: number; color: string; isDark: boolean }) {
  const anim = useRef(new Animated.Value(pct)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: pct, duration: 250, useNativeDriver: false }).start();
  }, [pct]);
  return (
    <View style={{ height: 7, borderRadius: 4, overflow: 'hidden',
      ...neuPressedStyle(isDark), backgroundColor: isDark ? '#1a1a2e' : '#e8ecf0' }}>
      <Animated.View style={{
        height: '100%', borderRadius: 4, backgroundColor: color,
        width: anim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
      }} />
    </View>
  );
}

// ─── Stage indicator ──────────────────────────────────────────────────────────
const STAGES: { key: string; label: string }[] = [
  { key: 'uploading',          label: 'Upload' },
  { key: 'processing',         label: 'Process' },
  { key: 'encoding',           label: 'Encode' },
  { key: 'generating_streams', label: 'Stream' },
  { key: 'verifying',          label: 'Verify' },
  { key: 'ready',              label: 'Ready' },
];
const STAGE_ORDER = ['uploading', 'processing', 'encoding', 'generating_streams', 'verifying', 'ready'];

function StageIndicator({ status, isDark }: { status: string; isDark: boolean }) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const currentIdx = STAGE_ORDER.indexOf(status);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 }}>
      {STAGES.map((stage, i) => {
        const done = currentIdx > i;
        const active = currentIdx === i;
        const cfg = STATUS_CONFIG[stage.key] ?? STATUS_CONFIG.waiting;
        return (
          <View key={stage.key} style={{ flex: 1, alignItems: 'center', gap: 3 }}>
            <View style={{
              width: active ? 22 : 16, height: active ? 22 : 16, borderRadius: 11,
              backgroundColor: done ? '#16A34A' : active ? cfg.color : `${c.text}15`,
              alignItems: 'center', justifyContent: 'center',
            }}>
              {done ? <CheckCircle size={10} color="#fff" /> :
               active ? <cfg.Icon size={10} color="#fff" /> :
               <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: `${c.text}30` }} />}
            </View>
            <Text style={{ fontSize: 9, color: active ? cfg.color : done ? '#16A34A' : `${c.text}50`,
              fontWeight: active ? '700' : '500' }} numberOfLines={1}>
              {stage.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ─── Upload item card ─────────────────────────────────────────────────────────
function UploadItemCard({ task, isDark }: { task: UploadTask; isDark: boolean }) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const { pauseUpload, resumeUpload, cancelUpload, retryUpload, retryProcessing } = useVideoUploader();
  const { removeTask } = useUploadQueueStore();
  const cfg = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.waiting;
  const isActive    = task.status === 'uploading' || task.status === 'resuming';
  const isPaused    = task.status === 'paused';
  const isFailed    = task.status === 'failed';
  const isTimeout   = task.status === 'timeout';
  const isReady     = task.status === 'ready';
  const isCanceled  = task.status === 'canceled';
  const isRecovering = task.status === 'recovering';
  const isVerifying = task.status === 'verifying';
  const isProcessing = ['processing', 'encoding', 'generating_streams'].includes(task.status);
  const showStages  = isProcessing || isVerifying || isReady;

  const canRetryProcessing = isTimeout && !!task.vdoCipherVideoId;
  const canRetryUpload     = isFailed;
  const canCancelFailed    = isFailed;

  const displayPct = isActive || isPaused || task.status === 'resuming'
    ? task.progress
    : STAGE_PROGRESS[task.status] ?? task.progress;

  // Chunk progress label: "3 / 12 chunks"
  const chunkLabel = (isActive || isPaused || task.status === 'resuming') &&
    task.totalChunks && task.totalChunks > 1
    ? `${task.chunksCompleted ?? 0} / ${task.totalChunks} chunks`
    : null;

  return (
    <View style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 14, gap: 10 }]}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        {isReady && task.thumbnailUrl ? (
          <View style={{ width: 42, height: 42, borderRadius: 10, overflow: 'hidden' }}>
            <Image source={{ uri: task.thumbnailUrl }} style={{ width: 42, height: 42 }} resizeMode="cover" />
          </View>
        ) : (
          <View style={{ width: 42, height: 42, borderRadius: 12,
            backgroundColor: `${cfg.color}18`, alignItems: 'center', justifyContent: 'center' }}>
            <Film size={20} color={cfg.color} />
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, flex: 1 }} numberOfLines={1}>
              {task.fileName}
            </Text>
            {task.isReplacement && (
              <View style={{ backgroundColor: '#7C3AED18', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                <Text style={{ fontSize: 9, fontWeight: '800', color: '#7C3AED' }}>REPLACE</Text>
              </View>
            )}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <cfg.Icon size={11} color={cfg.color} />
            <Text style={{ fontSize: 12, fontWeight: '600', color: cfg.color }}>{cfg.label}</Text>
            {chunkLabel && (
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>· {chunkLabel}</Text>
            )}
          </View>
        </View>
        {/* Action buttons */}
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {isActive && (
            <Pressable onPress={() => pauseUpload(task.id)} hitSlop={8}
              style={[neuFlatStyle(isDark), { borderRadius: 8, padding: 7 }]}>
              <Pause size={14} color="#D97706" />
            </Pressable>
          )}
          {(isPaused || isRecovering) && (
            <Pressable onPress={() => resumeUpload(task.id)} hitSlop={8}
              style={[neuFlatStyle(isDark), { borderRadius: 8, padding: 7 }]}>
              <Play size={14} color="#3B82F6" />
            </Pressable>
          )}
          {canRetryUpload && (
            <Pressable onPress={() => retryUpload(task.id)} hitSlop={8}
              style={[neuFlatStyle(isDark), { borderRadius: 8, padding: 7, flexDirection: 'row', alignItems: 'center', gap: 4 }]}>
              <RefreshCw size={14} color="#3B82F6" />
              <Text style={{ fontSize: 10, fontWeight: '700', color: '#3B82F6' }}>Retry</Text>
            </Pressable>
          )}
          {canRetryProcessing && (
            <Pressable onPress={() => retryProcessing(task.id)} hitSlop={8}
              style={[neuFlatStyle(isDark), { borderRadius: 8, padding: 7, flexDirection: 'row', alignItems: 'center', gap: 4 }]}>
              <RotateCcw size={13} color="#F97316" />
              <Text style={{ fontSize: 10, fontWeight: '700', color: '#F97316' }}>Retry</Text>
            </Pressable>
          )}
          {(isActive || isPaused || task.status === 'waiting' || isRecovering || isProcessing || canCancelFailed) && (
            <Pressable onPress={() => cancelUpload(task.id)} hitSlop={8}
              style={[neuFlatStyle(isDark), { borderRadius: 8, padding: 7 }]}>
              <X size={14} color="#DC2626" />
            </Pressable>
          )}
          {isTimeout && (
            <Pressable onPress={() => removeTask(task.id)} hitSlop={8}
              style={[neuFlatStyle(isDark), { borderRadius: 8, padding: 7 }]}>
              <Trash2 size={14} color={`${c.text}60`} />
            </Pressable>
          )}
          {/* Dismiss — completed / canceled / failed (asset gone after cancel) */}
          {(isReady || isCanceled || isFailed) && (
            <Pressable onPress={() => removeTask(task.id)} hitSlop={8}
              style={[neuFlatStyle(isDark), { borderRadius: 8, padding: 7 }]}>
              <Trash2 size={14} color={`${c.text}60`} />
            </Pressable>
          )}
        </View>
      </View>

      {/* Progress bar */}
      {(isActive || isPaused || task.status === 'resuming' || isProcessing || isVerifying) && (
        <ProgressBar pct={displayPct} color={cfg.color} isDark={isDark} />
      )}
      {isReady && <ProgressBar pct={100} color="#16A34A" isDark={isDark} />}

      {/* Upload stats */}
      {(isActive || isPaused || task.status === 'resuming') && (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4 }}>
          <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>
            {formatBytes(task.bytesUploaded)} / {formatBytes(task.fileSize)}
          </Text>
          <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>
            {formatSpeed(task.speedBps)}  ·  ETA {formatEta(task.etaSeconds)}
          </Text>
          <Text style={{ fontSize: 11, fontWeight: '700', color: cfg.color }}>{displayPct}%</Text>
        </View>
      )}

      {/* Stage indicator */}
      {showStages && <StageIndicator status={task.status} isDark={isDark} />}

      {/* Verification result */}
      {isReady && task.verificationStatus === 'passed' && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6,
          backgroundColor: '#2DA8FF15', borderRadius: 8, padding: 7 }}>
          <ShieldCheck size={12} color="#2DA8FF" />
          <Text style={{ fontSize: 11, color: '#2DA8FF', fontWeight: '600' }}>Integrity verified</Text>
        </View>
      )}

      {/* Error message — shown for all failure states */}
      {isFailed && task.errorMessage && (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6,
          backgroundColor: '#DC262615', borderRadius: 8, padding: 8 }}>
          <AlertTriangle size={13} color="#DC2626" style={{ marginTop: 1 }} />
          <Text style={{ fontSize: 12, color: '#DC2626', flex: 1, lineHeight: 17 }}>
            {task.errorMessage}
          </Text>
        </View>
      )}

      {/* Timeout: encoding may still complete — user can retry polling */}
      {isTimeout && task.vdoCipherVideoId && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6,
          backgroundColor: '#F9731615', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6 }}>
          <RotateCcw size={11} color="#F97316" />
          <Text style={{ fontSize: 11, color: '#F97316', flex: 1, lineHeight: 15 }}>
            Processing timed out — tap Retry Processing to check encoding status.
          </Text>
        </View>
      )}

      {/* Recovering hint */}
      {isRecovering && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6,
          backgroundColor: '#D9770615', borderRadius: 8, padding: 7 }}>
          <RotateCcw size={12} color="#D97706" />
          <Text style={{ fontSize: 11, color: '#D97706' }}>
            Upload was interrupted. Tap ▶ to resume from last checkpoint.
          </Text>
        </View>
      )}

      {/* Resuming hint — shows chunk progress during active resume */}
      {task.status === 'resuming' && task.totalChunks && task.totalChunks > 1 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6,
          backgroundColor: '#2DA8FF15', borderRadius: 8, padding: 7 }}>
          <RotateCcw size={12} color="#2DA8FF" />
          <Text style={{ fontSize: 11, color: '#2DA8FF' }}>
            Resuming from chunk {task.chunksCompleted ?? 0} of {task.totalChunks}
          </Text>
        </View>
      )}

      {/* Success detail */}
      {isReady && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6,
          backgroundColor: '#16A34A15', borderRadius: 8, padding: 8 }}>
          <CheckCircle size={13} color="#16A34A" />
          <Text style={{ fontSize: 12, color: '#16A34A', fontWeight: '600' }}>
            ✓ Upload complete · {formatBytes(task.fileSize)}
          </Text>
        </View>
      )}
    </View>
  );
}

// ─── Recovery dialog ──────────────────────────────────────────────────────────
function RecoveryDialog({ isDark }: { isDark: boolean }) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const { showRecoveryDialog, setShowRecoveryDialog, recoverableTasks, discardRecoverable } =
    useUploadQueueStore();
  const { resumeAllRecoverable } = useVideoUploader();
  const count = recoverableTasks().length;

  if (!showRecoveryDialog || count === 0) return null;

  return (
    <Modal visible transparent animationType="fade">
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center', alignItems: 'center', padding: 24 }}>
        <View style={[neuFlatStyle(isDark), { borderRadius: 20, padding: 22, width: '100%', maxWidth: 380, gap: 14 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 46, height: 46, borderRadius: 14, backgroundColor: '#D9770618',
              alignItems: 'center', justifyContent: 'center' }}>
              <RotateCcw size={22} color="#D97706" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '800', color: c.text }}>
                Unfinished Uploads Found
              </Text>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 2 }}>
                {count} upload{count > 1 ? 's were' : ' was'} interrupted
              </Text>
            </View>
          </View>
          <Text style={{ fontSize: 13, color: c.text, opacity: 0.65, lineHeight: 19 }}>
            {"We found uploads that didn't complete. You can resume them now or discard them."}
          </Text>
          <View style={{ gap: 10 }}>
            <Pressable onPress={resumeAllRecoverable}
              style={[neuPressedStyle(isDark), { padding: 14, borderRadius: 13, alignItems: 'center',
                backgroundColor: c.primary }]}>
              <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff' }}>
                Resume All ({count})
              </Text>
            </Pressable>
            <Pressable onPress={() => setShowRecoveryDialog(false)}
              style={[neuFlatStyle(isDark), { padding: 12, borderRadius: 13, alignItems: 'center' }]}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.6 }}>
                Resume Later
              </Text>
            </Pressable>
            <Pressable onPress={discardRecoverable}
              style={{ padding: 10, alignItems: 'center' }}>
              <Text style={{ fontSize: 13, color: '#DC2626', fontWeight: '600' }}>
                Discard All
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── Bulk action bar ──────────────────────────────────────────────────────────
function BulkActions({ isDark }: { isDark: boolean }) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const { tasks, clearCompleted, retryAllFailed } = useUploadQueueStore();

  const hasCompleted = tasks.some((t) => t.status === 'ready' || t.status === 'canceled');
  const hasFailed = tasks.some((t) => t.status === 'failed');

  if (!hasCompleted && !hasFailed) return null;

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
      {hasFailed && (
        <Pressable onPress={retryAllFailed}
          style={[neuFlatStyle(isDark), { flexDirection: 'row', gap: 5, paddingHorizontal: 12,
            paddingVertical: 8, borderRadius: 10, alignItems: 'center' }]}>
          <RefreshCw size={12} color="#3B82F6" />
          <Text style={{ fontSize: 12, fontWeight: '600', color: '#3B82F6' }}>Retry All Failed</Text>
        </Pressable>
      )}
      {hasCompleted && (
        <Pressable onPress={clearCompleted}
          style={[neuFlatStyle(isDark), { flexDirection: 'row', gap: 5, paddingHorizontal: 12,
            paddingVertical: 8, borderRadius: 10, alignItems: 'center' }]}>
          <Trash2 size={12} color={`${c.text}60`} />
          <Text style={{ fontSize: 12, fontWeight: '600', color: `${c.text}70` }}>Clear Completed</Text>
        </Pressable>
      )}
    </View>
  );
}

// ─── Queue header ─────────────────────────────────────────────────────────────
function QueueHeader({ isDark, onClose }: { isDark: boolean; onClose: () => void }) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const { tasks } = useUploadQueueStore();
  const uploading = tasks.filter((t) => t.status === 'uploading').length;
  const waiting   = tasks.filter((t) => t.status === 'waiting').length;
  const ready     = tasks.filter((t) => t.status === 'ready').length;
  const failed    = tasks.filter((t) => t.status === 'failed').length;
  const recovering = tasks.filter((t) => t.status === 'recovering').length;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
      paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: `${c.text}10` }}>
      <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: `${c.primary}18`,
        alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
        <Upload size={18} color={c.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontWeight: '800', color: c.text }}>Upload Queue</Text>
        <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, marginTop: 1 }}>
          {uploading > 0 ? `${uploading} uploading · ` : ''}
          {waiting > 0 ? `${waiting} waiting · ` : ''}
          {recovering > 0 ? `${recovering} recovering · ` : ''}
          {ready > 0 ? `${ready} done · ` : ''}
          {failed > 0 ? `${failed} failed · ` : ''}
          {tasks.length} total
        </Text>
      </View>
      <Pressable onPress={onClose} hitSlop={8}
        style={[neuFlatStyle(isDark), { borderRadius: 8, padding: 7 }]}>
        <X size={16} color={c.text} opacity={0.5} />
      </Pressable>
    </View>
  );
}

// ─── FAB Badge ────────────────────────────────────────────────────────────────
export function UploadFAB() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { tasks, unreadCount, clearUnread, queueVisible, setQueueVisible, showRecoveryDialog } =
    useUploadQueueStore();

  useVideoUploader();

  const activeCount = tasks.filter((t) =>
    ['waiting', 'uploading', 'paused', 'processing', 'encoding',
     'generating_streams', 'verifying', 'recovering'].includes(t.status),
  ).length;

  return (
    <>
      <RecoveryDialog isDark={isDark} />
      {tasks.length > 0 && (
        <>
          <Pressable
            onPress={() => { setQueueVisible(true); clearUnread(); }}
            style={[neuFlatStyle(isDark), {
              position: 'absolute', bottom: 100, right: 16,
              width: 52, height: 52, borderRadius: 16,
              alignItems: 'center', justifyContent: 'center', zIndex: 999,
            }]}>
            <Upload size={22} color={activeCount > 0 ? c.primary : '#16A34A'} />
            {unreadCount > 0 && (
              <View style={{
                position: 'absolute', top: -4, right: -4, backgroundColor: '#DC2626',
                borderRadius: 9, minWidth: 18, height: 18, alignItems: 'center',
                justifyContent: 'center', paddingHorizontal: 4,
              }}>
                <Text style={{ fontSize: 10, fontWeight: '800', color: '#fff' }}>
                  {unreadCount > 9 ? '9+' : unreadCount}
                </Text>
              </View>
            )}
          </Pressable>
          <VideoUploadQueuePanel visible={queueVisible} onClose={() => setQueueVisible(false)} />
        </>
      )}
    </>
  );
}

// ─── Main panel modal ─────────────────────────────────────────────────────────
export function VideoUploadQueuePanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { tasks } = useUploadQueueStore();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' }}>
        <View style={[{ backgroundColor: c.base, borderTopLeftRadius: 24, borderTopRightRadius: 24,
          maxHeight: '85%', paddingBottom: 32 }, neuFlatStyle(isDark)]}>
          <QueueHeader isDark={isDark} onClose={onClose} />
          <BulkActions isDark={isDark} />
          {tasks.length === 0 ? (
            <View style={{ alignItems: 'center', padding: 40, gap: 12 }}>
              <Upload size={40} color={`${c.text}25`} />
              <Text style={{ fontSize: 14, color: c.text, opacity: 0.4, fontWeight: '600' }}>
                Queue is empty
              </Text>
            </View>
          ) : (
            <FlatList
              data={tasks}
              keyExtractor={(t) => t.id}
              contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 20 }}
              renderItem={({ item }) => <UploadItemCard task={item} isDark={isDark} />}
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}
