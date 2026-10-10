/**
 * ProfilePhotoActions — the app's SINGLE profile-photo control.
 *
 * Used by BOTH the student profile and the doctor profile so the three photo
 * states can never drift apart between roles (the previous implementation had
 * two near-identical copies of the avatar block, which is why "Remove" ended
 * up implemented in neither).
 *
 * STATES
 *   no photo        → tap adds a photo (Add Photo)
 *   photo present   → tap opens an action sheet: Change Photo / Remove Photo
 *
 * REMOVE is destructive, so it is a two-step flow:
 *   action sheet → Remove Photo → confirmation dialog → onRemove()
 *
 * The component owns PRESENTATION ONLY (avatar, badge, sheet, confirm dialog,
 * busy overlay). The caller owns the work: picking (permission + ImagePicker)
 * and removing (API + toast + store update) stay in the screen, because the
 * media-library permission rationale modal already lives there and must not be
 * duplicated.
 *
 * Both modals render through <ResponsiveModal> → <PortalOverlay>, i.e. the
 * app's single window. React Native's <Modal> is deliberately NOT used: its
 * Android dialog-window show/dismiss race produces stacked/flickering windows.
 */

import React, { useState } from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { User, Camera, Trash2, ImageIcon, AlertTriangle } from 'lucide-react-native';
import { Image } from 'expo-image';
import { neuColors, mutedTextStyle } from '@/lib/neu';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { NeuButton } from '@/components/NeuButton';

export interface ProfilePhotoActionsProps {
  /** Current avatar URL — null/empty renders the default avatar. */
  avatarUrl: string | null | undefined;
  /** Colour tokens from the screen's theme. */
  c: typeof neuColors.light;
  /** True while an upload is in flight (caller-owned). */
  uploading?: boolean;
  /** True while a removal is in flight (caller-owned). */
  removing?: boolean;
  /** Opens the image picker. Called for "Add Photo" and "Change Photo". */
  onPick: () => void;
  /** Performs the removal. Rejecting keeps the avatar + surfaces the error. */
  onRemove: () => Promise<void>;
  /** Avatar diameter. Defaults to 96 (the app's profile-hero size). */
  size?: number;
  /** Extra bottom margin under the control. */
  marginBottom?: number;
}

export function ProfilePhotoActions({
  avatarUrl,
  c,
  uploading = false,
  removing = false,
  onPick,
  onRemove,
  size = 96,
  marginBottom = 14,
}: ProfilePhotoActionsProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const hasPhoto = !!avatarUrl;
  const busy = uploading || removing;
  const radius = size / 2;

  const handlePress = () => {
    if (busy) return;
    // No photo → straight to the picker. This IS the "Add Photo" action.
    if (!hasPhoto) {
      onPick();
      return;
    }
    setSheetOpen(true);
  };

  const handleChange = () => {
    setSheetOpen(false);
    onPick();
  };

  const handleAskRemove = () => {
    setSheetOpen(false);
    setConfirmOpen(true);
  };

  const handleConfirmRemove = async () => {
    setConfirmOpen(false);
    await onRemove();
  };

  return (
    <View style={{ alignItems: 'center', marginBottom }}>
      <Pressable
        onPress={handlePress}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={hasPhoto ? 'Change or remove profile photo' : 'Add profile photo'}
        style={{ width: size, height: size }}
      >
        <View
          style={{
            width: size, height: size, borderRadius: radius,
            backgroundColor: `${c.primary}18`,
            alignItems: 'center', justifyContent: 'center',
            shadowColor: c.shadowDark,
            shadowOffset: { width: 4, height: 4 },
            shadowOpacity: 0.6,
            shadowRadius: 10,
          }}
        >
          {busy ? (
            <ActivityIndicator color={c.primary} />
          ) : hasPhoto ? (
            <Image
              source={{ uri: avatarUrl as string }}
              style={{ width: size, height: size, borderRadius: radius }}
              contentFit="cover"
            />
          ) : (
            <User size={Math.round(size * 0.46)} color={c.primary} />
          )}
        </View>

        {/* Camera badge — the affordance that the photo is editable. */}
        {!busy && (
          <View
            style={{
              position: 'absolute', bottom: 0, right: 0,
              width: 28, height: 28, borderRadius: 14,
              backgroundColor: c.primary,
              alignItems: 'center', justifyContent: 'center',
              shadowColor: c.shadowDark,
              shadowOffset: { width: 2, height: 2 },
              shadowOpacity: 0.4, shadowRadius: 4,
            }}
          >
            <Camera size={14} color="#fff" />
          </View>
        )}
      </Pressable>

      {/* ── Action sheet: Change / Remove ─────────────────────────────── */}
      <ResponsiveModal
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Profile Photo"
        subtitle="Choose an action for your current photo."
      >
        <ActionRow
          c={c}
          icon={<ImageIcon size={18} color={c.primary} />}
          label="Change Photo"
          onPress={handleChange}
        />
        <ActionRow
          c={c}
          icon={<Trash2 size={18} color="#DC2626" />}
          label="Remove Photo"
          destructive
          onPress={handleAskRemove}
        />
      </ResponsiveModal>

      {/* ── Confirmation: removing is destructive and not recoverable ─── */}
      <ResponsiveModal
        visible={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Remove Photo?"
        subtitle="Your profile picture will be replaced with the default avatar. This cannot be undone."
        icon={
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
            <AlertTriangle size={20} color="#DC2626" />
          </View>
        }
        footer={
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <NeuButton
              label="Cancel"
              variant="secondary"
              onPress={() => setConfirmOpen(false)}
              style={{ flex: 1, minWidth: 0 }}
            />
            <NeuButton
              label="Remove"
              variant="danger"
              onPress={handleConfirmRemove}
              style={{ flex: 1, minWidth: 0 }}
            />
          </View>
        }
      >
        <Text style={{ fontSize: 14, ...mutedTextStyle(c, 0.6), lineHeight: 20 }}>
          The photo will be deleted from your profile and storage.
        </Text>
      </ResponsiveModal>
    </View>
  );
}

// ── Row used inside the action sheet ─────────────────────────────────────────

function ActionRow({
  c, icon, label, onPress, destructive = false,
}: {
  c: typeof neuColors.light;
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 12,
        paddingVertical: 14, paddingHorizontal: 4,
        borderBottomWidth: 1, borderBottomColor: `${c.text}0F`,
        minHeight: 52,
      }}
    >
      <View
        style={{
          width: 34, height: 34, borderRadius: 10,
          backgroundColor: destructive ? '#DC262618' : `${c.primary}15`,
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        {icon}
      </View>
      <Text
        style={{
          flex: 1, fontSize: 15, fontWeight: '600',
          color: destructive ? '#DC2626' : c.text,
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}
