/**
 * ConnectivityPill — the app-wide Online/Offline indicator.
 *
 * Shared by the Offline Library, Course Offline Details, and any header that
 * needs connection state. Reactive via useConnectivity() (NetInfo) — flips
 * automatically without restart or navigation. Colors from the design
 * system; never hardcoded to ONLINE or OFFLINE.
 *
 * PARITY: identical on Android + iOS (shared RN surface).
 */
import { Text, View } from 'react-native';
import { Wifi, WifiOff } from 'lucide-react-native';
import { useColorScheme } from 'react-native';
import { neuColors } from '@/lib/neu';

export function ConnectivityPill({ online }: { online: boolean | null }) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = isDark ? neuColors.dark : neuColors.light;
  const isOnline = online === true;
  const isOffline = online === false;
  const bg = isOffline ? '#FFB02022' : isOnline ? '#22C55E1F' : isDark ? 'rgba(255,255,255,0.06)' : 'rgba(8,26,53,0.06)';
  const fg = isOffline ? '#FFB020' : isOnline ? '#22C55E' : colors.text;
  const label = isOffline ? 'OFFLINE' : isOnline ? 'ONLINE' : '…';
  return (
    <View
      accessibilityLabel={`Connection status: ${isOffline ? 'Offline' : isOnline ? 'Online' : 'Checking'}`}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 5,
        paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: bg,
      }}
    >
      {isOffline
        ? <WifiOff size={12} color={fg} />
        : <Wifi size={12} color={fg} style={{ opacity: isOnline ? 1 : 0.4 }} />}
      <Text style={{ color: fg, fontSize: 11, fontWeight: '800', letterSpacing: 0.4 }}>{label}</Text>
    </View>
  );
}

export default ConnectivityPill;
