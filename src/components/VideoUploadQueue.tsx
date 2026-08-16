/**
 * VideoUploadQueue.tsx
 * Floating upload queue panel — neumorphic design.
 * Adds: recovery dialog, verifying state, thumbnail preview, replace badge.
 */

import { useEffect, useRef } from 'react';
import {
  Animated, FlatList, Image, Modal, Pressable, Text, useColorScheme, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Upload, X, Pause, Play, RefreshCw, Trash2,
  CheckCircle, XCircle, Clock, Loader, ShieldCheck, ShieldAlert,
  Wifi, AlertTriangle, Film, RotateCcw,
} from 'lucide-react-native';
import { useUploadQueueStore } from '@/lib/uploadQueueStore';
import { useVideoUploader } from '@/lib/useVideoUploader';
import { neuColors, neuFlatStyle, neuPressedStyle, useLayout } from '@/lib/neu';
import {
  formatBytes, formatSpeed, formatEta, type UploadTask, type UploadStatus,
} from '@/lib/videoUploadEngine';

// Layout token alias for sub-components (avoids calling useLayout in every leaf)
type QueueLayout = ReturnType<typeof useLayout>;

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
function ProgressBar({ pct, color, isDark, lyt }: { pct: number; color: string; isDark: boolean; lyt: QueueLayout }) {
  const anim = useRef(new Animated.Value(pct)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: pct, duration: 250, useNativeDriver: false }).start();
  }, [pct]);
  // Bar height: pad.xs + 1 → fluid ~5–9dp (was hardcoded 7)
  const barH = lyt.pad.xs + 1;
  return (
    <View style={{ height: barH, borderRadius: barH / 2, overflow: 'hidden',
      ...neuPressedStyle(isDark), backgroundColor: isDark ? '#1a1a2e' : '#e8ecf0' }}>
      <Animated.View style={{
        height: '100%', borderRadius: barH / 2, backgroundColor: color,
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

function StageIndicator({ status, isDark, lyt }: { status: string; isDark: boolean; lyt: QueueLayout }) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const currentIdx = STAGE_ORDER.indexOf(status);
  // Dot sizes: active = captionSize+4 (~16–20dp), inactive = captionSize-1 (~10–14dp)
  const activeDot   = lyt.captionSize + 4;
  const inactiveDot = lyt.captionSize - 1;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: lyt.pad.xs, marginTop: lyt.pad.xs }}>
      {STAGES.map((stage, i) => {
        const done   = currentIdx > i;
        const active = currentIdx === i;
        const cfg    = STATUS_CONFIG[stage.key] ?? STATUS_CONFIG.waiting;
        const dotSz  = active ? activeDot : inactiveDot;
        return (
          <View key={stage.key} style={{ flex: 1, alignItems: 'center', gap: lyt.pad.xs - 1 }}>
            <View style={{
              width: dotSz, height: dotSz, borderRadius: dotSz / 2,
              backgroundColor: done ? '#16A34A' : active ? cfg.color : `${c.text}15`,
              alignItems: 'center', justifyContent: 'center',
            }}>
              {done   ? <CheckCircle size={Math.round(dotSz * 0.55)} color="#fff" /> :
               active ? <cfg.Icon    size={Math.round(dotSz * 0.55)} color="#fff" /> :
               <View style={{ width: Math.round(dotSz * 0.4), height: Math.round(dotSz * 0.4), borderRadius: dotSz, backgroundColor: `${c.text}30` }} />}
            </View>
            <Text style={{
              fontSize: lyt.captionSize - 3,
              color: active ? cfg.color : done ? '#16A34A' : `${c.text}50`,
              fontWeight: active ? '700' : '500',
            }} numberOfLines={1}>
              {stage.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ─── Upload item card ─────────────────────────────────────────────────────────
function UploadItemCard({ task, isDark, lyt }: { task: UploadTask; isDark: boolean; lyt: QueueLayout }) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const { pauseUpload, resumeUpload, cancelUpload, retryUpload, retryProcessing } = useVideoUploader();
  const { removeTask } = useUploadQueueStore();
  const cfg = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.waiting;
  const isActive     = task.status === 'uploading' || task.status === 'resuming';
  const isPaused     = task.status === 'paused';
  const isFailed     = task.status === 'failed';
  const isTimeout    = task.status === 'timeout';
  const isReady      = task.status === 'ready';
  const isCanceled   = task.status === 'canceled';
  const isRecovering = task.status === 'recovering';
  const isVerifying  = task.status === 'verifying';
  const isProcessing = ['processing', 'encoding', 'generating_streams'].includes(task.status);
  const showStages   = isProcessing || isVerifying || isReady;

  const canRetryProcessing = isTimeout && !!task.vdoCipherVideoId;
  const canRetryUpload     = isFailed;
  const canCancelFailed    = isFailed;

  const displayPct = isActive || isPaused || task.status === 'resuming'
    ? task.progress
    : STAGE_PROGRESS[task.status] ?? task.progress;

  const chunkLabel = (isActive || isPaused || task.status === 'resuming') &&
    task.totalChunks && task.totalChunks > 1
    ? `${task.chunksCompleted ?? 0} / ${task.totalChunks} chunks`
    : null;

  // Adaptive thumb size: ~touchTarget (44–52dp) — keeps tap targets large
  const thumbSz = Math.round(lyt.touchTarget * 0.9);
  // Action button padding: pad.sm (fluid ~6–10dp, was hardcoded 7)
  const btnPad  = lyt.pad.sm;
  // Inline badge radius: pad.xs (fluid ~4–6dp)
  const badgeR  = lyt.pad.xs;
  // Status icon size: captionSize (fluid ~10–13dp, was 11)
  const statusIconSz = lyt.captionSize;
  // Action icon size: captionSize+2 (fluid ~12–15dp, was 14)
  const actionIconSz = lyt.captionSize + 2;

  return (
    <View style={[neuFlatStyle(isDark), { borderRadius: lyt.cardRadius, padding: lyt.cardPx, gap: lyt.pad.md }]}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: lyt.pad.md }}>
        {isReady && task.thumbnailUrl ? (
          <View style={{ width: thumbSz, height: thumbSz, borderRadius: lyt.cardRadius / 2, overflow: 'hidden' }}>
            <Image source={{ uri: task.thumbnailUrl }} style={{ width: thumbSz, height: thumbSz }} resizeMode="cover" />
          </View>
        ) : (
          <View style={{
            width: thumbSz, height: thumbSz, borderRadius: lyt.cardRadius / 1.5,
            backgroundColor: `${cfg.color}18`, alignItems: 'center', justifyContent: 'center',
          }}>
            <Film size={Math.round(thumbSz * 0.45)} color={cfg.color} />
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: lyt.pad.sm }}>
            <Text style={{ fontSize: lyt.bodySize - 1, fontWeight: '700', color: c.text, flex: 1 }} numberOfLines={1}>
              {task.fileName}
            </Text>
            {task.isReplacement && (
              <View style={{ backgroundColor: '#7C3AED18', borderRadius: badgeR, paddingHorizontal: lyt.pad.sm, paddingVertical: 2 }}>
                <Text style={{ fontSize: lyt.captionSize - 2, fontWeight: '800', color: '#7C3AED' }}>REPLACE</Text>
              </View>
            )}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: lyt.pad.sm, marginTop: lyt.pad.xs - 1 }}>
            <cfg.Icon size={statusIconSz} color={cfg.color} />
            <Text style={{ fontSize: lyt.captionSize, fontWeight: '600', color: cfg.color }}>{cfg.label}</Text>
            {chunkLabel && (
              <Text style={{ fontSize: lyt.captionSize - 1, color: c.text, opacity: 0.45 }}>· {chunkLabel}</Text>
            )}
          </View>
        </View>
        {/* Action buttons */}
        <View style={{ flexDirection: 'row', gap: lyt.pad.sm - 1 }}>
          {isActive && (
            <Pressable onPress={() => pauseUpload(task.id)} hitSlop={8}
              style={[neuFlatStyle(isDark), { borderRadius: lyt.pad.md, padding: btnPad }]}>
              <Pause size={actionIconSz} color="#D97706" />
            </Pressable>
          )}
          {(isPaused || isRecovering) && (
            <Pressable onPress={() => resumeUpload(task.id)} hitSlop={8}
              style={[neuFlatStyle(isDark), { borderRadius: lyt.pad.md, padding: btnPad }]}>
              <Play size={actionIconSz} color="#3B82F6" />
            </Pressable>
          )}
          {canRetryUpload && (
            <Pressable onPress={() => retryUpload(task.id)} hitSlop={8}
              style={[neuFlatStyle(isDark), { borderRadius: lyt.pad.md, padding: btnPad, flexDirection: 'row', alignItems: 'center', gap: lyt.pad.xs }]}>
              <RefreshCw size={actionIconSz} color="#3B82F6" />
              <Text style={{ fontSize: lyt.captionSize - 1, fontWeight: '700', color: '#3B82F6' }}>Retry</Text>
            </Pressable>
          )}
          {canRetryProcessing && (
            <Pressable onPress={() => retryProcessing(task.id)} hitSlop={8}
              style={[neuFlatStyle(isDark), { borderRadius: lyt.pad.md, padding: btnPad, flexDirection: 'row', alignItems: 'center', gap: lyt.pad.xs }]}>
              <RotateCcw size={actionIconSz - 1} color="#F97316" />
              <Text style={{ fontSize: lyt.captionSize - 1, fontWeight: '700', color: '#F97316' }}>Retry</Text>
            </Pressable>
          )}
          {(isActive || isPaused || task.status === 'waiting' || isRecovering || isProcessing || canCancelFailed) && (
            <Pressable onPress={() => cancelUpload(task.id)} hitSlop={8}
              style={[neuFlatStyle(isDark), { borderRadius: lyt.pad.md, padding: btnPad }]}>
              <X size={actionIconSz} color="#DC2626" />
            </Pressable>
          )}
          {isTimeout && (
            <Pressable onPress={() => removeTask(task.id)} hitSlop={8}
              style={[neuFlatStyle(isDark), { borderRadius: lyt.pad.md, padding: btnPad }]}>
              <Trash2 size={actionIconSz} color={`${c.text}60`} />
            </Pressable>
          )}
          {(isReady || isCanceled || isFailed) && (
            <Pressable onPress={() => removeTask(task.id)} hitSlop={8}
              style={[neuFlatStyle(isDark), { borderRadius: lyt.pad.md, padding: btnPad }]}>
              <Trash2 size={actionIconSz} color={`${c.text}60`} />
            </Pressable>
          )}
        </View>
      </View>

      {/* Progress bar */}
      {(isActive || isPaused || task.status === 'resuming' || isProcessing || isVerifying) && (
        <ProgressBar pct={displayPct} color={cfg.color} isDark={isDark} lyt={lyt} />
      )}
      {isReady && <ProgressBar pct={100} color="#16A34A" isDark={isDark} lyt={lyt} />}

      {/* Upload stats */}
      {(isActive || isPaused || task.status === 'resuming') && (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: lyt.pad.xs }}>
          <Text style={{ fontSize: lyt.captionSize - 1, color: c.text, opacity: 0.5 }}>
            {formatBytes(task.bytesUploaded)} / {formatBytes(task.fileSize)}
          </Text>
          <Text style={{ fontSize: lyt.captionSize - 1, color: c.text, opacity: 0.5 }}>
            {formatSpeed(task.speedBps)}  ·  ETA {formatEta(task.etaSeconds)}
          </Text>
          <Text style={{ fontSize: lyt.captionSize - 1, fontWeight: '700', color: cfg.color }}>{displayPct}%</Text>
        </View>
      )}

      {/* Stage indicator */}
      {showStages && <StageIndicator status={task.status} isDark={isDark} lyt={lyt} />}

      {/* Verification result */}
      {isReady && task.verificationStatus === 'passed' && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: lyt.pad.sm,
          backgroundColor: '#2DA8FF15', borderRadius: lyt.pad.md, padding: lyt.pad.sm + 1 }}>
          <ShieldCheck size={lyt.captionSize} color="#2DA8FF" />
          <Text style={{ fontSize: lyt.captionSize, color: '#2DA8FF', fontWeight: '600' }}>Integrity verified</Text>
        </View>
      )}

      {/* Error message */}
      {isFailed && task.errorMessage && (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: lyt.pad.sm,
          backgroundColor: '#DC262615', borderRadius: lyt.pad.md, padding: lyt.pad.sm + 2 }}>
          <AlertTriangle size={lyt.captionSize + 1} color="#DC2626" style={{ marginTop: 1 }} />
          <Text style={{ fontSize: lyt.captionSize, color: '#DC2626', flex: 1, lineHeight: lyt.captionSize * 1.5 }}>
            {task.errorMessage}
          </Text>
        </View>
      )}

      {/* Timeout */}
      {isTimeout && task.vdoCipherVideoId && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: lyt.pad.sm,
          backgroundColor: '#F9731615', borderRadius: lyt.pad.md, paddingHorizontal: lyt.pad.sm + 2, paddingVertical: lyt.pad.sm }}>
          <RotateCcw size={lyt.captionSize - 1} color="#F97316" />
          <Text style={{ fontSize: lyt.captionSize - 1, color: '#F97316', flex: 1, lineHeight: lyt.captionSize * 1.4 }}>
            Processing timed out — tap Retry Processing to check encoding status.
          </Text>
        </View>
      )}

      {/* Recovering hint */}
      {isRecovering && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: lyt.pad.sm,
          backgroundColor: '#D9770615', borderRadius: lyt.pad.md, padding: lyt.pad.sm + 1 }}>
          <RotateCcw size={lyt.captionSize} color="#D97706" />
          <Text style={{ fontSize: lyt.captionSize - 1, color: '#D97706' }}>
            Upload was interrupted. Tap ▶ to resume from last checkpoint.
          </Text>
        </View>
      )}

      {/* Resuming hint */}
      {task.status === 'resuming' && task.totalChunks && task.totalChunks > 1 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: lyt.pad.sm,
          backgroundColor: '#2DA8FF15', borderRadius: lyt.pad.md, padding: lyt.pad.sm + 1 }}>
          <RotateCcw size={lyt.captionSize} color="#2DA8FF" />
          <Text style={{ fontSize: lyt.captionSize - 1, color: '#2DA8FF' }}>
            Resuming from chunk {task.chunksCompleted ?? 0} of {task.totalChunks}
          </Text>
        </View>
      )}

      {/* Success detail */}
      {isReady && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: lyt.pad.sm,
          backgroundColor: '#16A34A15', borderRadius: lyt.pad.md, padding: lyt.pad.sm + 2 }}>
          <CheckCircle size={lyt.captionSize + 1} color="#16A34A" />
          <Text style={{ fontSize: lyt.captionSize, color: '#16A34A', fontWeight: '600' }}>
            ✓ Upload complete · {formatBytes(task.fileSize)}
          </Text>
        </View>
      )}
    </View>
  );
}

