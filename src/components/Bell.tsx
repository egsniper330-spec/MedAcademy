/**
 * Bell — notification bell button used in screen headers.
 * Navigates to /(app)/notifications on press.
 */
import { Pressable, useColorScheme } from 'react-native';
import { useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import { Bell as BellIcon } from 'lucide-react-native';
import { neuColors } from '@/lib/neu';

export default function Bell() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();

  return (
    <Pressable
      onPress={() => router.push('/(app)/notifications' as RelativePathString)}
      style={{
        width: 44, height: 44, borderRadius: 14,
        backgroundColor: c.base,
        alignItems: 'center', justifyContent: 'center',
        shadowColor: c.shadowDark,
        shadowOffset: { width: 2, height: 2 },
        shadowOpacity: 0.6,
        shadowRadius: 6,
      }}
    >
      <BellIcon size={20} color={c.primary} />
    </Pressable>
  );
}
