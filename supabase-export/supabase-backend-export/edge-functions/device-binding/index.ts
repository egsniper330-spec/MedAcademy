// supabase/functions/device-binding/index.ts
// Enterprise device management — registration, block/unblock, logout, limit config, history.
// All device writes must pass through this function — never directly from client.

import { requireAuth, requireRole, createServiceClient, createUserClient, json, corsHeaders } from '../_shared/auth.ts';

const DEPLOYED_AT = '2026-07-13T_v253_fix_duplicate_device_upsert';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { userId, role, token } = await requireAuth(req);
    const body = await req.json();
    const { action } = body;

    // DIAGNOSTIC — remove after login confirmed working
    console.log(`[device-binding] DIAGNOSTIC deployed_at=${DEPLOYED_AT} action=${action ?? 'none'} request_ts=${new Date().toISOString()}`);
    const supabase = createServiceClient();
    const userClient = createUserClient(token);

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      ?? req.headers.get('cf-connecting-ip')
      ?? null;

    // ── register ───────────────────────────────────────────────────────────────
    if (action === 'register') {
      const {
        fingerprint, device_name, platform,
        device_model, os, os_version, app_version, manufacturer, installation_id,
      } = body;
      if (!fingerprint) return json({ error: 'fingerprint is required' }, 400);

      // CRITICAL FIX: Use register_device_for_user via serviceClient with explicit userId.
      //
      // Root cause of "0 devices registered" bug:
      //   The old code called register_device() via userClient.rpc(). That function
      //   is SECURITY DEFINER — it runs as the function owner (postgres role), NOT as
      //   the calling user. Inside SECURITY DEFINER, auth.uid() returns NULL because
      //   the JWT context is stripped when the role switches to the definer's role.
      //   Result: register_device returned { error: 'Not authenticated' } on EVERY call.
      //   The error was caught and silently swallowed in sign-in.tsx → 0 devices ever registered.
      //
      // Fix: use register_device_for_user(p_user_id, ...) via serviceClient.
      //   The Edge Function already verified the JWT via requireAuth(), so userId is trusted.
      //   The service-role client bypasses auth.uid() entirely — userId is passed explicitly.
      console.log(`[device-binding] register: userId=${userId} fingerprint=${fingerprint} installation_id=${installation_id ?? 'none'}`);

      const { data, error } = await supabase.rpc('register_device_for_user', {
        p_user_id:         userId,
        p_fingerprint:     fingerprint,
        p_device_name:     device_name      ?? 'Unknown Device',
        p_platform:        platform         ?? 'unknown',
        p_ip_address:      ip,
        p_device_model:    device_model     ?? null,
        p_os:              os               ?? null,
        p_os_version:      os_version       ?? null,
        p_app_version:     app_version      ?? null,
        p_manufacturer:    manufacturer     ?? null,
        p_installation_id: installation_id  ?? null,
      });
      console.log(`[device-binding] register_device_for_user result: ${JSON.stringify({ data, error: error?.message })}`);
      if (error) return json({ error: error.message }, 400);

      // Propagate limit-reached error as 403
      if (data && typeof data === 'object' && 'error' in data) {
        const isLimit = (data as Record<string,unknown>).limit_reached === true;
        return json(data, isLimit ? 403 : 400);
      }

      // Record login history
      try {
        await supabase.rpc('write_login_history', {
          p_user_id:            userId,
          p_device_fingerprint: fingerprint,
          p_device_name:        device_name ?? 'Unknown Device',
          p_platform:           platform    ?? 'unknown',
          p_ip_address:         ip,
          p_success:            true,
          p_failure_reason:     null,
        });
      } catch (histErr) {
        console.error('login_history insert failed (non-fatal):', histErr);
      }

      return json(data);
    }

    // ── status (own devices) ───────────────────────────────────────────────────
    if (action === 'status') {
      const { data: devices, error } = await supabase
        .from('devices')
        .select('id,device_name,device_model,platform,os,os_version,app_version,manufacturer,ip_address,status,block_reason,registered_at,last_active_at,device_fingerprint')
        .eq('user_id', userId)
        .order('last_active_at', { ascending: false });
      if (error) return json({ error: error.message }, 400);

      const { data: profile } = await supabase
        .from('profiles')
        .select('max_devices,role')
        .eq('id', userId)
        .single();

      // super_admin is always unlimited (max_devices = null).
      // For all other roles: use the stored value, falling back to 1 only
      // when the profile row itself is missing (should never happen in prod).
      const isUnlimited = profile?.role === 'super_admin' || profile?.max_devices === null;

      return json({
        devices:     devices ?? [],
        max_devices: isUnlimited ? null : (profile?.max_devices ?? 1),
      });
    }

    // ── get_devices (admin — any user) ─────────────────────────────────────────
    if (action === 'get_devices') {
      requireRole(role, ['admin', 'super_admin']);
      const { target_user_id } = body;
      if (!target_user_id) return json({ error: 'target_user_id is required' }, 400);

      const { data: devices, error } = await supabase
        .from('devices')
        .select('id,device_name,device_model,platform,os,os_version,app_version,manufacturer,ip_address,status,block_reason,registered_at,last_active_at,device_fingerprint,blocked_at')
        .eq('user_id', target_user_id)
        .order('last_active_at', { ascending: false });
      if (error) return json({ error: error.message }, 400);

      const { data: profile } = await supabase
        .from('profiles')
        .select('max_devices,full_name,email,role')
        .eq('id', target_user_id)
        .single();

      return json({ devices: devices ?? [], profile });
    }

    // ── logout_device ─────────────────────────────────────────────────────────
    if (action === 'logout_device') {
      const { device_id } = body;
      if (!device_id) return json({ error: 'device_id is required' }, 400);
      const { error } = await userClient.rpc('logout_device', {
        p_device_id: device_id,
        p_actor_id:  userId,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ success: true });
    }

    // ── block_device (admin) ──────────────────────────────────────────────────
    if (action === 'block_device') {
      requireRole(role, ['admin', 'super_admin']);
      const { device_id, block_reason } = body;
      if (!device_id) return json({ error: 'device_id is required' }, 400);

      // p_status is explicitly typed as text — only one overload exists after
      // the enum overload was dropped (migration drop_update_device_status_enum_overload).
      const { error } = await supabase.rpc('update_device_status', {
        p_device_id:    device_id,
        p_status:       'blocked' as string,
        p_block_reason: block_reason ?? null,
        p_actor_id:     userId,
      });
      if (error) return json({ error: error.message }, 400);

      // SECURITY: bump the device owner's security_version immediately.
      // This invalidates their current JWT on next check_authorization call,
      // forcing the already-logged-in device to be kicked out in real time.
      // Without this, the session continues until the token expires (~1h).
      const { data: devRow } = await supabase
        .from('devices')
        .select('user_id')
        .eq('id', device_id)
        .maybeSingle();

      if (devRow?.user_id) {
        await supabase.rpc('bump_security_version', { p_user_id: devRow.user_id });
        // Notify the account owner
        try {
          await supabase.from('notifications').insert({
            user_id: devRow.user_id,
            title:   'Device Blocked',
            message: `A device on your account has been blocked by an administrator.${block_reason ? ' Reason: ' + block_reason : ''}`,
            type:    'security',
            is_read: false,
          });
        } catch (_) {}
      }

      return json({ success: true });
    }

    // ── unblock_device (admin) ────────────────────────────────────────────────
    if (action === 'unblock_device') {
      requireRole(role, ['admin', 'super_admin']);
      const { device_id } = body;
      if (!device_id) return json({ error: 'device_id is required' }, 400);
      const { error } = await supabase.rpc('update_device_status', {
        p_device_id:    device_id,
        p_status:       'active' as string,
        p_block_reason: null,
        p_actor_id:     userId,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ success: true });
    }

    // ── delete_device (admin) ─────────────────────────────────────────────────
    if (action === 'delete_device') {
      requireRole(role, ['admin', 'super_admin']);
      const { device_id } = body;
      if (!device_id) return json({ error: 'device_id is required' }, 400);
      const { error } = await supabase.rpc('delete_device_record', {
        p_device_id: device_id,
        p_actor_id:  userId,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ success: true });
    }

    // ── rename_device ─────────────────────────────────────────────────────────
    if (action === 'rename_device') {
      const { device_id, new_name } = body;
      if (!device_id || !new_name) return json({ error: 'device_id and new_name are required' }, 400);
      const { error } = await userClient.rpc('rename_device', {
        p_device_id: device_id,
        p_new_name:  new_name,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ success: true });
    }

    // ── set_limit (admin) ─────────────────────────────────────────────────────
    if (action === 'set_limit') {
      requireRole(role, ['admin', 'super_admin']);
      const { target_user_id, max_devices } = body;
      if (!target_user_id) return json({ error: 'target_user_id is required' }, 400);
      const { error } = await supabase.rpc('set_device_limit', {
        p_target_user_id: target_user_id,
        p_max_devices:    max_devices ?? null,   // null = unlimited
        p_actor_id:       userId,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ success: true });
    }

    // ── admin_reset (NOW: marks all devices revoked + bumps security_version) ──
    if (action === 'admin_reset') {
      requireRole(role, ['admin', 'super_admin']);
      const { target_user_id, reason } = body;
      if (!target_user_id) return json({ error: 'target_user_id is required' }, 400);
      const { data, error } = await supabase.rpc('admin_reset_device', {
        p_target_user_id: target_user_id,
        p_reason:         reason ?? '',
      });
      if (error) return json({ error: error.message }, 400);
      // Send in-app notification to account owner
      try {
        await supabase.from('notifications').insert({
          user_id:    target_user_id,
          title:      'Device Reset',
          message:    'Your registered device has been reset by an administrator. Please sign in again.',
          type:       'security',
          is_read:    false,
        });
      } catch (notifErr) { console.error('notification insert failed (non-fatal):', notifErr); }
      return json(data);
    }

    // ── force_logout: revoke a single device + bump security_version ──────────
    if (action === 'force_logout') {
      requireRole(role, ['admin', 'super_admin']);
      const { device_id, reason } = body;
      if (!device_id) return json({ error: 'device_id is required' }, 400);

      // Look up device row BEFORE the operation
      const { data: devBefore, error: lookupErr } = await supabase
        .from('devices')
        .select('id, user_id, device_name, device_fingerprint, installation_id, status, trust_level')
        .eq('id', device_id)
        .maybeSingle();

      if (!devBefore) {
        return json({ error: 'Device not found' }, 404);
      }

      const { data, error } = await supabase.rpc('force_logout_device', {
        p_device_id: device_id,
        p_reason:    reason ?? 'Admin force logout',
      });

      if (error) return json({ error: error.message }, 400);
      if (devBefore?.user_id) {
        try {
          await supabase.from('notifications').insert({
            user_id:    devBefore.user_id,
            title:      'Device Logged Out',
            message:    'A device on your account has been remotely logged out by an administrator.',
            type:       'security',
            is_read:    false,
          });
        } catch (_) {}
      }
      return json(data);
    }

    // ── logout_all: super_admin logs out all devices (optionally spare current) ─
    if (action === 'logout_all') {
      requireRole(role, ['admin', 'super_admin']);
      const { target_user_id, exclude_fingerprint, reason } = body;
      if (!target_user_id) return json({ error: 'target_user_id is required' }, 400);
      const { data, error } = await supabase.rpc('logout_all_devices', {
        p_target_user_id:      target_user_id,
        p_exclude_fingerprint: exclude_fingerprint ?? null,
        p_reason:              reason ?? 'Admin logout all',
      });
      if (error) return json({ error: error.message }, 400);
      try {
        await supabase.from('notifications').insert({
          user_id:    target_user_id,
          title:      'All Devices Logged Out',
          message:    'All devices on your account have been remotely logged out by an administrator.',
          type:       'security',
          is_read:    false,
        });
      } catch (_) {}
      return json(data);
    }

    // ── check_authorization: client calls this on app focus to detect revocation ─
    if (action === 'check_authorization') {
      const { fingerprint, stored_security_version } = body;

      // ── Step 1: security_version + account-blocked check ────────────────────
      const { data: prof } = await supabase
        .from('profiles')
        .select('security_version, status')
        .eq('id', userId)
        .maybeSingle();
      const currentVersion = prof?.security_version ?? 0;
      const clientVersion  = Number(stored_security_version ?? 0);

      // Account blocked — immediately reject, regardless of version
      if (prof?.status === 'blocked') {
        return json({ authorized: false, reason: 'account_blocked', security_version: currentVersion }, 200);
      }

      if (currentVersion !== clientVersion) {
        return json({ authorized: false, reason: 'security_version_changed', security_version: currentVersion }, 200);
      }

      // ── Step 2: device row check ─────────────────────────────────────────────
      // The devices table is the source of truth for active devices.
      // Rule: if a fingerprint is provided (device has registered before), the
      // device row MUST exist and MUST NOT be revoked or blocked.
      //   • row missing   → device was deleted (force-logout / reset) → unauthorized
      //   • row revoked   → explicit admin revocation               → unauthorized
      //   • row blocked   → explicit admin block                    → unauthorized
      //   • row active    → device is in good standing              → authorized
      // Devices that have never registered (no fingerprint stored client-side)
      // are allowed through — they have not completed registration yet.
      //
      // IMPORTANT — web fingerprint rotation:
      // On web, Constants.sessionId (Expo) is a new UUID every page load, so the
      // fingerprint in localStorage may be one cycle ahead of the DB row (the DB
      // row is updated by register_device_for_user during login, but check_auth
      // can be called by the getSession() IIFE in ctx.tsx that races with
      // registerDevice). We therefore try the fingerprint lookup first, and if
      // that misses we fall back to the installation_id lookup. The installation_id
      // is stable (persisted in localStorage across page loads) so it always
      // resolves the correct row regardless of fingerprint rotation.
      if (fingerprint) {
        const { data: devByFp } = await supabase
          .from('devices')
          .select('id, status, trust_level, device_fingerprint, installation_id')
          .eq('user_id', userId)
          .eq('device_fingerprint', fingerprint)
          .maybeSingle();
        if (devByFp) {
          if (devByFp.status === 'blocked' || devByFp.trust_level === 'revoked') {
            return json({ authorized: false, reason: 'device_revoked', security_version: currentVersion }, 200);
          }
        } else {
          const installationId: string | undefined = body.installation_id;
          let devByInstall = null;
          if (installationId) {
            const { data } = await supabase
              .from('devices')
              .select('id, status, trust_level, device_fingerprint, installation_id')
              .eq('user_id', userId)
              .eq('installation_id', installationId)
              .neq('status', 'blocked')
              .maybeSingle();
            devByInstall = data;
          }

          if (!devByInstall) {
            return json({ authorized: false, reason: 'device_not_found', security_version: currentVersion }, 200);
          }

          if (devByInstall.status === 'blocked' || devByInstall.trust_level === 'revoked') {
            return json({ authorized: false, reason: 'device_revoked', security_version: currentVersion }, 200);
          }
        }
      }

      return json({ authorized: true, security_version: currentVersion });
    }

    // ── get_login_history ─────────────────────────────────────────────────────
    if (action === 'get_login_history') {
      const target = (role === 'admin' || role === 'super_admin')
        ? (body.target_user_id ?? userId)
        : userId;

      const { data, error } = await supabase
        .from('login_history')
        .select('*')
        .eq('user_id', target)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) return json({ error: error.message }, 400);
      return json({ history: data ?? [] });
    }

    // ── update_push_token ─────────────────────────────────────────────────────
    // Stores or clears the Expo Push Token on the calling user's device row.
    // Matched by installation_id (stable per install) so the correct device
    // row is updated when a user has multiple devices.
    // push_token=null clears the token (called on logout).
    if (action === 'update_push_token') {
      const { push_token, installation_id } = body;
      if (!installation_id) return json({ error: 'installation_id is required' }, 400);

      // Validate token format when setting (not clearing).
      // Expo Push Tokens always start with "ExponentPushToken[".
      if (push_token !== null && push_token !== undefined) {
        if (typeof push_token !== 'string' || !push_token.startsWith('ExponentPushToken[')) {
          return json({ error: 'Invalid push_token: must be an Expo Push Token (ExponentPushToken[...])' }, 400);
        }
      }

      // Find the device row for this user + installation
      const { data: deviceRow, error: findErr } = await supabase
        .from('devices')
        .select('id')
        .eq('user_id', userId)
        .eq('installation_id', installation_id)
        .maybeSingle();

      if (findErr) return json({ error: findErr.message }, 400);
      if (!deviceRow) return json({ error: 'Device not found for this installation_id' }, 404);

      const { error: updateErr } = await supabase
        .from('devices')
        .update({ push_token: push_token ?? null })
        .eq('id', deviceRow.id)
        .eq('user_id', userId); // belt-and-suspenders ownership check

      if (updateErr) return json({ error: updateErr.message }, 400);

      console.log(
        `[device-binding] update_push_token: userId=${userId} device=${deviceRow.id} ` +
        `token=${push_token ? push_token.slice(0, 30) + '…' : 'null (cleared)'}`
      );
      return json({ success: true });
    }

    // ── record_login_failure ──────────────────────────────────────────────────
    if (action === 'record_failure') {
      const { fingerprint, device_name, platform: plt, reason } = body;
      try {
        await supabase.rpc('write_login_history', {
          p_user_id:            userId,
          p_device_fingerprint: fingerprint ?? null,
          p_device_name:        device_name ?? null,
          p_platform:           plt         ?? null,
          p_ip_address:         ip,
          p_success:            false,
          p_failure_reason:     reason ?? 'unknown',
        });
      } catch (_) { /* non-fatal */ }
      return json({ success: true });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    if (err instanceof Response) return err;
    console.error('device-binding error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
