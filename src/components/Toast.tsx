/**
 * Toast — Global, auto-dismiss notification system.
 *
 * Usage:
 *   const { showToast } = useToast();
 *   showToast({ type: 'success', message: 'User created successfully.' });
 *   showToast({ type: 'error',   message: 'Email already exists.' });
 *   showToast({ type: 'info',    message: 'Saving...' });
 *
 * Setup: Wrap root layout with <ToastProvider />.
 *   The <ToastContainer /> is rendered inside the provider above everything.
 */

import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import {
  Animated, View, Text, useColorScheme, StyleSheet, Pressable,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CheckCircle, XCircle, Info, X } from 'lucide-react-native';
import { neuColors } from '@/lib/neu';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToastType = 'success' | 'error' | 'info';

export interface ToastOptions {
  type: ToastType;
  message: string;
  /** Duration in ms. Default: 3000 */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: string;
  opacity: Animated.Value;
  translateY: Animated.Value;
}

interface ToastContextValue {
  showToast: (opts: ToastOptions) => void;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue>({
  showToast: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counterRef = useRef(0);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const dismissToast = useCallback((toast: ToastItem) => {
    Animated.parallel([
      Animated.timing(toast.opacity, { toValue: 0, duration: 250, useNativeDriver: true }),
      Animated.timing(toast.translateY, { toValue: -20, duration: 250, useNativeDriver: true }),
    ]).start(() => removeToast(toast.id));
  }, [removeToast]);

  const showToast = useCallback((opts: ToastOptions) => {
    const id = String(++counterRef.current);
    const opacity = new Animated.Value(0);
    const translateY = new Animated.Value(-20);

    const item: ToastItem = { ...opts, id, opacity, translateY };

    setToasts(prev => [...prev.slice(-2), item]); // max 3 visible

    // Animate in
    Animated.parallel([
      Animated.spring(opacity, { toValue: 1, useNativeDriver: true, damping: 18, stiffness: 180 }),
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true, damping: 18, stiffness: 180 }),
    ]).start();

    // Auto-dismiss
    setTimeout(() => dismissToast(item), opts.duration ?? 3000);
  }, [dismissToast]);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

// ─── Container ────────────────────────────────────────────────────────────────

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (t: ToastItem) => void;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  if (toasts.length === 0) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.container, { top: insets.top + 12, left: 16, right: 16 }]}
    >
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </View>
  );
}

// ─── Single Toast ─────────────────────────────────────────────────────────────

function ToastItem({ toast, onDismiss }: { toast: ToastItem; onDismiss: (t: ToastItem) => void }) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const config = TOAST_CONFIG[toast.type];

  return (
    <Animated.View
      style={[
        styles.toast,
        {
          backgroundColor: c.base,
          borderLeftWidth: 4,
          borderLeftColor: config.accent,
          opacity: toast.opacity,
          transform: [{ translateY: toast.translateY }],
          shadowColor: c.shadowDark,
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.2,
          shadowRadius: 12,
          elevation: 10,
        },
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
        <config.Icon size={20} color={config.accent} />
        <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: c.text, lineHeight: 20 }}>
          {toast.message}
        </Text>
      </View>
      <Pressable onPress={() => onDismiss(toast)} hitSlop={8} style={{ marginLeft: 8 }}>
        <X size={16} color={c.text} opacity={0.45} />
      </Pressable>
    </Animated.View>
  );
}

// ─── Config ───────────────────────────────────────────────────────────────────

const TOAST_CONFIG: Record<ToastType, { accent: string; Icon: typeof CheckCircle }> = {
  success: { accent: '#16A34A', Icon: CheckCircle },
  error:   { accent: '#DC2626', Icon: XCircle },
  info:    { accent: '#2563EB', Icon: Info },
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    zIndex: 9999,
    gap: 8,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
});
