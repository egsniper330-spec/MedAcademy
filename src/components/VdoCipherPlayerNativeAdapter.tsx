/**
 * VdoCipherPlayerNativeAdapter.tsx
 *
 * Web stub — this file is resolved by Metro on the Web platform only.
 * Metro prefers .native.tsx over .tsx on Android/iOS, so this file
 * is never bundled for native targets.
 *
 * The native SDK (vdocipher-rn-bridge) requires NativeModules which are
 * not available in a browser environment. Rendering on web is handled by
 * VdoCipherPlayerWebView (iframe + Reanimated overlay) inside
 * VdoCipherPlayer.tsx, which guards the platform branch before this
 * component could ever be reached on web.
 *
 * This stub exists solely to prevent Metro from throwing a missing-module
 * error when bundling for web, since Metro resolves all imports statically.
 */

import { View } from 'react-native';
import type { VdoCipherPlayerProps } from '@/components/VdoCipherPlayer';

/**
 * No-op stub — never called on web because VdoCipherPlayer.tsx always
 * routes web traffic to VdoCipherPlayerWebView before reaching this.
 */
export function VdoCipherPlayerNativeAdapter(_props: VdoCipherPlayerProps) {
  return <View />;
}
