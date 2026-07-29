/**
 * Admin Settings — placeholder screen registered in admin drawer.
 */
import { View, Text, ScrollView, useColorScheme } from 'react-native';
import { PageHeader } from '@/components/PageHeader';
import { Settings } from 'lucide-react-native';
import { neuColors } from '@/lib/neu';

export default function AdminSettingsScreen() {
  const c = (useColorScheme() === 'dark' ? neuColors.dark : neuColors.light);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }} contentInsetAdjustmentBehavior="automatic">
      <View style={{ padding: 20 }}>
        <PageHeader title="Settings" subtitle="Admin configuration" />
        <Text style={{ color: c.text, opacity: 0.4, textAlign: 'center', marginTop: 60 }}>
          Settings panel coming soon
        </Text>
      </View>
    </ScrollView>
  );
}
