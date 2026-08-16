/**
 * ResponsiveModal — Single reusable modal for the entire app.
 *
 * Behaviour:
 * • Phone portrait/landscape → bottom-sheet, rounded top corners, slides up.
 *   Height capped to (screenH – safeTop – handle) so it never overflows in
 *   landscape where available height is very short.
 * • Tablet / Web → centred dialog, max-width 680, respects all four insets.
 * • Keyboard-aware: KAV with platform-correct offset so the focused field is
 *   never hidden behind the software keyboard on iOS or Android.
 * • Safe-area insets respected on every device:
 *   – bottom: home-indicator / gesture bar / Android nav bar
 *   – top:    used by KAV offset on iOS; Android uses 0
 *   – left/right: applied to dialog on landscape iPad
 * • Dismiss: tap backdrop · X button · Android back-button (onRequestClose)
 * • Dirty guard: when isDirty=true shows "Unsaved changes" confirmation.
 * • RTL: all Text renders correctly; flexDirection is 'row' so mirrors on RTL.
 * • Accessibility: title up to 2 lines (no adjustsFontSizeToFit crushing text
 *   at large system font sizes).
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
  const isIOS = process.env.EXPO_OS === 'ios';
  const isTablet = screenW >= 768;

  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // ── Safe-area-aware height cap ─────────────────────────────────────────────
  // Subtract top safe area so the sheet never starts behind the Dynamic Island /
  // notch — critical in landscape where insets.top can be 50+ dp.
  // Phone: 92 % of usable height.  Tablet: 88 %.
  const usableH = screenH - insets.top;
  const maxH = usableH * (isTablet ? 0.88 : 0.92);

  // KAV offset: on iOS the KAV needs to know the height of persistent system UI
  // above the modal so it shifts up by exactly the right amount.
  // On Android KAV behavior="height" does not use keyboardVerticalOffset.
  const kavOffset = isIOS ? insets.top : 0;

  // Intercept close: if form is dirty, show confirmation first
  const handleClose = () => {
    if (isDirty) {
      setConfirmDiscard(true);
    } else {
      onClose();
    }
  };

  // ── Web / Tablet: centred dialog ───────────────────────────────────────────
  if (isWeb || isTablet) {
    // On landscape iPad the usable width excludes left+right insets (home bar area)
    const dialogW = Math.min(screenW - Math.max(32, insets.left + insets.right + 32), 680);
    return (
      <>
        <Modal
          visible={visible}
          transparent
          animationType="fade"
          onRequestClose={handleClose}
          statusBarTranslucent
        >
          <KeyboardAvoidingView
            behavior={isWeb ? undefined : (isIOS ? 'padding' : 'height')}
            keyboardVerticalOffset={kavOffset}
            style={styles.fullFlex}
          >
            {/* Backdrop — tap to dismiss */}
            <Pressable
              onPress={handleClose}
              style={[styles.backdrop, { backgroundColor: '#00000066' }]}
            >
              {/* Dialog card — stop tap propagation */}
              <Pressable onPress={e => e.stopPropagation()}>
                <View
                  style={{
                    width: dialogW,
                    maxHeight: maxH,
                    backgroundColor: c.base,
                    borderRadius: 24,
                    overflow: 'hidden',
                    ...shadowStyle(c),
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
                    <View style={[styles.footer, { backgroundColor: c.base, paddingBottom: Math.max(insets.bottom, 16) }]}>
                      {footer}
                    </View>
                  )}
                </View>
              </Pressable>
            </Pressable>
          </KeyboardAvoidingView>
        </Modal>

        <DiscardConfirmModal
          visible={confirmDiscard}
          onKeep={() => setConfirmDiscard(false)}
          onDiscard={() => { setConfirmDiscard(false); onClose(); }}
          c={c}
        />
      </>
    );
  }

  // ── Phone: bottom sheet ────────────────────────────────────────────────────
  //
  // Architecture:
  //   Modal (flex:1, statusBarTranslucent)
  //   └─ KAV (flex:1) — shifts sheet up when keyboard opens
  //      ├─ Backdrop Pressable (flex:1) — fills space ABOVE the sheet; tapping dismisses
  //      └─ Sheet Pressable wrapper (no flex) — stops backdrop tap reaching sheet
  //         └─ Sheet View (maxHeight capped, overflow:hidden)
  //
  // This structure ensures:
  //   • The backdrop is always interactable — no View blocks it.
  //   • The sheet never exceeds usable height even in landscape.
  //   • KAV shifts the WHOLE sheet up on keyboard open.
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
          behavior={isIOS ? 'padding' : 'height'}
          keyboardVerticalOffset={kavOffset}
          style={styles.fullFlex}
        >
          {/* Backdrop — flex:1 fills the remaining space above the sheet */}
          <Pressable
            onPress={handleClose}
            style={[styles.fullFlex, { backgroundColor: '#00000066' }]}
          />

          {/* Sheet — sits at bottom of KAV, does NOT use flex:1 */}
          <Pressable onPress={e => e.stopPropagation()}>
            <View
              style={{
                backgroundColor: c.base,
                borderTopLeftRadius: 28,
                borderTopRightRadius: 28,
                width: '100%',
                maxHeight: maxH,
                overflow: 'hidden',
                ...shadowStyle(c),
              }}
            >
              {/* Swipe handle */}
              <View style={styles.handle}>
                <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: `${c.text}25` }} />
              </View>

              {/* Header */}
              <ModalHeader icon={icon} title={title} subtitle={subtitle} onClose={handleClose} c={c} />

              {/* Scrollable body — flex:1 so it grows inside the capped sheet */}
              <ScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ padding: 20, paddingTop: 4 }}
                showsVerticalScrollIndicator={false}
                bounces
              >
                {children}
                {/* Extra breathing room so the last field clears the sticky footer */}
                {footer && <View style={{ height: 16 }} />}
              </ScrollView>

          {/* Sticky footer — home-indicator / gesture-nav aware */}
              {footer && (
                <View
                  style={[
                    styles.footer,
                    {
                      backgroundColor: c.base,
                      // Math.max: at minimum 20 dp breathing room; on tall iPhones it's insets.bottom (~34)
                      paddingBottom: Math.max(insets.bottom + 4, 20),
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: `${c.text}15`,
                    },
                  ]}
                >
                  {footer}
                </View>
              )}
              {/* When there is no footer, still pad for home indicator / gesture bar */}
              {!footer && insets.bottom > 0 && (
                <View style={{ height: insets.bottom }} />
              )}
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      <DiscardConfirmModal
        visible={confirmDiscard}
        onKeep={() => setConfirmDiscard(false)}
        onDiscard={() => { setConfirmDiscard(false); onClose(); }}
        c={c}
      />
    </>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ModalHeader({
  icon, title, subtitle, onClose, c,
}: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  onClose: () => void;
  c: typeof neuColors.light;
}) {
  return (
    <View style={styles.header}>
      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 10 }}>
        {icon && (
          <View style={{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {icon}
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          {/* numberOfLines={2} supports long translated titles and large system fonts */}
          <Text
            style={{ fontSize: 18, fontWeight: '800', color: (c as any).text, lineHeight: 23 }}
            numberOfLines={2}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              style={{ fontSize: 12, color: (c as any).text, opacity: 0.45, marginTop: 1, lineHeight: 17 }}
              numberOfLines={2}
            >
              {subtitle}
            </Text>
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
          flexShrink: 0,
        }}
      >
        <X size={16} color={(c as any).text} opacity={0.6} />
      </Pressable>
    </View>
  );
}

