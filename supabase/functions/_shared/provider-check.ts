/**
 * provider-check.ts — shared helper for video provider permission validation.
 *
 * FinalPermission = global.is_globally_enabled AND teacher.is_enabled (default true if absent)
 * Returns 403 JSON response when provider is disabled; null when allowed.
 */
import { createServiceClient, json } from './auth.ts';

/**
 * Returns a 403 Response if the given provider is disabled for the user,
 * or null if the request is allowed.
 *
 * @param userId   - caller's UUID
 * @param role     - caller's role string
 * @param providerKey - e.g. 'vdocipher' | 'plyr'
 */
export async function checkProviderPermission(
  userId: string,
  role: string,
  providerKey: string,
): Promise<Response | null> {
  // super_admin and admin are never blocked
  if (role === 'super_admin' || role === 'admin') return null;

  const supabase = createServiceClient();

  // Fetch global status
  const { data: provider, error: pvErr } = await supabase
    .from('video_providers')
    .select('is_globally_enabled')
    .eq('provider_key', providerKey)
    .single();

  if (pvErr || !provider) {
    console.error('[provider-check] unknown provider', { providerKey, pvErr });
    return json({ success: false, code: 'INVALID_PROVIDER', error: 'Invalid video provider.' }, 400);
  }

  if (!provider.is_globally_enabled) {
    return json({
      success: false,
      code: 'PROVIDER_DISABLED',
      error: 'This upload provider has been disabled.',
    }, 403);
  }

  // Fetch per-teacher override (default: enabled if no row exists)
  const { data: perm } = await supabase
    .from('teacher_provider_permissions')
    .select('is_enabled')
    .eq('teacher_id', userId)
    .eq('provider_key', providerKey)
    .maybeSingle();

  const teacherEnabled = perm == null ? true : perm.is_enabled;
  if (!teacherEnabled) {
    return json({
      success: false,
      code: 'PROVIDER_DISABLED',
      error: 'This upload provider has been disabled.',
    }, 403);
  }

  return null; // allowed
}