// ─── Recovery dialog ──────────────────────────────────────────────────────────
function RecoveryDialog({ isDark, lyt }: { isDark: boolean; lyt: QueueLayout }) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const { showRecoveryDialog, setShowRecoveryDialog, recoverableTasks, discardRecoverable } =
    useUploadQueueStore();
  const { resumeAllRecoverable } = useVideoUploader();
  const count = recoverableTasks().length;

  if (!showRecoveryDialog || count === 0) return null;

  // Dialog width: adaptive (phone → full width w/ gutter; tablet → maxWidth constrained)
  const dialogMaxW = lyt.modalWidth ?? lyt.width - lyt.screenPx * 2;

  return (
    <Modal visible transparent animationType="fade">
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center', alignItems: 'center', paddingHorizontal: lyt.screenPx }}>
        <View style={[neuFlatStyle(isDark), {
          borderRadius: lyt.cardRadius * 1.2,
          padding: lyt.cardPx * 1.1,
          width: '100%',
          maxWidth: dialogMaxW,
          gap: lyt.pad.lg,
        }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: lyt.pad.lg }}>
            <View style={{
              width: lyt.touchTarget + 2,
              height: lyt.touchTarget + 2,
              borderRadius: lyt.cardRadius / 1.5,
              backgroundColor: '#D9770618',
              alignItems: 'center', justifyContent: 'center',
            }}>
              <RotateCcw size={Math.round(lyt.touchTarget * 0.5)} color="#D97706" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: lyt.headingSize, fontWeight: '800', color: c.text }}>
                Unfinished Uploads Found
              </Text>
              <Text style={{ fontSize: lyt.captionSize, color: c.text, opacity: 0.5, marginTop: lyt.pad.xs - 1 }}>
                {count} upload{count > 1 ? 's were' : ' was'} interrupted
              </Text>
            </View>
          </View>
          <Text style={{ fontSize: lyt.bodySize - 1, color: c.text, opacity: 0.65, lineHeight: lyt.bodySize * 1.5 }}>
            {"We found uploads that didn't complete. You can resume them now or discard them."}
          </Text>
          <View style={{ gap: lyt.pad.md }}>
            <Pressable onPress={resumeAllRecoverable}
              style={[neuPressedStyle(isDark), {
                padding: lyt.pad.lg,
                borderRadius: lyt.cardRadius,
                alignItems: 'center',
                backgroundColor: c.primary,
              }]}>
              <Text style={{ fontSize: lyt.bodySize, fontWeight: '800', color: '#fff' }}>
                Resume All ({count})
              </Text>
            </Pressable>
            <Pressable onPress={() => setShowRecoveryDialog(false)}
              style={[neuFlatStyle(isDark), { padding: lyt.pad.md + 2, borderRadius: lyt.cardRadius, alignItems: 'center' }]}>
              <Text style={{ fontSize: lyt.bodySize - 1, fontWeight: '700', color: c.text, opacity: 0.6 }}>
                Resume Later
              </Text>
            </Pressable>
            <Pressable onPress={discardRecoverable} style={{ padding: lyt.pad.sm + 2, alignItems: 'center' }}>
              <Text style={{ fontSize: lyt.bodySize - 1, color: '#DC2626', fontWeight: '600' }}>
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
function BulkActions({ isDark, lyt }: { isDark: boolean; lyt: QueueLayout }) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const { tasks, clearCompleted, retryAllFailed } = useUploadQueueStore();

  const hasCompleted = tasks.some((t) => t.status === 'ready' || t.status === 'canceled');
  const hasFailed    = tasks.some((t) => t.status === 'failed');

  if (!hasCompleted && !hasFailed) return null;

  return (
    <View style={{
      flexDirection: 'row', flexWrap: 'wrap',
      gap: lyt.pad.sm,
      paddingHorizontal: lyt.pad.lg,
      paddingBottom: lyt.pad.sm,
    }}>
      {hasFailed && (
        <Pressable onPress={retryAllFailed}
          style={[neuFlatStyle(isDark), {
            flexDirection: 'row', gap: lyt.pad.xs + 1,
            paddingHorizontal: lyt.pad.md + 2,
            paddingVertical: lyt.pad.sm,
            borderRadius: lyt.pad.md + 2,
            alignItems: 'center',
          }]}>
          <RefreshCw size={lyt.captionSize} color="#3B82F6" />
          <Text style={{ fontSize: lyt.captionSize, fontWeight: '600', color: '#3B82F6' }}>Retry All Failed</Text>
        </Pressable>
      )}
      {hasCompleted && (
        <Pressable onPress={clearCompleted}
          style={[neuFlatStyle(isDark), {
            flexDirection: 'row', gap: lyt.pad.xs + 1,
            paddingHorizontal: lyt.pad.md + 2,
            paddingVertical: lyt.pad.sm,
            borderRadius: lyt.pad.md + 2,
            alignItems: 'center',
          }]}>
          <Trash2 size={lyt.captionSize} color={`${c.text}60`} />
          <Text style={{ fontSize: lyt.captionSize, fontWeight: '600', color: `${c.text}70` }}>Clear Completed</Text>
        </Pressable>
      )}
    </View>
  );
}

