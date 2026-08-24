/**
 * videoLibraryApi.ts
 *
 * API layer for the doctor Video Library feature.
 *
 * Key concepts:
 *   - video_assets: one row per physical VdoCipher upload, owned by a doctor.
 *   - lessons.video_asset_id: FK referencing video_assets.id.
 *   - A single asset can be referenced by many lessons (reuse without re-upload).
 *   - delete protection: reject deletion if any lesson references the asset.
 *   - replace: update one lesson's FK, or update every lesson that uses the asset.
 */
import { supabase } from '@/client/supabase';

export interface VideoAsset {
  id: string;
  doctor_id: string;
  provider_video_id: string;   // VdoCipher video ID
  title: string;
  duration_seconds: number | null;
  file_size_bytes: number | null;
  thumbnail_url: string | null;
  status: 'processing' | 'ready' | 'failed' | 'missing';
  upload_id: string | null;
  created_at: string;
  updated_at: string;
  // Computed by the query — not a real column
  lesson_count?: number;
}

export interface VideoAssetUsage {
  lesson_id: string;
  lesson_title: string;
  course_id: string;
  course_title: string;
}

export interface LibraryFilters {
  search?: string;
  status?: VideoAsset['status'] | 'all';
  sortBy?: 'created_at' | 'title' | 'duration_seconds' | 'file_size_bytes';
  sortDir?: 'asc' | 'desc';
}

// ── Fetch all assets owned by the current doctor ───────────────────────────
export async function getMyVideoLibrary(
  filters: LibraryFilters = {},
): Promise<VideoAsset[]> {
  const {
    search = '',
    status = 'all',
    sortBy = 'created_at',
    sortDir = 'desc',
  } = filters;

  let query = supabase
    .from('video_assets')
    .select('*')
    .order(sortBy, { ascending: sortDir === 'asc' });

  if (status !== 'all') {
    query = query.eq('status', status);
  }
  if (search.trim()) {
    query = query.ilike('title', `%${search.trim()}%`);
  }

  const { data, error } = await query;
  if (error) throw error;
  if (!data) return [];

  // Attach lesson_count via a separate aggregation query
  const assetIds = data.map((a: { id: string }) => a.id);
  if (assetIds.length === 0) return data as VideoAsset[];

  const { data: counts } = await supabase
    .from('lessons')
    .select('video_asset_id')
    .in('video_asset_id', assetIds);

  const countMap: Record<string, number> = {};
  for (const row of counts ?? []) {
    if (row.video_asset_id) {
      countMap[row.video_asset_id] = (countMap[row.video_asset_id] ?? 0) + 1;
    }
  }

  return (data as VideoAsset[]).map((a) => ({
    ...a,
    lesson_count: countMap[a.id] ?? 0,
  }));
}

// ── Fetch a single asset by id ─────────────────────────────────────────────
export async function getVideoAsset(assetId: string): Promise<VideoAsset | null> {
  const { data, error } = await supabase
    .from('video_assets')
    .select('*')
    .eq('id', assetId)
    .maybeSingle();
  if (error) throw error;
  return data as VideoAsset | null;
}

// ── Fetch usage list for an asset ──────────────────────────────────────────
export async function getVideoAssetUsage(assetId: string): Promise<VideoAssetUsage[]> {
  const { data, error } = await supabase.rpc('get_video_asset_usage', {
    p_asset_id: assetId,
  });
  if (error) throw error;
  return (data ?? []) as VideoAssetUsage[];
}

