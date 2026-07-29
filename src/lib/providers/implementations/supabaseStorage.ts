/**
 * implementations/supabaseStorage.ts
 * Supabase Storage implementation of StorageProvider.
 * All storage calls in the app go through this — never call supabase.storage directly.
 */
import { supabase } from '@/client/supabase';
import type { StorageProvider, StorageUploadOptions, StorageFileMetadata } from '../storageProvider';

class SupabaseStorageProvider implements StorageProvider {
  readonly providerKey = 'supabase_storage';
  readonly displayName = 'Supabase Storage';

  async upload(bucket: string, path: string, data: Blob | ArrayBuffer, options?: StorageUploadOptions): Promise<string> {
    const { error } = await supabase.storage.from(bucket).upload(path, data, {
      contentType: options?.contentType,
      cacheControl: options?.cacheControl ?? '3600',
      upsert: options?.upsert ?? false,
      metadata: options?.metadata,
    });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
    return path;
  }

  async delete(bucket: string, path: string): Promise<void> {
    const { error } = await supabase.storage.from(bucket).remove([path]);
    if (error) throw new Error(`Storage delete failed: ${error.message}`);
  }

  async deleteMany(bucket: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const { error } = await supabase.storage.from(bucket).remove(paths);
    if (error) throw new Error(`Storage deleteMany failed: ${error.message}`);
  }

  async move(bucket: string, fromPath: string, toPath: string): Promise<void> {
    const { error } = await supabase.storage.from(bucket).move(fromPath, toPath);
    if (error) throw new Error(`Storage move failed: ${error.message}`);
  }

  async copy(bucket: string, fromPath: string, toPath: string): Promise<void> {
    const { error } = await supabase.storage.from(bucket).copy(fromPath, toPath);
    if (error) throw new Error(`Storage copy failed: ${error.message}`);
  }

  getPublicUrl(bucket: string, path: string): string {
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  }

  async getSignedUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string> {
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(path, expiresInSeconds);
    if (error || !data?.signedUrl) throw new Error(`Signed URL failed: ${error?.message}`);
    return data.signedUrl;
  }

  async getMetadata(bucket: string, path: string): Promise<StorageFileMetadata> {
    const { data, error } = await supabase.storage.from(bucket).list(
      path.split('/').slice(0, -1).join('/'),
      { search: path.split('/').pop() },
    );
    if (error || !data?.[0]) throw new Error(`Metadata fetch failed: ${error?.message}`);
    const f = data[0];
    return {
      path,
      size: f.metadata?.size ?? 0,
      contentType: f.metadata?.mimetype ?? 'application/octet-stream',
      lastModified: f.updated_at ?? f.created_at ?? new Date().toISOString(),
      etag: f.metadata?.eTag,
    };
  }

  async list(bucket: string, prefix?: string): Promise<StorageFileMetadata[]> {
    const { data, error } = await supabase.storage.from(bucket).list(prefix ?? '');
    if (error) throw new Error(`Storage list failed: ${error.message}`);
    return (data ?? []).map((f) => ({
      path: `${prefix ?? ''}/${f.name}`.replace(/^\//, ''),
      size: f.metadata?.size ?? 0,
      contentType: f.metadata?.mimetype ?? 'application/octet-stream',
      lastModified: f.updated_at ?? f.created_at ?? new Date().toISOString(),
    }));
  }

  async checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'> {
    try {
      await supabase.storage.listBuckets();
      return 'healthy';
    } catch {
      return 'offline';
    }
  }
}

export const supabaseStorageProvider = new SupabaseStorageProvider();
