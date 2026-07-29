/**
 * NotificationCenter.tsx
 *
 * Bell icon with unread badge + slide-down notification history panel.
 * Shows upload lifecycle events: started → progress → paused → resumed
 * → completed → processing → ready → failed.
 *
 * Design: neumorphic, matches VideoUploadQueue aesthetic.
 */

import { useEffect, useRef } from 'react';
import {
  Animated, FlatList, Modal, Pressable, Text, useColorScheme, View,
} from 'react-native';
import {
  Bell, Upload, Pause, Play, CheckCircle, XCircle, AlertTriangle,
  Clock, Loader, Film, X, Trash2,
} from 'lucide-react-native';
import { neuColors, neuFlatStyle, neuPressedStyle } from '@/lib/neu';
import {
  useUploadNotificationStore,
  type UploadNotification,
  type NotificationType,
} from '@/lib/uploadNotificationStore';

// ─── Per-type display config ──────────────────────────────────────────────────
const TYPE_CONFIG: Record<NotificationType, { label: string; color: string; Icon: any }> = {
  upload_started:     { label: 'Upload started',       color: '#3B82F6', Icon: Upload },
  upload_progress:    { label: 'Uploading…',           color: '#3B82F6', Icon: Upload },
  upload_paused:      { label: 'Upload paused',        color: '#D97706', Icon: Pause },
  upload_resumed:     { label: 'Upload resumed',       color: '#2DA8FF', Icon: Play },
  upload_completed:   { label: 'Upload completed',     color: '#16A34A', Icon: CheckCircle },
  processing:         { label: 'Video processing…',    color: '#7C3AED', Icon: Loader },
  video_ready:        { label: 'Video ready',          color: '#16A34A', Icon: CheckCircle },
  upload_failed:      { label: 'Upload failed',        color: '#DC2626', Icon: XCircle },
  processing_timeout: { label: 'Processing timed out', color: '#F97316', Icon: AlertTriangle },
};

// ─── Relative time helper ─────────────────────────────────────────────────────
function relativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Single notification row ──────────────────────────────────────────────────
function NotifRow({ item, isDark }: { item: UploadNotification; isDark: boolean }) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const cfg = TYPE_CONFIG[item.type] ?? TYPE_CONFIG.upload_started;

  return (
    <View style={[
      neuFlatStyle(isDark),
      {
        borderRadius: 14, padding: 12, gap: 6,
        opacity: item.read ? 0.75 : 1,
        borderLeftWidth: 3,
        borderLeftColor: item.read ? 'transparent' : cfg.color,
      },
    ]}>
      {/* Header row */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{
          width: 32, height: 32, borderRadius: 9,
          backgroundColor: `${cfg.color}18`,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <cfg.Icon size={15} color={cfg.color} />
        </View>

        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: cfg.color }}>
              {cfg.label}
            </Text>
            {!item.read && (
              <View style={{
                width: 6, height: 6, borderRadius: 3, backgroundColor: cfg.color,
              }} />
            )}
          </View>
          <Text style={{ fontSize: 11, color: c.text, opacity: 0.55 }} numberOfLines={1}>
            {item.fileName}
          </Text>
        </View>

        <Text style={{ fontSize: 10, color: c.text, opacity: 0.4 }}>
          {relativeTime(item.timestamp)}
        </Text>
      </View>

      {/* Progress bar for in-progress items */}
      {item.type === 'upload_progress' && item.progress !== undefined && (
        <View style={{ gap: 3 }}>
          <View style={{
            height: 5, borderRadius: 3, overflow: 'hidden',
            backgroundColor: isDark ? '#1a1a2e' : '#e0e4ea',
          }}>
            <View style={{
              height: '100%', borderRadius: 3,
              backgroundColor: cfg.color,
              width: `${item.progress}%` as any,
            }} />
          </View>
          <Text style={{ fontSize: 10, color: cfg.color, fontWeight: '700' }}>
            Uploading ({item.progress}%)
          </Text>
        </View>
      )}

      {/* Message */}
      {item.message ? (
        <Text style={{ fontSize: 11, color: c.text, opacity: 0.65, lineHeight: 16 }}>
          {item.message}
        </Text>
      ) : null}

      {/* Error detail */}
      {item.errorMessage && (
        <View style={{
          backgroundColor: '#DC262612', borderRadius: 8,
          paddingHorizontal: 8, paddingVertical: 6,
          flexDirection: 'row', alignItems: 'flex-start', gap: 6,
        }}>
          <AlertTriangle size={11} color="#DC2626" style={{ marginTop: 1 }} />
          <Text style={{ fontSize: 11, color: '#DC2626', flex: 1, lineHeight: 16 }}>
            {item.errorMessage}
          </Text>
        </View>
      )}
    </View>
  );
}

