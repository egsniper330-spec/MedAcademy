/**
 * PermissionRationaleModal
 * ─────────────────────────────────────────────────────────────────────────────
 * Neumorphic modal shown BEFORE the OS permission dialog.
 *
 * Two modes:
 *  • Normal   — explains WHY the permission is needed → user taps "Allow"
 *               → OS dialog appears.
 *  • Blocked  — permission permanently denied → shows "Open Settings" CTA.
 *
 * Used with usePermission():
 *   <PermissionRationaleModal
 *     type="camera"
 *     visible={showRationale}
 *     isBlocked={isBlocked}
 *     onConfirm={confirmRequest}   // triggers OS dialog or openSettings
 *     onDismiss={() => setShowRationale(false)}
 *   />
 */

import React from 'react';
import {
  Modal,
  Pressable,
  Text,
  View,
  useColorScheme,
  useWindowDimensions,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Settings, ShieldAlert } from 'lucide-react-native';
import { neuColors } from '@/lib/neu';
import { PERMISSION_RATIONALES, type PermissionType } from '@/lib/permissions';

// ─── cssInterop note ─────────────────────────────────────────────────────────
// All Pressable elements here use cssInterop={false} + function-style `style`
// so Android does not lose backgroundColor when using the pressed state callback.

interface Props {
  type: PermissionType;
  visible: boolean;
  /** True when the permission is permanently blocked — shows Settings CTA */
  isBlocked?: boolean;
  /** Called when user taps the confirm / Allow button */
  onConfirm: () => void;
  /** Called when user taps the dismiss / "Not Now" button */
  onDismiss: () => void;
}

export function PermissionRationaleModal({
  type,
  visible,
  isBlocked = false,
  onConfirm,
  onDismiss,
}: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const rationale = PERMISSION_RATIONALES[type];
  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = useWindowDimensions();

  // Caps to 400 dp max; ensures readable width on tablets and margins on small phones
  const cardW = Math.min(screenW - Math.max(48, insets.left + insets.right + 48), 400);
  // Limit card height so buttons remain visible even at large accessibility font sizes
  const cardMaxH = screenH - Math.max(insets.top, 40) - Math.max(insets.bottom, 40) - 40;

  // Neumorphic surface style
  const surface = {
    backgroundColor: c.base,
    borderRadius: 24,
    overflow: 'hidden' as const,
    width: cardW,
    maxHeight: cardMaxH,
    shadowColor: c.shadowDark,
    shadowOffset: { width: 6, height: 6 },
    shadowOpacity: 0.55,
    shadowRadius: 12,
    elevation: 16,
  };

  // Primary button — neumorphic pressed inset feel
  const primaryBtn = {
    backgroundColor: c.primary,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center' as const,
    marginBottom: 10,
    shadowColor: c.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.38,
    shadowRadius: 10,
  };

  const secondaryBtn = {
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center' as const,
    backgroundColor: c.base,
    shadowColor: c.shadowDark,
    shadowOffset: { width: 2, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 5,
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onDismiss}
    >
      {/* Scrim — padding ensures card is never hidden behind system UI in any orientation */}
      <Pressable
        onPress={onDismiss}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.48)',
          justifyContent: 'center',
          alignItems: 'center',
          paddingHorizontal: Math.max(insets.left + 24, 24),
          paddingTop: Math.max(insets.top, 24),
          paddingBottom: Math.max(insets.bottom, 24),
        }}
      >
        {/* Card — stop scrim tap propagating inside */}
        <Pressable onPress={() => {}} style={surface}>
          {/* ScrollView so content survives large system font sizes */}
          <ScrollView
            contentContainerStyle={{ padding: 28 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            bounces={false}
          >
            {/* Icon */}
            <View style={{ alignItems: 'center', marginBottom: 20 }}>
              <View style={{
                width: 68, height: 68, borderRadius: 22,
                backgroundColor: isBlocked ? '#EF444418' : `${c.primary}18`,
                alignItems: 'center', justifyContent: 'center',
                shadowColor: isBlocked ? '#EF4444' : c.primary,
                shadowOffset: { width: 0, height: 6 },
                shadowOpacity: 0.2,
                shadowRadius: 10,
              }}>
                {isBlocked
                  ? <ShieldAlert size={34} color="#EF4444" />
                  : <PermissionIcon type={type} color={c.primary} />
                }
              </View>
            </View>

            {/* Title */}
            <Text style={{
              fontSize: 18, fontWeight: '800', color: c.text,
              textAlign: 'center', marginBottom: 10, letterSpacing: -0.2,
            }}>
              {isBlocked ? 'Permission Required' : rationale.title}
            </Text>

            {/* Message */}
            <Text style={{
              fontSize: 14, color: c.text, opacity: 0.62,
              textAlign: 'center', lineHeight: 21, marginBottom: 28,
            }}>
              {isBlocked
                ? `This feature requires ${permissionLabel(type)} access. Please enable it in your device Settings to continue.`
                : rationale.message}
            </Text>

            {/* Confirm button */}
            <Pressable
              cssInterop={false}
              onPress={onConfirm}
              style={({ pressed }) => [primaryBtn, { opacity: pressed ? 0.82 : 1 }]}
            >
              {isBlocked
                ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Settings size={16} color="#fff" />
                    <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>
                      Open Settings
                    </Text>
                  </View>
                )
                : (
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>
                    {rationale.confirmLabel ?? 'Allow'}
                  </Text>
                )}
            </Pressable>

            {/* Dismiss button */}
            <Pressable
              cssInterop={false}
              onPress={onDismiss}
              style={({ pressed }) => [secondaryBtn, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={{ color: c.text, fontWeight: '600', fontSize: 14, opacity: 0.6 }}>
                {isBlocked ? 'Not Now' : (rationale.denyLabel ?? 'Not Now')}
              </Text>
            </Pressable>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function permissionLabel(type: PermissionType): string {
  switch (type) {
    case 'camera':        return 'Camera';
    case 'mediaLibrary':  return 'Photo Library';
    case 'notifications': return 'Notifications';
    case 'microphone':    return 'Microphone';
  }
}

// Lazy icon imports to avoid re-bundling lucide on every render
function PermissionIcon({ type, color }: { type: PermissionType; color: string }) {
  switch (type) {
    case 'camera': {
      const { Camera } = require('lucide-react-native');
      return <Camera size={34} color={color} />;
    }
    case 'mediaLibrary': {
      const { ImageIcon } = require('lucide-react-native');
      return <ImageIcon size={34} color={color} />;
    }
    case 'notifications': {
      const { Bell } = require('lucide-react-native');
      return <Bell size={34} color={color} />;
    }
    case 'microphone': {
      const { Mic } = require('lucide-react-native');
      return <Mic size={34} color={color} />;
    }
  }
}
