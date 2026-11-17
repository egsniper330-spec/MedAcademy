/**
 * AppModal — React Native's `<Modal>` plus own-dialog bookkeeping.
 *
 * Drop-in replacement: every prop is forwarded unchanged. The only difference
 * is that a visible AppModal registers itself in `src/lib/ownDialogs.ts`, so the
 * floating-window guard can tell "one of OUR dialogs has window focus" apart
 * from "another app's floating window has window focus".
 *
 * Use this instead of `Modal` from 'react-native' anywhere a dialog can stay
 * open while security checks run.
 */
import React, { useEffect } from 'react';
import { Modal, type ModalProps } from 'react-native';
import { registerOwnDialog } from '@/lib/ownDialogs';

export function AppModal({ visible, ...rest }: ModalProps) {
  const isOpen = visible !== false;

  useEffect(() => {
    if (!isOpen) return;
    return registerOwnDialog();
  }, [isOpen]);

  return <Modal visible={visible} {...rest} />;
}

export default AppModal;
