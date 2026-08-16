/**
 * Admin Settings — placeholder screen registered in admin drawer.
 */
import { View, Text, ScrollView, useColorScheme } from 'react-native';
import { PageHeader } from '@/components/PageHeader';
import { Settings } from 'lucide-react-native';
import { neuColors, useLayout } from '@/lib/neu';

export default function AdminSettingsScreen() {
  const c = (useColorScheme() === 'dark' ? neuColors.dark : neuColors.light);
  const layout = useLayout();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }}
          contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}>
      <View style={{ padding: layout.screenPx }}>
        <PageHeader title="Settings" subtitle="Admin configuration" />
        <Text style={{ color: c.text, opacity: 0.4, textAlign: 'center', marginTop: 60 }}>
          Settings panel coming soon
        </Text>
      </View>
    </ScrollView>
  );
}
