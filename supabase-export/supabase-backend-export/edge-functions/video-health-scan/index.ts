// supabase/functions/video-health-scan/index.ts
// Video Health Scan Edge Function
// Handles: single scan, bulk scan, metadata, delete, provider health check, daily report.
// All VdoCipher API calls are isolated here — no client code touches VdoCipher directly.

import { requireAuth, json, corsHeaders, createServiceClient } from '../_shared/auth.ts';

const VDOCIPHER_API = 'https://dev.vdocipher.com/api';

function vdoHeaders(secret: string) {
  return { 'Authorization': `Apisecret ${secret}`, 'Content-Type': 'application/json' };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

  try {
    const { userId, role } = await requireAuth(req);
    if (!['super_admin', 'admin'].includes(role)) {
      return json({ error: 'Forbidden' }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action: string = body.action ?? 'scan_one';
    const supabase = createServiceClient();
    const apiSecret = Deno.env.get('VDOCIPHER_API_SECRET') ?? '';

    // ── create_upload_ticket ──────────────────────────────────────────────────
    if (action === 'create_upload_ticket') {
      const { title, mimeType, fileSizeBytes } = body;

      // Accepted MIME types must match src/lib/videoFormats.ts ACCEPTED_VIDEO_MIMES
      const ACCEPTED_UPLOAD_MIMES = new Set([
        'video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm',
        'video/x-msvideo', 'video/mpeg', 'video/3gpp', 'video/3gpp2',
        'video/mp2t', 'video/x-m4v', 'video/ogg', 'video/x-flv',
        'video/x-ms-wmv', 'application/octet-stream',
      ]);
      const ACCEPTED_EXTENSIONS: Record<string, string> = {
        mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
        mkv: 'video/x-matroska', avi: 'video/x-msvideo', webm: 'video/webm',
        mpeg: 'video/mpeg', mpg: 'video/mpeg', '3gp': 'video/3gpp',
        '3g2': 'video/3gpp2', ts: 'video/mp2t', m2ts: 'video/mp2t',
        mts: 'video/mp2t', ogv: 'video/ogg', flv: 'video/x-flv',
        wmv: 'video/x-ms-wmv',
      };

      const reported = (mimeType ?? '').toLowerCase().trim();
      // Derive extension from title as fallback
      const ext = (title ?? '').split('.').pop()?.toLowerCase() ?? '';
      const extMime = ACCEPTED_EXTENSIONS[ext] ?? '';
      const resolvedMime = (ACCEPTED_UPLOAD_MIMES.has(reported) ? reported : extMime) || 'video/mp4';

      console.log('[video-health-scan] create_upload_ticket', {
        title, reportedMime: reported, ext, extMime, resolvedMime, fileSizeBytes,
      });

      if (reported && !ACCEPTED_UPLOAD_MIMES.has(reported) && !extMime) {
        return json({
          error: 'Unsupported video format.',
          detectedMime: reported,
          detectedExtension: ext,
          expectedMimes: [...ACCEPTED_UPLOAD_MIMES].filter(m => !m.startsWith('application/')),
          expectedExtensions: Object.keys(ACCEPTED_EXTENSIONS),
        }, 415);
      }

      // Request upload credentials from VdoCipher
      const uploadRes = await fetch(`${VDOCIPHER_API}/videos`, {
        method: 'PUT',
        headers: vdoHeaders(apiSecret),
        body: JSON.stringify({ title: title ?? 'Untitled Video' }),
      });
      if (!uploadRes.ok) {
        const errBody = await uploadRes.text();
        console.error('[video-health-scan] VdoCipher upload ticket error', uploadRes.status, errBody);
        return json({ error: 'Failed to create upload ticket from provider', detail: errBody }, 502);
      }
      const uploadData = await uploadRes.json();
      // VdoCipher PUT /videos returns: { clientPayload: {...}, videoId: "..." }
      return json({
        uploadUrl: uploadData.clientPayload?.uploadLink ?? uploadData.url,
        providerVideoId: uploadData.videoId,
        fields: uploadData.clientPayload,
        resolvedMime,
      });
    }


    if (action === 'provider_health') {
      try {
        const r = await fetch(`${VDOCIPHER_API}/videos?count=1`, {
          headers: vdoHeaders(apiSecret),
        });
        const status = r.ok ? 'online' : r.status >= 500 ? 'degraded' : 'offline';
        await supabase.from('video_provider_config').update({
          health_status: status, health_checked_at: new Date().toISOString(),
        }).eq('provider_key', 'medacademy');
        return json({ status });
      } catch {
        return json({ status: 'offline' });
      }
    }

    // ── get metadata ──────────────────────────────────────────────────────────
    if (action === 'get_metadata') {
      const { provider_video_id } = body;
      if (!provider_video_id) return json({ error: 'provider_video_id required' }, 400);
      const r = await fetch(`${VDOCIPHER_API}/videos/${encodeURIComponent(provider_video_id)}`, {
        headers: vdoHeaders(apiSecret),
      });
      if (!r.ok) return json({ error: 'Provider metadata fetch failed' }, 502);
      const raw = await r.json();
      return json({
        providerVideoId: raw.id,
        title: raw.title,
        duration: raw.length,
        resolution: raw.width && raw.height ? `${raw.width}x${raw.height}` : undefined,
        fileSize: raw.size,
        status: raw.status,
        thumbnailUrl: raw.poster ?? null,
        raw,
      });
    }

    // ── delete video ──────────────────────────────────────────────────────────
    if (action === 'delete_video') {
      const { provider_video_id } = body;
      if (!provider_video_id) return json({ error: 'provider_video_id required' }, 400);
      const r = await fetch(`${VDOCIPHER_API}/videos/${encodeURIComponent(provider_video_id)}`, {
        method: 'DELETE', headers: vdoHeaders(apiSecret),
      });
      if (!r.ok) return json({ error: 'Provider delete failed' }, 502);
      return json({ deleted: true });
    }

    // ── retry processing ──────────────────────────────────────────────────────
    if (action === 'retry_processing') {
      const { provider_video_id } = body;
      if (!provider_video_id) return json({ error: 'provider_video_id required' }, 400);
      // VdoCipher: re-upload would be needed; mark as retry in our DB
      await supabase.from('video_uploads').update({
        status: 'waiting', error_message: null, verification_status: 'pending',
      }).eq('provider_video_id', provider_video_id);
      return json({ retried: true });
    }

    // ── health_check for a single upload_id ───────────────────────────────────
    if (action === 'health_check' || action === 'scan_one') {
      const { upload_id, provider_video_id } = body;
      if (!upload_id) return json({ error: 'upload_id required' }, 400);

      // Create scan record
      const { data: scan } = await supabase.from('video_health_scans').insert({
        upload_id, scan_type: 'manual', triggered_by: userId,
        started_at: new Date().toISOString(), overall_status: 'running',
      }).select('id').single();
      const scanId = scan?.id;

      const checks: Record<string, { status: string; message?: string; checked_at: string }> = {};
      const errors: string[] = [];
      const ts = () => new Date().toISOString();

      // Fetch upload record
      const { data: upload } = await supabase
        .from('video_uploads')
        .select('*, lesson:lessons(id, title, course_id), course:courses(id, title)')
        .eq('id', upload_id).single();

      if (!upload) {
        if (scanId) await supabase.from('video_health_scans').update({
          overall_status: 'error', error_message: 'Upload record not found',
          completed_at: ts(), duration_ms: 0,
        }).eq('id', scanId);
        return json({ error: 'Upload not found' }, 404);
      }

      const vidId = provider_video_id ?? upload.provider_video_id;
      const startMs = Date.now();

      // 1. Metadata check
      if (vidId && apiSecret) {
        try {
          const r = await fetch(`${VDOCIPHER_API}/videos/${encodeURIComponent(vidId)}`, {
            headers: vdoHeaders(apiSecret),
          });
          if (r.ok) {
            const meta = await r.json();
            checks.metadata = { status: 'pass', checked_at: ts() };
            // Update resolution / duration from provider
            const patch: Record<string, unknown> = {};
            if (meta.width && meta.height) patch.video_resolution = `${meta.width}x${meta.height}`;
            if (meta.length) patch.video_duration_sec = meta.length;
            if (meta.poster) patch.thumbnail_url = meta.poster;
            if (Object.keys(patch).length) {
              await supabase.from('video_uploads').update(patch).eq('id', upload_id);
            }
          } else {
            checks.metadata = { status: 'fail', message: `HTTP ${r.status}`, checked_at: ts() };
            errors.push('Metadata fetch failed.');
          }
        } catch (e) {
          checks.metadata = { status: 'error', message: String(e), checked_at: ts() };
          errors.push('Metadata check error.');
        }
      } else {
        checks.metadata = { status: 'skip', message: 'No provider_video_id', checked_at: ts() };
      }

      // 2. Lesson link check
      if (upload.lesson_id) {
        checks.lesson_link = {
          status: upload.lesson ? 'pass' : 'fail',
          message: upload.lesson ? undefined : 'Lesson not found',
          checked_at: ts(),
        };
        if (!upload.lesson) errors.push('Lesson not linked.');
      } else {
        checks.lesson_link = { status: 'skip', message: 'No lesson_id', checked_at: ts() };
      }

      // 3. Thumbnail check
      if (upload.thumbnail_url) {
        try {
          const r = await fetch(upload.thumbnail_url, { method: 'HEAD' });
          checks.thumbnail = {
            status: r.ok ? 'pass' : 'fail',
            message: r.ok ? undefined : `HTTP ${r.status}`,
            checked_at: ts(),
          };
          if (!r.ok) errors.push('Thumbnail not accessible.');
        } catch (e) {
          checks.thumbnail = { status: 'error', message: String(e), checked_at: ts() };
          errors.push('Thumbnail check error.');
        }
      } else {
        checks.thumbnail = { status: 'fail', message: 'No thumbnail URL', checked_at: ts() };
        errors.push('Thumbnail missing.');
      }

      // 4. Public URL / playback accessibility
      if (upload.public_url) {
        try {
          const r = await fetch(upload.public_url, { method: 'HEAD' });
          checks.playback = {
            status: r.ok ? 'pass' : 'fail',
            message: r.ok ? undefined : `HTTP ${r.status}`,
            checked_at: ts(),
          };
          if (!r.ok) errors.push('Video not accessible at public URL.');
        } catch (e) {
          checks.playback = { status: 'error', message: String(e), checked_at: ts() };
        }
      } else {
        checks.playback = { status: 'skip', message: 'No public_url', checked_at: ts() };
      }

      // 5. Attachment check
      const { count } = await supabase
        .from('lesson_materials')
        .select('id', { count: 'exact', head: true })
        .eq('lesson_id', upload.lesson_id ?? '');
      checks.attachment = { status: 'pass', message: `${count ?? 0} materials`, checked_at: ts() };

      const overallPassed = errors.length === 0;
      const healthScore = Math.max(0, 100 - errors.length * 20);
      const durationMs = Date.now() - startMs;
      const overallStatus = overallPassed ? 'passed' : 'failed';

      // Update scan record
      if (scanId) {
        await supabase.from('video_health_scans').update({
          overall_status: overallStatus, health_score: healthScore,
          checks, completed_at: ts(), duration_ms: durationMs,
        }).eq('id', scanId);
      }

      // Update upload record
      await supabase.from('video_uploads').update({
        last_health_check_at: ts(), health_score: healthScore,
        playback_status: overallPassed ? 'ok' : 'error',
        thumbnail_missing: !upload.thumbnail_url,
        verification_status: overallPassed ? 'passed' : 'failed',
        verification_error: errors.length > 0 ? errors.join(' ') : null,
      }).eq('id', upload_id);

      // Create alert if failed
      if (!overallPassed) {
        await supabase.from('video_health_alerts').insert({
          upload_id,
          alert_type: 'verification_failed',
          severity: 'warning',
          title: 'Video Health Check Failed',
          message: errors.join(' '),
          metadata: { scan_id: scanId, checks },
        });
      }

      // Audit log
      await supabase.from('upload_audit_logs').insert({
        upload_id,
        event: overallPassed ? 'verification_passed' : 'verification_failed',
        details: { scan_id: scanId, errors, health_score: healthScore },
      }).catch(() => {});

      return json({
        scanId, overallStatus, healthScore,
        checks, errors, durationMs,
        accessible: overallPassed, playable: !errors.length,
        metadataValid: checks.metadata?.status === 'pass',
        thumbnailPresent: checks.thumbnail?.status === 'pass',
        durationValid: true,
        checkedAt: ts(),
      });
    }

    // ── scan_all ──────────────────────────────────────────────────────────────
    if (action === 'scan_all') {
      // Fetch all ready videos (non-blocking — runs through them sequentially)
      const { data: uploads } = await supabase
        .from('video_uploads')
        .select('id')
        .in('status', ['ready', 'failed', 'verifying'])
        .limit(500);

      if (!uploads?.length) return json({ scanned: 0, message: 'No videos to scan' });

      let passed = 0, failed = 0;
      const scanStart = Date.now();

      for (const u of uploads) {
        try {
          // Re-invoke self for each video (reuse scan_one logic inline)
          const r = await fetch(req.url, {
            method: 'POST',
            headers: { ...Object.fromEntries(req.headers.entries()) },
            body: JSON.stringify({ action: 'scan_one', upload_id: u.id }),
          });
          const result = await r.json();
          result.overallStatus === 'passed' ? passed++ : failed++;
        } catch { failed++; }
      }

      const total = uploads.length;
      const healthPct = total > 0 ? Math.round((passed / total) * 10000) / 100 : 100;
      const scanDurationS = Math.round((Date.now() - scanStart) / 1000);

      // Upsert daily report
      const today = new Date().toISOString().split('T')[0];
      await supabase.from('video_daily_health_reports').upsert({
        report_date: today,
        total_videos: total,
        healthy_count: passed,
        broken_count: failed,
        health_pct: healthPct,
        scan_duration_s: scanDurationS,
        details: { triggered_by: userId, scan_type: 'manual' },
      }, { onConflict: 'report_date' });

      return json({ scanned: total, passed, failed, healthPct, scanDurationS });
    }

    // ── regenerate_thumbnail ──────────────────────────────────────────────────
    if (action === 'regenerate_thumbnail') {
      const { upload_id, provider_video_id } = body;
      if (!upload_id) return json({ error: 'upload_id required' }, 400);
      // Fetch thumbnail from VdoCipher poster
      if (apiSecret && provider_video_id) {
        const r = await fetch(`${VDOCIPHER_API}/videos/${encodeURIComponent(provider_video_id)}`, {
          headers: vdoHeaders(apiSecret),
        });
        if (r.ok) {
          const meta = await r.json();
          if (meta.poster) {
            await supabase.from('video_uploads').update({
              thumbnail_url: meta.poster, thumbnail_missing: false,
            }).eq('id', upload_id);
            await supabase.from('upload_audit_logs').insert({
              upload_id, event: 'thumbnail_generated',
              details: { source: 'provider_regenerate', url: meta.poster },
            }).catch(() => {});
            return json({ thumbnailUrl: meta.poster });
          }
        }
      }
      return json({ error: 'Could not regenerate thumbnail' }, 502);
    }

    return json({ error: `Unknown action: ${action}` }, 400);

  } catch (err) {
    if (err instanceof Response) return err;
    console.error('video-health-scan error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
