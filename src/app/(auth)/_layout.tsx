import { Stack } from 'expo-router';

import { UpdateAuthGate } from '@/components/UpdateAuthGate';

/**
 * (auth) layout — every authentication screen sits behind the update
 * checkpoint (UpdateAuthGate), which blocks ONLY a confirmed mandatory update
 * and never waits for the background version check to render.
 */
export default function AuthLayout() {
  return (
    <UpdateAuthGate>
      <Stack screenOptions={{ headerShown: false }} />
    </UpdateAuthGate>
  );
}