/** Unsaved-changes confirmation — centred dialog, tablet-safe */
function DiscardConfirmModal({
  visible, onKeep, onDiscard, c,
}: {
  visible: boolean;
  onKeep: () => void;
  onDiscard: () => void;
  c: typeof neuColors.light;
}) {
  const { width: screenW } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Caps to 400 dp max and ensures horizontal margins on any screen width
  const cardW = Math.min(screenW - Math.max(40, insets.left + insets.right + 40), 400);

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onKeep}>
      <Pressable
        onPress={onKeep}
        style={[
          styles.backdrop,
          {
            backgroundColor: '#00000080',
            justifyContent: 'center',
            alignItems: 'center',
            paddingHorizontal: 20,
            // Ensure card is not hidden behind home indicator / nav bar
            paddingBottom: Math.max(insets.bottom, 16),
            paddingTop: Math.max(insets.top, 16),
          },
        ]}
      >
        <Pressable onPress={e => e.stopPropagation()}>
          <View style={{
            backgroundColor: (c as any).base,
            borderRadius: 24,
            padding: 24,
            width: cardW,
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
              <NeuButton label="Keep Editing" onPress={onKeep} variant="secondary" style={{ flex: 1, minWidth: 0 }} />
              <NeuButton label="Discard" onPress={onDiscard} variant="danger" style={{ flex: 1, minWidth: 0 }} />
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Styles & helpers ───────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  fullFlex: {
    flex: 1,
  },
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

function shadowStyle(c: { shadowDark: string }) {
  return {
    shadowColor: c.shadowDark,
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.35,
    shadowRadius: 20,
    elevation: 16,
  };
}
