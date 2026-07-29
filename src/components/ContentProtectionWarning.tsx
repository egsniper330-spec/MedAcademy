/**
 * ContentProtectionWarning
 *
 * Modal shown on iOS when a screenshot is detected.
 * Displays the configurable warning message, current strike count,
 * and an Acknowledge button to resume the lesson.
 */
import React from 'react';
import { View, Text, Modal, Pressable, useColorScheme } from 'react-native';
import { AlertTriangle, ShieldX } from 'lucide-react-native';
import { neuColors, neuFlatStyle } from '@/lib/neu';

interface Props {
  visible: boolean;
  warningMessage: string;
  strikeCount: number;
  onAcknowledge: () => void;
}

export function ContentProtectionWarning({ visible, warningMessage, strikeCount, onAcknowledge }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, backgroundColor: 'rgba(0,0,0,0.75)' }}>
        <View style={[flat, { borderRadius: 24, padding: 24, gap: 16, width: '100%', maxWidth: 400 }]}>
          {/* Icon */}
          <View style={{ alignItems: 'center' }}>
            <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#FEF3C7', alignItems: 'center', justifyContent: 'center' }}>
              <AlertTriangle size={32} color="#D97706" />
            </View>
          </View>

          {/* Title */}
          <Text style={{ fontSize: 18, fontWeight: '800', color: c.text, textAlign: 'center' }}>
            Content Protection
          </Text>

          {/* Warning message */}
          <Text style={{ fontSize: 13, color: c.text, opacity: 0.65, textAlign: 'center', lineHeight: 20 }}>
            {warningMessage}
          </Text>

          {/* Strike badge */}
          {strikeCount > 0 && (
            <View style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
              paddingVertical: 8, paddingHorizontal: 16, borderRadius: 12,
              backgroundColor: strikeCount >= 2 ? '#FEE2E2' : '#FEF3C7',
            }}>
              <ShieldX size={16} color={strikeCount >= 2 ? '#DC2626' : '#D97706'} />
              <Text style={{ fontSize: 13, fontWeight: '700', color: strikeCount >= 2 ? '#DC2626' : '#D97706' }}>
                Strike {strikeCount} of 3
              </Text>
            </View>
          )}

          {/* Remaining hint */}
          {strikeCount < 3 && (
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, textAlign: 'center' }}>
              {3 - strikeCount} violation{3 - strikeCount !== 1 ? 's' : ''} remaining before account suspension.
            </Text>
          )}

          {/* Acknowledge */}
          <Pressable
            onPress={onAcknowledge}
            style={{ backgroundColor: c.primary, paddingVertical: 14, borderRadius: 14, alignItems: 'center' }}
          >
            <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>I Understand</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
