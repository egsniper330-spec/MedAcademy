/**
 * storageProvider.ts
 * Storage Provider Interface
 * Current: PHP filesystem storage
 * Future: AWS S3, Cloudflare R2, GCS, Azure Blob, MinIO
 */

export type ProviderHealthStatus = 'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown';

export interface StorageUploadOptions {
  contentType?: string;
  cacheControl?: string;
  upsert?: boolean;
  metadata?: Record<string, string>;
}

export interface StorageFileMetadata {
  path: string;
  size: number;
  contentType: string;
  lastModified: string;
  etag?: string;
  metadata?: Record<string, string>;
}

export interface StorageProvider {
  readonly providerKey: string;
  readonly displayName: string;

  /** Upload a file — returns the storage path */
  upload(bucket: string, path: string, data: Blob | ArrayBuffer, options?: StorageUploadOptions): Promise<string>;

  /** Delete a file */
  delete(bucket: string, path: string): Promise<void>;

  /** Delete multiple files */
  deleteMany(bucket: string, paths: string[]): Promise<void>;

  /** Get a public URL (no expiry) */
  getPublicUrl(bucket: string, path: string): string;

  /** Get a signed URL with expiry */
  getSignedUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string>;

  /** Check provider health */
  checkHealth(): Promise<ProviderHealthStatus>;
}
