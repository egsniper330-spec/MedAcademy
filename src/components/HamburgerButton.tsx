import { Pressable, useColorScheme } from 'react-native';
import { Menu } from 'lucide-react-native';
import { neuColors } from '@/lib/neu';
import { useDrawer } from './DrawerContext';

interface Props {
  color?: string;
}

export default function HamburgerButton({ color }: Props) {
  const { openDrawer } = useDrawer();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const iconColor = color ?? c.text;

  return (
    <Pressable
      onPress={openDrawer}
      accessibilityLabel="Open navigation menu"
      accessibilityRole="button"
      style={{
        width: 44, height: 44, borderRadius: 14,
        backgroundColor: c.base,
        alignItems: 'center', justifyContent: 'center',
        shadowColor: c.shadowDark,
        shadowOffset: { width: 3, height: 3 },
        shadowOpacity: 0.55,
        shadowRadius: 7,
      }}
    >
      <Menu size={20} color={iconColor} />
    </Pressable>
  );
}
