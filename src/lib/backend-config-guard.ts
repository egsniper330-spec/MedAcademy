/**
 * Backend configuration guard.
 *
 * The PHP API is the sole application backend. This validator runs during app
 * startup so a missing or malformed API base fails clearly instead of silently
 * selecting another provider.
 */

function configuredApiUrl(): string {
  return process.env.EXPO_PUBLIC_PHP_API_URL?.trim() ?? '';
}

export function assertBackendConfigured(): void {
  const value = configuredApiUrl();
  if (!value) {
    throw new Error(
      '[BackendConfig] EXPO_PUBLIC_PHP_API_URL is required. ' +
      'Set it to https://api.medacademy.eu.cc/backend/public/index.php.'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`[BackendConfig] EXPO_PUBLIC_PHP_API_URL is not a valid URL: ${value}`);
  }

  const isLocalHttp = __DEV__ && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (parsed.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('[BackendConfig] EXPO_PUBLIC_PHP_API_URL must use HTTPS outside local development.');
  }
}
