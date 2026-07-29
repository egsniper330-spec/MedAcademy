/**
 * LargeFileWarning.tsx
 * Pre-upload modal that shows file size analysis, estimated upload time,
 * and recommended connection. Doctor can proceed or cancel.
 */

import { Modal, Pressable, Text, useColorScheme, View } from 'react-native';
import { AlertTriangle, Wifi, Clock, HardDrive, X } from 'lucide-react-native';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors, neuFlatStyle, neuPressedStyle } from '@/lib/neu';
import { type FileAnalysis } from '@/lib/videoUploadEngine';

interface Props {
  visible: boolean;
  analysis: FileAnalysis | null;
  fileName: string;
  onProceed: () => void;
  onCancel: () => void;
}

function StatRow({ icon: Icon, label, value, color, isDark }: {
  icon: any; label: string; value: string; color: string; isDark: boolean;
}) {
  const c = isDark ? neuColors.dark : neuColors.light;
  return (
    <View style={[neuFlatStyle(isDark), { borderRadius: 10, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
      <View style={{ width: 32, height: 32, borderRadius: 9, backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={15} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, fontWeight: '600' }}>{label}</Text>
        <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{value}</Text>
      </View>
    </View>
  );
}

export function LargeFileWarning({ visible, analysis, fileName, onProceed, onCancel }: Props) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  if (!analysis) return null;

  const warningColor = analysis.isVeryLarge ? '#DC2626' : '#D97706';

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
        <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 20, padding: 20, width: '100%', maxWidth: 400, gap: 14 }]}>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
            <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: `${warningColor}18`, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <AlertTriangle size={22} color={warningColor} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '800', color: c.text }}>
                {analysis.isVeryLarge ? 'Very Large File' : 'Large File Detected'}
              </Text>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 2 }} numberOfLines={2}>
                {fileName}
              </Text>
            </View>
            <Pressable onPress={onCancel} hitSlop={8}>
              <X size={18} color={`${c.text}60`} />
            </Pressable>
          </View>

          {/* Warning message */}
          {analysis.warningMessage && (
            <View style={{ backgroundColor: `${warningColor}12`, borderRadius: 10, padding: 10, borderLeftWidth: 3, borderLeftColor: warningColor }}>
              <Text style={{ fontSize: 13, color: warningColor, lineHeight: 18 }}>{analysis.warningMessage}</Text>
            </View>
          )}

          {/* Stats */}
          <View style={{ gap: 8 }}>
            <StatRow icon={HardDrive} label="File Size"            value={analysis.formattedSize}             color={c.primary} isDark={isDark} />
            <StatRow icon={Wifi}       label="Recommended Connection" value={analysis.recommendedConnection}   color="#2563EB"   isDark={isDark} />
            <StatRow icon={Clock}      label="Estimated Upload Time"
              value={`Slow: ~${analysis.estimatedMinutes.slow}m · Wi-Fi: ~${analysis.estimatedMinutes.medium}m · Fast: ~${analysis.estimatedMinutes.fast}m`}
              color="#7C3AED" isDark={isDark} />
          </View>

          <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, lineHeight: 17 }}>
            Keep the app open during upload. The upload continues in the background queue.
          </Text>

          {/* Actions */}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pressable onPress={onCancel}
              style={[neuFlatStyle(isDark), { flex: 1, padding: 13, borderRadius: 12, alignItems: 'center' }]}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, opacity: 0.6 }}>Cancel</Text>
            </Pressable>
            <Pressable onPress={onProceed}
              style={[neuPressedStyle(isDark), { flex: 2, padding: 13, borderRadius: 12, alignItems: 'center', backgroundColor: c.primary }]}>
              <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff' }}>Upload Anyway</Text>
            </Pressable>
          </View>
        </NeuCard>
      </View>
    </Modal>
  );
}
