/**
 * ResponsiveModal — Single reusable modal for the entire app.
 *
 * Behaviour:
 * • Mobile  → bottom-sheet, rounded top corners, slides up
 * • Desktop → centred dialog, max-width 700, max-height 90vh
 * • Keyboard-aware on both iOS and Android (behavior="padding")
 * • Safe-area insets respected on all devices
 * • Header:  title + optional subtitle + X close button
 * • Footer:  sticky button row (passed as `footer` prop)
 * • Content: ScrollView — never clips; supports 50+ field forms
 * • Dismiss: tap backdrop · swipe-down hint · X button · onRequestClose
 * • Dirty guard: when isDirty=true, shows "Unsaved changes" confirmation
 *   before closing. Pass onForceClose to bypass (e.g. after successful save).
 */

import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  useWindowDimensions,
  useColorScheme,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, AlertTriangle } from 'lucide-react-native';
import { neuColors } from '@/lib/neu';
import { NeuButton } from '@/components/NeuButton';

export interface ResponsiveModalProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** Sticky footer — typically Cancel + primary action buttons in a row */
  footer?: React.ReactNode;
  children: React.ReactNode;
  /** Icon node shown left of title */
  icon?: React.ReactNode;
  /**
   * When true, closing the modal will first show an "Unsaved changes" warning.
   * The user must confirm before the modal closes.
   */
  isDirty?: boolean;
}

