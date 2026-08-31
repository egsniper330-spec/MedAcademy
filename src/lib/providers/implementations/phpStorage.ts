/**
 * implementations/phpStorage.ts
 * PHP Filesystem Storage implementation of StorageProvider.
 * All storage calls in the app go through this provider abstraction.
 */
import { backendClient } from '@/client/backendClient';
import type { StorageProvider, StorageUploadOptions } from '../storageProvider';

class PhpStorageProvider implements StorageProvider {
  readonly providerKey = 'php_storage';
  readonly displayName = 'PHP Filesystem Storage';

  async upload(bucket: string, path: string, data: Blob | ArrayBuffer, options?: StorageUploadOptions): Promise<string> {
    const { error } = await backendClient.storage.from(bucket).upload(path, data, {
      contentType: options?.contentType,
      cacheControl: options?.cacheControl ?? '3600',
      upsert: options?.upsert ?? false,
      metadata: options?.metadata,
    });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
    return path;
  }

  async delete(bucket: string, path: string): Promise<void> {
    const { error } = await backendClient.storage.from(bucket).remove([path]);
    if (error) throw new Error(`Storage delete failed: ${error.message}`);
  }

  async deleteMany(bucket: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const { error } = await backendClient.storage.from(bucket).remove(paths);
    if (error) throw new Error(`Storage deleteMany failed: ${error.message}`);
  }

  getPublicUrl(bucket: string, path: string): string {
    const { data } = backendClient.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  }

  async getSignedUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string> {
    const { data, error } = await backendClient.storage
      .from(bucket)
      .createSignedUrl(path, expiresInSeconds);
    if (error || !data?.signedUrl) throw new Error(`Signed URL failed: ${error?.message}`);
    return data.signedUrl;
  }

  async checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'> {
    try {
      await backendClient.storage.listBuckets();
      return 'healthy';
    } catch {
      return 'offline';
    }
  }
}

export const backendStorageProvider = new PhpStorageProvider();