// ─── Queue header ─────────────────────────────────────────────────────────────
function QueueHeader({ isDark, onClose, lyt }: { isDark: boolean; onClose: () => void; lyt: QueueLayout }) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const { tasks } = useUploadQueueStore();
  const uploading  = tasks.filter((t) => t.status === 'uploading').length;
  const waiting    = tasks.filter((t) => t.status === 'waiting').length;
  const ready      = tasks.filter((t) => t.status === 'ready').length;
  const failed     = tasks.filter((t) => t.status === 'failed').length;
  const recovering = tasks.filter((t) => t.status === 'recovering').length;

  // Header icon container: 80% of touchTarget, fluid 36–42dp
  const iconBoxSz = Math.round(lyt.touchTarget * 0.8);

  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: lyt.pad.lg,
      paddingVertical: lyt.pad.md + 2,
      borderBottomWidth: 1,
      borderBottomColor: `${c.text}10`,
    }}>
      <View style={{
        width: iconBoxSz, height: iconBoxSz,
        borderRadius: lyt.pad.md,
        backgroundColor: `${c.primary}18`,
        alignItems: 'center', justifyContent: 'center',
        marginRight: lyt.pad.md,
      }}>
        <Upload size={Math.round(iconBoxSz * 0.5)} color={c.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: lyt.headingSize, fontWeight: '800', color: c.text }}>Upload Queue</Text>
        <Text style={{ fontSize: lyt.captionSize - 1, color: c.text, opacity: 0.5, marginTop: lyt.pad.xs - 2 }}>
          {uploading  > 0 ? `${uploading} uploading · `   : ''}
          {waiting    > 0 ? `${waiting} waiting · `       : ''}
          {recovering > 0 ? `${recovering} recovering · ` : ''}
          {ready      > 0 ? `${ready} done · `            : ''}
          {failed     > 0 ? `${failed} failed · `         : ''}
          {tasks.length} total
        </Text>
      </View>
      <Pressable onPress={onClose} hitSlop={8}
        style={[neuFlatStyle(isDark), { borderRadius: lyt.pad.md, padding: lyt.pad.sm + 1 }]}>
        <X size={lyt.bodySize} color={c.text} opacity={0.5} />
      </Pressable>
    </View>
  );
}

