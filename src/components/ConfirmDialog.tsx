import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { PortalOverlay } from '@/components/PortalOverlay';
import { neuColors } from '@/lib/neu';

/**
 * ConfirmDialog — the ONE cross-platform destructive-action confirmation.
 *
 * Why this exists: react-native-web implements Alert.alert as a silent no-op,
 * so any mutation gated behind Alert.alert(..., [{ onPress }]) NEVER runs on
 * web — the button looks frozen with zero feedback. This dialog renders the
 * same confirm/cancel contract on every platform via the app's portal overlay.
 *
 * Screen contract:
 *   setConfirm({ title, message, confirmLabel?, destructive?, onConfirm })
 *   …render <ConfirmDialog visible={!!confirm} request={confirm && { ...confirm, loading: busy }} … />
 *   The onConfirm callback performs the mutation and closes the dialog itself
 *   (setConfirm(null)) on both success and failure; `loading` locks dismissal
 *   while the request is in flight so the user cannot double-submit.
 */
export interface ConfirmDialogRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm styling for destructive actions (archive/delete). */
  destructive?: boolean;
  /** While true: both buttons disabled, spinner in the confirm button, no backdrop/back dismissal. */
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  visible,
  request,
  onClose,
}: {
  visible: boolean;
  request: ConfirmDialogRequest | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const busy = !!request?.loading;
  const [pendingConfirm, setPendingConfirm] = useState(false);

  // Escape closes on web only (never while a mutation is in flight).
  // GUARD: `window.addEventListener` does not exist in the React Native JS
  // runtime — attaching unconditionally would crash the app on native the
  // moment a confirm dialog opens.
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible || busy) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, busy, onClose]);

  if (!visible || !request) return null;

  const locked = busy || pendingConfirm;
  const handleConfirm = async (): Promise<void> => {
    if (locked) return;
    setPendingConfirm(true);
    try {
      await request.onConfirm();
    } finally {
      setPendingConfirm(false);
    }
  };

  return (
    <PortalOverlay
      visible={visible}
      variant="dialog"
      backdropColor="rgba(0,0,0,0.55)"
      onRequestClose={locked ? undefined : onClose}
    >
      <View
        accessibilityLabel={request.title}
        style={[
          styles.card,
          { backgroundColor: c.base, borderColor: `${c.text}22` },
        ]}
      >
        <Text style={[styles.title, { color: c.text }]}>{request.title}</Text>
        <Text style={[styles.message, { color: `${c.text}CC` }]}>{request.message}</Text>
        <View style={styles.row}>
          <Pressable
            onPress={onClose}
            disabled={locked}
            accessibilityRole="button"
            accessibilityLabel={request.cancelLabel ?? 'Cancel'}
            style={({ pressed }) => [
              styles.btn,
              styles.cancelBtn,
              { borderColor: `${c.text}33`, opacity: locked ? 0.5 : pressed ? 0.7 : 1 },
            ]}
          >
            <Text style={{ color: c.text, fontWeight: '700', fontSize: 13 }}>
              {request.cancelLabel ?? 'Cancel'}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void handleConfirm()}
            disabled={locked}
            accessibilityRole="button"
            accessibilityLabel={request.confirmLabel ?? 'Confirm'}
            style={({ pressed }) => [
              styles.btn,
              {
                backgroundColor: request.destructive ? '#EF4444' : c.primary,
                opacity: locked ? 0.7 : pressed ? 0.85 : 1,
              },
            ]}
          >
            {locked ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>
                {request.confirmLabel ?? 'Confirm'}
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    </PortalOverlay>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '88%',
    maxWidth: 420,
    borderRadius: 16,
    borderWidth: 1,
    padding: 18,
    gap: 10,
  },
  title: {
    fontSize: 16,
    fontWeight: '800',
  },
  message: {
    fontSize: 13,
    lineHeight: 19,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  btn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  cancelBtn: {
    borderWidth: 1.5,
  },
});
