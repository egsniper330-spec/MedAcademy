/**
 * OfflineVideoPlayer.tsx — WEB STUB
 *
 * Offline DRM playback is a native (Android/iOS) capability of the official
 * VdoCipher SDK; there is no web offline-DRM path. This stub keeps the web
 * bundle resolvable (Metro uses the bare .tsx on web, the .native.tsx adapter
 * on Android/iOS) and renders an honest capability message instead of a
 * broken player. Web users keep streaming playback through the online
 * VdoCipher WebView player.
 */

import { Text, View } from 'react-native';
import type { OfflineVideoPlayerProps } from './OfflineVideoPlayer.types';

export function OfflineVideoPlayer(_props: OfflineVideoPlayerProps) {
  return (
    <View style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: '#0b1220', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15, marginBottom: 8 }}>Offline playback unavailable on web</Text>
      <Text style={{ color: '#ffffff99', fontSize: 13, textAlign: 'center', lineHeight: 19 }}>
        Downloaded videos play in the MedAcademy mobile app (Android & iOS) with full DRM protection.
      </Text>
    </View>
  );
}

export default OfflineVideoPlayer;