export function ResponsiveModal({
  visible,
  onClose,
  title,
  subtitle,
  footer,
  children,
  icon,
  isDirty = false,
}: ResponsiveModalProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { height: screenH, width: screenW } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isWeb = process.env.EXPO_OS === 'web';
  const isTablet = screenW >= 768;

  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Cap sheet height conservatively: 92% on phones, 88% on tall tablets
  const maxH = screenH * (isTablet ? 0.88 : 0.92);

  // Intercept close: if form is dirty, show confirmation first
  const handleClose = () => {
    if (isDirty) {
      setConfirmDiscard(true);
    } else {
      onClose();
    }
  };

  // ── Web / Tablet: centred dialog ─────────────────────────────────────────
  if (isWeb || isTablet) {
    return (
      <>
        <Modal
          visible={visible}
          transparent
          animationType="fade"
          onRequestClose={handleClose}
          statusBarTranslucent
        >
          {/* Backdrop */}
          <Pressable
            onPress={handleClose}
            style={[styles.backdrop, { backgroundColor: '#00000066' }]}
          >
            {/* Dialog card — stop tap propagation */}
            <Pressable onPress={e => e.stopPropagation()}>
              <KeyboardAvoidingView
                behavior={isWeb ? undefined : 'padding'}
                style={{
                  width: Math.min(screenW - 32, 680),
                  maxHeight: maxH,
                  backgroundColor: c.base,
                  borderRadius: 24,
                  overflow: 'hidden',
                  ...shadows(c),
                }}
              >
                {/* Header */}
                <ModalHeader icon={icon} title={title} subtitle={subtitle} onClose={handleClose} c={c} />

                {/* Scrollable body */}
                <ScrollView
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ padding: 24, paddingTop: 8 }}
                  showsVerticalScrollIndicator={false}
                >
                  {children}
                </ScrollView>

                {/* Sticky footer */}
                {footer && (
                  <View style={[styles.footer, { backgroundColor: c.base, paddingBottom: 16 }]}>
                    {footer}
                  </View>
                )}
              </KeyboardAvoidingView>
            </Pressable>
          </Pressable>
        </Modal>

        {/* Unsaved changes confirmation */}
        <DiscardConfirmModal
          visible={confirmDiscard}
          onKeep={() => setConfirmDiscard(false)}
          onDiscard={() => { setConfirmDiscard(false); onClose(); }}
          c={c}
        />
      </>
    );
  }

  // ── Mobile: bottom sheet ─────────────────────────────────────────────────
  return (
    <>
      <Modal
        visible={visible}
        transparent
        animationType="slide"
        onRequestClose={handleClose}
        statusBarTranslucent
      >
        <KeyboardAvoidingView
          behavior="padding"
          style={{ flex: 1 }}
          keyboardVerticalOffset={0}
        >
          {/* Backdrop — tap to dismiss */}
          <Pressable
            onPress={handleClose}
            style={[styles.backdrop, { justifyContent: 'flex-end', backgroundColor: '#00000066' }]}
          >
            {/* Sheet — stop tap propagation */}
            <Pressable onPress={e => e.stopPropagation()}>
              <View
                style={{
                  backgroundColor: c.base,
                  borderTopLeftRadius: 28,
                  borderTopRightRadius: 28,
                  width: '100%',
                  maxHeight: maxH,
                  overflow: 'hidden',
                  ...shadows(c),
                }}
              >
                {/* Swipe handle */}
                <View style={styles.handle}>
                  <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: `${c.text}25` }} />
                </View>

                {/* Header */}
                <ModalHeader icon={icon} title={title} subtitle={subtitle} onClose={handleClose} c={c} />

                {/* Scrollable body */}
                <ScrollView
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ padding: 20, paddingTop: 4 }}
                  showsVerticalScrollIndicator={false}
                  bounces
                >
                  {children}
                  {/* Extra bottom padding so last field isn't tucked under sticky footer */}
                  {footer && <View style={{ height: 16 }} />}
                </ScrollView>

                {/* Sticky footer — respects home-indicator inset */}
                {footer && (
                  <View
                    style={[
                      styles.footer,
                      {
                        backgroundColor: c.base,
                        paddingBottom: Math.max(insets.bottom, 20),
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: `${c.text}15`,
                      },
                    ]}
                  >
                    {footer}
                  </View>
                )}
              </View>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* Unsaved changes confirmation */}
      <DiscardConfirmModal
        visible={confirmDiscard}
        onKeep={() => setConfirmDiscard(false)}
        onDiscard={() => { setConfirmDiscard(false); onClose(); }}
        c={c}
      />
    </>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ModalHeader({
  icon, title, subtitle, onClose, c,
}: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  onClose: () => void;
  c: ReturnType<typeof neuColors.light extends infer T ? () => T : never> | typeof neuColors.light;
}) {
  return (
    <View style={styles.header}>
      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 10 }}>
        {icon && <View style={{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}>{icon}</View>}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={{ fontSize: 18, fontWeight: '800', color: (c as any).text }}
            numberOfLines={1}
            adjustsFontSizeToFit
          >{title}</Text>
          {subtitle ? (
            <Text
              style={{ fontSize: 12, color: (c as any).text, opacity: 0.45, marginTop: 1 }}
              numberOfLines={1}
            >{subtitle}</Text>
          ) : null}
        </View>
      </View>
      <Pressable
        onPress={onClose}
        hitSlop={12}
        style={{
          width: 32, height: 32, borderRadius: 10,
          backgroundColor: `${(c as any).text}12`,
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <X size={16} color={(c as any).text} opacity={0.6} />
      </Pressable>
    </View>
  );
}

/** Unsaved-changes confirmation sheet */
function DiscardConfirmModal({
  visible, onKeep, onDiscard, c,
}: {
  visible: boolean;
  onKeep: () => void;
  onDiscard: () => void;
  c: typeof neuColors.light;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onKeep}>
      <Pressable
        onPress={onKeep}
        style={[styles.backdrop, { backgroundColor: '#00000080', justifyContent: 'center', alignItems: 'center' }]}
      >
        <Pressable onPress={e => e.stopPropagation()}>
          <View style={{
            backgroundColor: (c as any).base,
            borderRadius: 24,
            padding: 24,
            marginHorizontal: 20,
            maxWidth: 400,
            width: '100%',
            alignSelf: 'center',
            shadowColor: (c as any).shadowDark,
            shadowOffset: { width: 0, height: 8 },
            shadowOpacity: 0.3,
            shadowRadius: 20,
            elevation: 20,
          }}>
            <View style={{ alignItems: 'center', marginBottom: 16 }}>
              <View style={{
                width: 52, height: 52, borderRadius: 16,
                backgroundColor: '#F59E0B18',
                alignItems: 'center', justifyContent: 'center',
                marginBottom: 12,
              }}>
                <AlertTriangle size={26} color="#F59E0B" />
              </View>
              <Text style={{ fontSize: 18, fontWeight: '800', color: (c as any).text, textAlign: 'center' }}>
                Unsaved Changes
              </Text>
              <Text style={{ fontSize: 14, color: (c as any).text, opacity: 0.55, textAlign: 'center', marginTop: 6, lineHeight: 20 }}>
                You have unsaved changes.{'\n'}Leave without saving?
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <NeuButton label="Keep Editing" onPress={onKeep} variant="secondary" style={{ flex: 1, minWidth: 100 }} />
              <NeuButton label="Discard" onPress={onDiscard} variant="danger" style={{ flex: 1, minWidth: 100 }} />
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handle: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 10,
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
  },
});

function shadows(c: { shadowDark: string }) {
  return {
    shadowColor: c.shadowDark,
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.35,
    shadowRadius: 20,
    elevation: 16,
  };
}
