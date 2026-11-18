/**
 * storageStats.ts — the doctor-facing storage summary used by the Storage hub.
 *
 * Extracted from the deleted upload engine so the (unrelated) storage screen keeps
 * working without the retired VdoCipher upload pipeline. It reads library rows that
 * still exist in the schema; it never contacts a video provider.
 */
import { backendClient } from '@/client/backendClient';

export interface DoctorStorageStats {
  totalVideos: number;
  totalBytes: number;
  avgFileSizeBytes: number;
  largestFileSizeBytes: number;
  largestFileName: string;
}

export async function getDoctorStorageStats(doctorId: string): Promise<DoctorStorageStats> {
  const { data } = await backendClient
    .from('video_assets')
    .select('file_size, file_name')
    .eq('doctor_id', doctorId);

  if (!data || data.length === 0) {
    return { totalVideos: 0, totalBytes: 0, avgFileSizeBytes: 0, largestFileSizeBytes: 0, largestFileName: '' };
  }
  const totalBytes = data.reduce((s: number, r: { file_size: number | null }) => s + (r.file_size ?? 0), 0);
  const largest = data.reduce((a: any, b: any) => ((b.file_size ?? 0) > (a.file_size ?? 0) ? b : a), data[0] as any);
  return {
    totalVideos: data.length,
    totalBytes,
    avgFileSizeBytes: Math.round(totalBytes / data.length),
    largestFileSizeBytes: largest?.file_size ?? 0,
    largestFileName: largest?.file_name ?? '',
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
