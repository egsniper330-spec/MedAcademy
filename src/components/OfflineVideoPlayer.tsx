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
import { t } from '@/lib/i18n';
import type { OfflineVideoPlayerProps } from './OfflineVideoPlayer.types';

export function OfflineVideoPlayer(_props: OfflineVideoPlayerProps) {
  return (
    <View style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: '#0b1220', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15, marginBottom: 8 }}>{t('offline.webUnavailable')}</Text>
      <Text style={{ color: '#ffffff99', fontSize: 13, textAlign: 'center', lineHeight: 19 }}>
        {t('offline.webHint')}
      </Text>
    </View>
  );
}

export default OfflineVideoPlayer;
