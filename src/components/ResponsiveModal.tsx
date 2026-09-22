/**
 * ResponsiveModal — Single reusable modal for the entire app.
 *
 * PRESENTATION ARCHITECTURE (read before modifying):
 * ─────────────────────────────────────────────────────────────────────────
 * ONE presentation on EVERY platform — a centred responsive dialog card.
 * There is deliberately NO phone "bottom sheet" branch any more: physical
 * Android devices showed the sheet variant as cramped, small-text, and
 * geometrically unstable (dead bands, footer hugging the nav bar), while
 * web/tablet showed a centred card. Per the product decision, phones now
 * render the SAME centred card as web/tablet — one geometry, one code path,
 * no divergence between Preview and device.
 *
 * Overlay content is presented through the app's SINGLE main window via
 * <PortalOverlay> (@rn-primitives/portal → root PortalHost). It must NOT be
 * switched back to React Native's <Modal>: RN's Android Modal renders every
 * open/close cycle as a native dialog WINDOW, and on RN 0.83 + New
 * Architecture + edge-to-edge the window show/dismiss race produces
 * duplicated, stacked, flickering windows.
 *
 * Geometry (single owner per concern — no double padding anywhere):
 * • WIDTH   : min(screenW × 0.92, 680) — 8% total side margins on phones,
 *             capped for tablets/desktop. Purely screen-relative: no device
 *             classes, no magic per-model numbers.
 * • HEIGHT  : maxH = screenH − insets.top − insets.bottom − kbInset − 16.
 *             The ONLY owner of safe-area + keyboard clearance is this cap
 *             plus the centering wrapper's identical padding. The card can
 *             never extend behind the status bar, nav bar, or keyboard.
 * • CENTER  : wrapper (flex:1) pads top/bottom by the same insets+kb and
 *             centres the card. Short modals hug their content; long modals
 *             are capped at maxH and scroll internally with the footer pinned.
 * • KEYBOARD: computed inset (keyboardDidShow/DidHide − window shrink) on
 *             iOS AND Android — correct under every soft-input mode
 *             (adjustResize: window shrinks → inset ≈ 0; adjustPan/Nothing:
 *             window unchanged → inset = keyboard height). Web: no listeners.
 * • BODY    : ScrollView flexGrow:0 + flexShrink:1 — hugs short content
 *             unconditionally (no RN-default flexGrow:1 blank band), scrolls
 *             only when content exceeds the cap.
 * • TYPE    : header uses the app's fluid tokens (layout.headingSize /
 *             captionSize); body padding uses layout.pad.lg — scales with
 *             device size and respects the OS font scale via clampFont.
 *
 * Behaviour: dismiss via backdrop tap · X button · Android back button.
 * Dirty guard: isDirty=true shows an "Unsaved changes" confirmation first.
 * RTL + accessibility: title/subtitle wrap to 2 lines.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Keyboard,
  useWindowDimensions,
  useColorScheme,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, AlertTriangle } from 'lucide-react-native';
import { neuColors, useLayout } from '@/lib/neu';
import { NeuButton } from '@/components/NeuButton';
import { PortalOverlay } from '@/components/PortalOverlay';

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
  // Fluid layout/typography tokens: paddings and type inside the dialog come
  // from the app's single responsive token source so they scale with device
  // size (and OS font scale) instead of fixed pixel constants.
  const layout = useLayout();

  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // ── Computed keyboard inset (iOS + Android; web has no soft keyboard) ─────
  //   inset = keyboardHeight − (window height already lost to the keyboard)
  // Correct under EVERY soft-input mode without device-specific values:
  // adjustResize (window shrinks by kb → inset ≈ 0, no double-shift),
  // adjustPan/adjustNothing (window unchanged → inset = full kb height).
  // The inset is applied in exactly ONE place each for the height cap and the
  // centering padding — never both cumulatively (single-owner rule).
  const isWeb = process.env.EXPO_OS === 'web';
  const [kbInset, setKbInset] = useState(0);
  const winHRef = useRef(screenH);
  winHRef.current = screenH;
  const baseWinHRef = useRef<number | null>(null);
  useEffect(() => {
    if (isWeb) return;
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      if (baseWinHRef.current == null) baseWinHRef.current = winHRef.current;
      const shrank = Math.max(0, baseWinHRef.current - winHRef.current);
      setKbInset(Math.max(0, e.endCoordinates.height - shrank));
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      baseWinHRef.current = null;
      setKbInset(0);
    });
    return () => { show.remove(); hide.remove(); };
  }, [isWeb]);

  // Intercept close: if form is dirty, show confirmation first
  const handleClose = () => {
    if (isDirty) {
      setConfirmDiscard(true);
    } else {
      onClose();
    }
  };

  // ── Geometry (all platforms) ──────────────────────────────────────────────
  // Width: 92 % of the viewport (8 % total side margins), capped at 680 for
  // tablets/desktop. Screen-relative — identical behaviour from small phones
  // to desktop, no device-class branching.
  const dialogW = Math.min(screenW * 0.92, 680);
  // Height cap: the ONLY owner of status-bar / nav-bar / keyboard clearance.
  // The centering wrapper below pads by exactly the same amounts, so the card
  // fits the padded area with ≥8dp breathing on every edge.
  const vertBreathing = 8;
  const maxH = Math.max(
    200,
    screenH - insets.top - insets.bottom - kbInset - vertBreathing * 2,
  );

  return (
    <>
      <PortalOverlay visible={visible} onRequestClose={handleClose} variant="dialog">
        {/* Centering host — single owner of safe-area + keyboard clearance.
            flex:1 fills the portal layer; the card centres inside the padded
            content box and can never overlap system UI or the keyboard. */}
        <View
          style={[
            styles.host,
            {
              paddingTop: insets.top + vertBreathing,
              paddingBottom: insets.bottom + vertBreathing + kbInset,
            },
          ]}
          pointerEvents="box-none"
        >
          <Pressable onPress={e => e.stopPropagation()} style={{ width: dialogW, maxHeight: maxH }}>
            <View
              style={{
                width: '100%',
                maxHeight: '100%',
                backgroundColor: c.base,
                borderRadius: 24,
                overflow: 'hidden',
                ...shadowStyle(c),
              }}
            >
              {/* Header */}
              <ModalHeader icon={icon} title={title} subtitle={subtitle} onClose={handleClose} c={c} />

              {/* Scrollable body — flexGrow:0 is the content-sizing guarantee:
                  RN's ScrollView defaults to flexGrow:1 on its outer container,
                  so any spare space the Android layout pass leaves becomes a
                  blank band between the body and the footer. flexGrow:0 makes
                  the card hug its content unconditionally; flexShrink:1 lets
                  this exact view scroll when a long form exceeds maxH — short
                  dialogs stay compact, long dialogs scroll with the footer
                  pinned. */}
              <ScrollView
                keyboardShouldPersistTaps="handled"
                style={{ flexGrow: 0, flexShrink: 1 }}
                contentContainerStyle={{
                  padding: layout.pad.lg,
                  paddingTop: 8,
                  paddingBottom: 16,
                }}
                showsVerticalScrollIndicator={false}
                bounces
              >
                {children}
              </ScrollView>

              {/* Sticky footer — inside the card; clearance is owned by the
                  host padding above, so the footer never hugs the nav bar. */}
              {footer && (
                <View
                  style={[
                    styles.footer,
                    {
                      backgroundColor: c.base,
                      paddingTop: 12,
                      paddingHorizontal: layout.pad.lg,
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
        </View>
      </PortalOverlay>

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
  // Fluid typography tokens: scale with device size + OS font scale
  // (clampFont over typography.h3 / typography.caption).
  const layout = useLayout();
  return (
    <View style={[styles.header, { paddingHorizontal: layout.pad.lg }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 10 }}>
        {icon && (
          <View style={{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {icon}
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          {/* numberOfLines={2} supports long translated titles and large system font sizes */}
          <Text
            style={{ fontSize: layout.headingSize, fontWeight: '800', color: (c as any).text, lineHeight: Math.round(layout.headingSize * 1.28) }}
            numberOfLines={2}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              style={{ fontSize: layout.captionSize + 1, color: (c as any).text, opacity: 0.55, marginTop: 2, lineHeight: Math.round((layout.captionSize + 1) * 1.4) }}
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

/** Unsaved-changes confirmation — centred dialog.
 *  Also portal-based: renders in the same window, stacked ABOVE the dialog
 *  (later portal registration renders later in the shared PortalHost). */
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
  const layout = useLayout();
  // Same width rule as the main dialog: 92 % viewport, capped.
  const cardW = Math.min(screenW * 0.92, 400);

  return (
    <PortalOverlay visible={visible} onRequestClose={onKeep} variant="dialog" backdropColor="#00000080">
      <View
        style={[styles.host, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }]}
        pointerEvents="box-none"
      >
        <Pressable onPress={e => e.stopPropagation()} style={{ width: cardW }}>
          <View style={{
            backgroundColor: (c as any).base,
            borderRadius: 24,
            padding: 24,
            width: '100%',
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
              <Text style={{ fontSize: layout.headingSize, fontWeight: '800', color: (c as any).text, textAlign: 'center' }}>
                Unsaved Changes
              </Text>
              <Text style={{ fontSize: layout.bodySize, color: (c as any).text, opacity: 0.55, textAlign: 'center', marginTop: 6, lineHeight: Math.round(layout.bodySize * 1.5) }}>
                You have unsaved changes.{'\n'}Leave without saving?
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <NeuButton label="Keep Editing" onPress={onKeep} variant="secondary" style={{ flex: 1, minWidth: 0 }} />
              <NeuButton label="Discard" onPress={onDiscard} variant="danger" style={{ flex: 1, minWidth: 0 }} />
            </View>
          </View>
        </Pressable>
      </View>
    </PortalOverlay>
  );
}

// ── Styles & helpers ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Centering host: fills the portal layer, centres its child. Safe-area and
  // keyboard padding are supplied inline by the caller (single owner).
  host: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
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
    paddingBottom: 12,
  },
});

function shadowStyle(c: { shadowDark: string }) {
  return {
    shadowColor: c.shadowDark,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 20,
    elevation: 16,
  };
}
