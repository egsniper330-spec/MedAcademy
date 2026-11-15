import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { getInstallationId, storeDeviceFingerprint } from '@/lib/installationId';
import { registerDevice } from '@/lib/api';
import { t } from '@/lib/i18n';

// Hardware-derived fingerprint (metadata only — not for enforcement).
export function buildDeviceFingerprint(): string {
  const parts = [
    Device.modelId ?? Device.modelName ?? '',
    Device.osInternalBuildId ?? '',
    Device.osBuildId ?? '',
    Constants.sessionId ?? '',
  ].filter(Boolean);
  let h = 0;
  const str = parts.join('::');
  for (let i = 0; i < str.length; i++) { h = (Math.imul(31, h) + str.charCodeAt(i)) | 0; }
  return 'fp_' + Math.abs(h).toString(36) + '_' + (str.length).toString(36);
}

export async function buildDeviceMeta() {
  const installationId = await getInstallationId();
  return {
    installation_id:   installationId,
    device_fingerprint: buildDeviceFingerprint(),
    device_name:       [Device.modelName, Device.osName].filter(Boolean).join(' ') || t('auth.unknownDevice'),
    platform:          process.env.EXPO_OS ?? 'unknown',
    device_model:      Device.modelName    ?? undefined,
    os:                Device.osName       ?? undefined,
    os_version:        Device.osVersion    ?? undefined,
    app_version:       Constants.expoConfig?.version ?? undefined,
    manufacturer:      Device.manufacturer ?? undefined,
  };
}

/**
 * Register or refresh the current device for the signed-in account. Called on
 * every authenticated session start (sign-in and restored sessions) so that
 * device rows and last-active data stay current. The backend dedupes by
 * installation_id / fingerprint, so repeated calls never create duplicates.
 */
export async function registerCurrentDevice(meta?: Awaited<ReturnType<typeof buildDeviceMeta>>) {
  const m = meta ?? (await buildDeviceMeta());
  const result = await registerDevice({
    fingerprint:     m.device_fingerprint,
    installation_id: m.installation_id,
    device_name:     m.device_name,
    platform:        m.platform,
    device_model:    m.device_model,
    os:              m.os,
    os_version:      m.os_version,
    app_version:     m.app_version,
    manufacturer:    m.manufacturer,
  });
  if (!result?.error) {
    await storeDeviceFingerprint(m.device_fingerprint);
  }
  return { meta: m, result };
}