// ── Create (or upsert) an asset record after upload ───────────────────────
// Called by the upload pipeline once VdoCipher confirms the video_id.
export async function upsertVideoAsset(payload: {
  doctorId: string;
  providerVideoId: string;
  title: string;
  durationSeconds?: number | null;
  fileSizeBytes?: number | null;
  thumbnailUrl?: string | null;
  status?: VideoAsset['status'];
  uploadId?: string | null;
}): Promise<VideoAsset> {
  const row = {
    doctor_id:         payload.doctorId,
    provider_video_id: payload.providerVideoId,
    title:             payload.title,
    duration_seconds:  payload.durationSeconds ?? null,
    file_size_bytes:   payload.fileSizeBytes ?? null,
    thumbnail_url:     payload.thumbnailUrl ?? null,
    status:            payload.status ?? 'processing',
    upload_id:         payload.uploadId ?? null,
  };

  const { data, error } = await supabase
    .from('video_assets')
    .upsert(row, {
      onConflict: 'doctor_id,provider_video_id',
      ignoreDuplicates: false,
    })
    .select()
    .single();

  if (error) throw error;
  return data as VideoAsset;
}

// ── Update asset metadata (title, thumbnail, duration, status) ────────────
export async function updateVideoAsset(
  assetId: string,
  updates: Partial<Pick<VideoAsset, 'title' | 'thumbnail_url' | 'duration_seconds' | 'file_size_bytes' | 'status'>>,
): Promise<void> {
  const { error } = await supabase
    .from('video_assets')
    .update(updates)
    .eq('id', assetId);
  if (error) throw error;
}

// ── Attach an asset to a lesson ───────────────────────────────────────────
// Writes both video_asset_id (FK) and the legacy video_id text field
// so that existing playback code keeps working.
export async function attachAssetToLesson(
  lessonId: string,
  asset: VideoAsset,
): Promise<void> {
  const { error } = await supabase
    .from('lessons')
    .update({
      video_asset_id:     asset.id,
      video_id:           asset.provider_video_id,
      video_title:        asset.title,
      video_type:         'vdocipher',
      video_status:       asset.status === 'ready' ? 'ready' : asset.status,
      video_duration_seconds: asset.duration_seconds ?? undefined,
      video_thumbnail_url:    asset.thumbnail_url ?? undefined,
    })
    .eq('id', lessonId);
  if (error) throw error;
}

// ── Replace video for a single lesson ─────────────────────────────────────
// Same as attachAssetToLesson but semantically named for the replace flow.
export const replaceLessonAsset = attachAssetToLesson;

// ── Replace video for EVERY lesson that uses the given asset ──────────────
export async function replaceAssetEverywhere(
  oldAssetId: string,
  newAsset: VideoAsset,
): Promise<number> {
  const { data: affected, error: fetchErr } = await supabase
    .from('lessons')
    .select('id')
    .eq('video_asset_id', oldAssetId);
  if (fetchErr) throw fetchErr;
  if (!affected || affected.length === 0) return 0;

  const ids = affected.map((r: any) => r.id);
  const { error: updateErr } = await supabase
    .from('lessons')
    .update({
      video_asset_id:        newAsset.id,
      video_id:              newAsset.provider_video_id,
      video_title:           newAsset.title,
      video_type:            'vdocipher',
      video_status:          newAsset.status === 'ready' ? 'ready' : newAsset.status,
      video_duration_seconds: newAsset.duration_seconds ?? undefined,
      video_thumbnail_url:    newAsset.thumbnail_url ?? undefined,
    })
    .in('id', ids);
  if (updateErr) throw updateErr;
  return ids.length;
}

// ── Delete an asset — guarded by usage check ──────────────────────────────
// Returns { deleted: true } on success.
// Returns { deleted: false, lessonCount, usages } when still in use.
export async function deleteVideoAsset(assetId: string): Promise<
  | { deleted: true }
  | { deleted: false; lessonCount: number; usages: VideoAssetUsage[] }
> {
  const usages = await getVideoAssetUsage(assetId);
  if (usages.length > 0) {
    return { deleted: false, lessonCount: usages.length, usages };
  }

  const { error } = await supabase
    .from('video_assets')
    .delete()
    .eq('id', assetId);
  if (error) throw error;
  return { deleted: true };
}