// ─── Notification panel ───────────────────────────────────────────────────────
function NotificationPanel({
  visible,
  onClose,
  isDark,
}: {
  visible: boolean;
  onClose: () => void;
  isDark: boolean;
}) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const { notifications, clearAll } = useUploadNotificationStore();
  const slideAnim = useRef(new Animated.Value(-420)).current;

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: visible ? 0 : -420,
      useNativeDriver: true,
      tension: 68,
      friction: 12,
    }).start();
  }, [visible]);

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      {/* Backdrop */}
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }}
        onPress={onClose}
      />
      {/* Panel — slides down from top */}
      <Animated.View style={{
        position: 'absolute',
        top: 0, left: 0, right: 0,
        transform: [{ translateY: slideAnim }],
        maxHeight: '75%',
        ...neuFlatStyle(isDark),
        borderBottomLeftRadius: 24,
        borderBottomRightRadius: 24,
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: isDark ? 0.5 : 0.15,
        shadowRadius: 20,
        elevation: 24,
      }}>
        {/* Header */}
        <View style={{
          flexDirection: 'row', alignItems: 'center',
          paddingHorizontal: 16, paddingTop: 52, paddingBottom: 12,
          borderBottomWidth: 1, borderBottomColor: `${c.text}10`,
        }}>
          <View style={{
            width: 36, height: 36, borderRadius: 10,
            backgroundColor: `${c.primary}18`,
            alignItems: 'center', justifyContent: 'center',
            marginRight: 10,
          }}>
            <Bell size={18} color={c.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '800', color: c.text }}>
              Notifications
            </Text>
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, marginTop: 1 }}>
              {notifications.length === 0
                ? 'No notifications yet'
                : `${notifications.length} upload event${notifications.length !== 1 ? 's' : ''}`}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {notifications.length > 0 && (
              <Pressable
                onPress={clearAll}
                hitSlop={8}
                style={[neuFlatStyle(isDark), { borderRadius: 8, padding: 7 }]}
              >
                <Trash2 size={14} color={`${c.text}60`} />
              </Pressable>
            )}
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={[neuFlatStyle(isDark), { borderRadius: 8, padding: 7 }]}
            >
              <X size={16} color={c.text} opacity={0.5} />
            </Pressable>
          </View>
        </View>

        {/* List */}
        {notifications.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 48, gap: 10 }}>
            <View style={{
              width: 56, height: 56, borderRadius: 16,
              backgroundColor: `${c.text}08`,
              alignItems: 'center', justifyContent: 'center',
            }}>
              <Film size={26} color={`${c.text}30`} />
            </View>
            <Text style={{ fontSize: 13, color: c.text, opacity: 0.4, fontWeight: '600' }}>
              No upload notifications yet
            </Text>
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.3, textAlign: 'center', paddingHorizontal: 32 }}>
              Upload activity will appear here
            </Text>
          </View>
        ) : (
          <FlatList
            data={notifications}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ padding: 12, gap: 8 }}
            renderItem={({ item }) => <NotifRow item={item} isDark={isDark} />}
            showsVerticalScrollIndicator={false}
          />
        )}
      </Animated.View>
    </Modal>
  );
}

// ─── Bell button (exported — placed in app layout) ────────────────────────────
export function NotificationBell() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const { unreadCount, markAllRead, notifications } = useUploadNotificationStore();
  const [panelOpen, setPanelOpen] = React.useState(false);

  const openPanel = () => {
    setPanelOpen(true);
    // Mark all read when panel opens
    if (unreadCount > 0) markAllRead();
  };

  const closePanel = () => setPanelOpen(false);

  if (notifications.length === 0 && unreadCount === 0) return null;

  return (
    <>
      <Pressable
        onPress={openPanel}
        hitSlop={10}
        style={[
          neuFlatStyle(isDark),
          {
            borderRadius: 12, padding: 8,
            position: 'relative',
            alignItems: 'center', justifyContent: 'center',
          },
        ]}
      >
        <Bell size={20} color={c.primary} />
        {unreadCount > 0 && (
          <View style={{
            position: 'absolute', top: 2, right: 2,
            minWidth: 16, height: 16, borderRadius: 8,
            backgroundColor: '#DC2626',
            alignItems: 'center', justifyContent: 'center',
            paddingHorizontal: 3,
            borderWidth: 1.5, borderColor: c.base,
          }}>
            <Text style={{ fontSize: 9, fontWeight: '800', color: '#fff' }}>
              {unreadCount > 9 ? '9+' : String(unreadCount)}
            </Text>
          </View>
        )}
      </Pressable>

      <NotificationPanel
        visible={panelOpen}
        onClose={closePanel}
        isDark={isDark}
      />
    </>
  );
}

// React import needed for useState inside functional component
import React from 'react';
