// supabase/functions/video-daily-health/index.ts
// Scheduled daily health scan — runs once per day via Supabase cron.
// Scans all ready/failed videos, generates a daily report, sends alerts.

import { json, createServiceClient } from '../_shared/auth.ts';

Deno.serve(async (req: Request) => {
  // Allow cron invocation (no auth header) OR admin-authenticated manual trigger
  const supabase = createServiceClient();
  const scanStart = Date.now();
  const today = new Date().toISOString().split('T')[0];
  const apiSecret = Deno.env.get('VDOCIPHER_API_SECRET') ?? '';
  const VDOCIPHER_API = 'https://dev.vdocipher.com/api';

  console.log(`[daily-health] Starting daily scan for ${today}`);

  try {
    // Fetch all ready/failed uploads
    const { data: uploads } = await supabase
      .from('video_uploads')
      .select('id, thumbnail_url, public_url, lesson_id, provider_video_id, status')
      .in('status', ['ready', 'failed', 'verifying'])
      .limit(2000);

    if (!uploads?.length) {
      console.log('[daily-health] No videos to scan.');
      return json({ scanned: 0 });
    }

    let passed = 0, failed = 0, warnings = 0;
    const alertsToCreate: any[] = [];

    for (const upload of uploads) {
      const errors: string[] = [];

      // Thumbnail check
      if (!upload.thumbnail_url) {
        errors.push('Thumbnail missing.');
        await supabase.from('video_uploads').update({ thumbnail_missing: true }).eq('id', upload.id);
      }

      // Metadata check via VdoCipher
      if (upload.provider_video_id && apiSecret) {
        try {
          const r = await fetch(
            `${VDOCIPHER_API}/videos/${encodeURIComponent(upload.provider_video_id)}`,
            { headers: { 'Authorization': `Apisecret ${apiSecret}` } },
          );
          if (!r.ok) errors.push(`Metadata fetch failed (HTTP ${r.status}).`);
          else {
            const meta = await r.json();
            const patch: Record<string, unknown> = { last_health_check_at: new Date().toISOString() };
            if (meta.width && meta.height) patch.video_resolution = `${meta.width}x${meta.height}`;
            if (meta.length) patch.video_duration_sec = meta.length;
            if (meta.poster && !upload.thumbnail_url) patch.thumbnail_url = meta.poster;
            await supabase.from('video_uploads').update(patch).eq('id', upload.id);
          }
        } catch (e) { errors.push(`Metadata error: ${e}`); }
      }

      const healthScore = Math.max(0, 100 - errors.length * 20);
      const status = errors.length === 0 ? 'passed' : 'failed';

      await supabase.from('video_uploads').update({
        health_score: healthScore,
        verification_status: status,
        verification_error: errors.length ? errors.join(' ') : null,
        playback_status: errors.length ? 'error' : 'ok',
      }).eq('id', upload.id);

      if (errors.length === 0) passed++;
      else {
        failed++;
        alertsToCreate.push({
          upload_id: upload.id,
          alert_type: 'verification_failed',
          severity: errors.length >= 2 ? 'critical' : 'warning',
          title: 'Daily Health Check Failed',
          message: errors.join(' '),
          metadata: { scan_date: today, errors },
        });
      }
    }

    // Bulk insert alerts (deduplicate by upload_id — only create if not already unresolved)
    for (const alert of alertsToCreate) {
      const { count } = await supabase
        .from('video_health_alerts')
        .select('id', { count: 'exact', head: true })
        .eq('upload_id', alert.upload_id)
        .eq('resolved', false);
      if ((count ?? 0) === 0) {
        try { await supabase.from('video_health_alerts').insert(alert); } catch (_) { /* non-fatal */ }
      }
    }

    const total = uploads.length;
    const healthPct = total > 0 ? Math.round((passed / total) * 10000) / 100 : 100;
    const scanDurationS = Math.round((Date.now() - scanStart) / 1000);

    // Upsert daily report
    await supabase.from('video_daily_health_reports').upsert({
      report_date: today,
      total_videos: total,
      healthy_count: passed,
      broken_count: failed,
      warning_count: warnings,
      health_pct: healthPct,
      scan_duration_s: scanDurationS,
      details: { scan_type: 'daily_cron', alerts_created: alertsToCreate.length },
    }, { onConflict: 'report_date' });

    // Update provider health
    await supabase.from('video_provider_config').update({
      last_sync_at: new Date().toISOString(),
    }).eq('provider_key', 'medacademy');

    console.log(`[daily-health] Done: ${passed} passed, ${failed} failed, health: ${healthPct}%`);
    return json({ scanned: total, passed, failed, healthPct, scanDurationS });

  } catch (err) {
    console.error('[daily-health] Error:', err);
    return json({ error: 'Daily scan failed', detail: String(err) }, 500);
  }
});