// ─── FAB Badge ────────────────────────────────────────────────────────────────
export function UploadFAB() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const lyt = useLayout();
  const insets = useSafeAreaInsets();
  const { tasks, unreadCount, clearUnread, queueVisible, setQueueVisible } =
    useUploadQueueStore();

  useVideoUploader();

  const activeCount = tasks.filter((t) =>
    ['waiting', 'uploading', 'paused', 'processing', 'encoding',
     'generating_streams', 'verifying', 'recovering'].includes(t.status),
  ).length;

  // FAB position: above tab bar visual height + bottom safe-area inset + breathing room.
  // React Navigation's tab bar sits flush with the screen bottom; its internal height
  // already includes the bottom inset padding. So the FAB must clear:
  //   tabBarHeight (visual tab strip) + insets.bottom (system nav / gesture area) + pad.md
  const fabBottom = lyt.tabBarHeight + insets.bottom + lyt.pad.md;
  // FAB size: touchTarget + pad.sm (fluid 50–62dp, was hardcoded 52)
  const fabSz = lyt.touchTarget + lyt.pad.sm;

  return (
    <>
      <RecoveryDialog isDark={isDark} lyt={lyt} />
      {tasks.length > 0 && (
        <>
          <Pressable
            onPress={() => { setQueueVisible(true); clearUnread(); }}
            style={[neuFlatStyle(isDark), {
              position: 'absolute',
              bottom: fabBottom,
              right: lyt.pad.lg,
              width: fabSz, height: fabSz,
              borderRadius: lyt.cardRadius,
              alignItems: 'center', justifyContent: 'center',
              zIndex: 999,
            }]}>
            <Upload size={Math.round(fabSz * 0.42)} color={activeCount > 0 ? c.primary : '#16A34A'} />
            {unreadCount > 0 && (
              <View style={{
                position: 'absolute', top: -4, right: -4,
                backgroundColor: '#DC2626',
                borderRadius: lyt.pad.md,
                minWidth: lyt.pad.lg + 2, height: lyt.pad.lg + 2,
                alignItems: 'center', justifyContent: 'center',
                paddingHorizontal: lyt.pad.xs,
              }}>
                <Text style={{ fontSize: lyt.captionSize - 2, fontWeight: '800', color: '#fff' }}>
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
  const lyt = useLayout();
  const insets = useSafeAreaInsets();
  const { tasks } = useUploadQueueStore();

  // Bottom padding: use real inset so home indicator / gesture bar / Android nav
  // bar are always cleared — never rely on a hardcoded pageBottom alone.
  const sheetPaddingBottom = Math.max(insets.bottom + lyt.pad.md, lyt.pageBottom);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' }}>
        <View style={[{
          backgroundColor: c.base,
          borderTopLeftRadius: lyt.cardRadius * 1.5,
          borderTopRightRadius: lyt.cardRadius * 1.5,
          maxHeight: '85%',
          paddingBottom: sheetPaddingBottom,
        }, neuFlatStyle(isDark)]}>
          <QueueHeader isDark={isDark} onClose={onClose} lyt={lyt} />
          <BulkActions isDark={isDark} lyt={lyt} />
          {tasks.length === 0 ? (
            <View style={{ alignItems: 'center', padding: lyt.pad.xxxl, gap: lyt.pad.md }}>
              <Upload size={Math.round(lyt.touchTarget * 0.9)} color={`${c.text}25`} />
              <Text style={{ fontSize: lyt.bodySize - 1, color: c.text, opacity: 0.4, fontWeight: '600' }}>
                Queue is empty
              </Text>
            </View>
          ) : (
            <FlatList
              data={tasks}
              keyExtractor={(t) => t.id}
              contentContainerStyle={{
                padding: lyt.pad.lg,
                gap: lyt.pad.md,
                paddingBottom: lyt.pad.xl,
              }}
              renderItem={({ item }) => <UploadItemCard task={item} isDark={isDark} lyt={lyt} />}
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}
