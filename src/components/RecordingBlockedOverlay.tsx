/**
 * RecordingBlockedOverlay
 *
 * Full-screen Modal shown on iOS when screen recording is detected.
 * Hides the video player and displays "Screen recording is not allowed."
 * Rendered as a Modal so it covers the entire screen regardless of parent layout.
 */
import React from 'react';
import { View, Text, Modal } from 'react-native';
import { VideoOff } from 'lucide-react-native';

export function RecordingBlockedOverlay() {
  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', gap: 20, paddingHorizontal: 32 }}>
        <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: 'rgba(239,68,68,0.15)', alignItems: 'center', justifyContent: 'center' }}>
          <VideoOff size={40} color="#EF4444" />
        </View>

        <Text style={{ fontSize: 20, fontWeight: '800', color: '#fff', textAlign: 'center' }}>
          Screen Recording Detected
        </Text>

        <Text style={{ fontSize: 14, color: 'rgba(255,255,255,0.7)', textAlign: 'center', lineHeight: 22 }}>
          Screen recording is not allowed.{'\n'}
          Please stop the recording to continue watching.
        </Text>
      </View>
    </Modal>
  );
}
