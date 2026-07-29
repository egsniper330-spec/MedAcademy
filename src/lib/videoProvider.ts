/**
 * videoProvider.ts
 * Video Provider Abstraction Layer
 *
 * All video operations go through this interface. No module should call
 * VdoCipher (or any provider) APIs directly — use the provider registry.
 *
 * Adding a new provider:
 *   1. Create src/lib/providers/<name>.ts implementing VideoProvider
 *   2. Register it in providerRegistry below
 *   3. No DB, lesson, or UI changes required
 */

// ─── Core Types ───────────────────────────────────────────────────────────────

export type ProviderHealthStatus = 'online' | 'offline' | 'degraded' | 'maintenance' | 'unknown';

export interface ProviderInfo {
  key: string;          // e.g. 'medacademy'
  displayName: string;  // e.g. 'MedAcademy Video'
  supportsStreaming: boolean;
  supportsDRM: boolean;
  maxFileSizeGb: number;
}

export interface PlaybackToken {
  otp: string;
  playbackInfo: string;
  expiresAt?: number;
}

export interface VideoMetadata {
  providerVideoId: string;
  title?: string;
  duration?: number;        // seconds
  resolution?: string;      // e.g. '1920x1080'
  fileSize?: number;        // bytes
  status?: string;
  thumbnailUrl?: string;
  createdAt?: string;
  raw?: Record<string, unknown>;
}

export interface UploadTicket {
  uploadUrl: string;
  providerVideoId: string;
  fields?: Record<string, string>;
  expiresAt?: number;
}

export interface HealthCheckResult {
  accessible: boolean;
  playable: boolean;
  metadataValid: boolean;
  thumbnailPresent: boolean;
  durationValid: boolean;
  errors: string[];
  checkedAt: string;
}

export interface WebhookEvent {
  eventType: string;          // normalized: 'processing_complete' | 'upload_failed' etc.
  providerVideoId: string;
  rawPayload: Record<string, unknown>;
  timestamp: string;
}

// ─── Provider Interface ───────────────────────────────────────────────────────

export interface VideoProvider {
  readonly info: ProviderInfo;

  /** Generate a secure playback token for a video */
  generatePlaybackToken(
    providerVideoId: string,
    userId: string,
    options?: { watermark?: string; domain?: string }
  ): Promise<PlaybackToken>;

  /** Create an upload ticket (presigned URL or upload session) */
  createUploadTicket(options: {
    title: string;
    mimeType?: string;
    fileSizeBytes?: number;
  }): Promise<UploadTicket>;

  /** Delete a video from the provider */
  deleteVideo(providerVideoId: string): Promise<void>;

  /** Get video metadata from the provider */
  getMetadata(providerVideoId: string): Promise<VideoMetadata>;

  /** Get video processing/encoding status */
  getStatus(providerVideoId: string): Promise<string>;

  /** Trigger re-processing / re-encoding */
  retryProcessing(providerVideoId: string): Promise<void>;

  /** Generate or retrieve a thumbnail URL */
  getThumbnailUrl(providerVideoId: string): Promise<string | null>;

  /** Run a health check on a specific video */
  healthCheck(providerVideoId: string): Promise<HealthCheckResult>;

  /** Check provider service health */
  checkProviderHealth(): Promise<ProviderHealthStatus>;

  /** Verify a webhook request signature and parse the event */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string>
  ): Promise<WebhookEvent | null>;
}

// ─── Provider Registry ────────────────────────────────────────────────────────

const registry = new Map<string, VideoProvider>();

export function registerProvider(provider: VideoProvider): void {
  registry.set(provider.info.key, provider);
}

export function getProvider(key: string): VideoProvider {
  const p = registry.get(key);
  if (!p) throw new Error(`Video provider "${key}" is not registered.`);
  return p;
}

export function getDefaultProvider(): VideoProvider {
  // Default is always 'medacademy'
  return getProvider('medacademy');
}

export function listProviders(): ProviderInfo[] {
  return Array.from(registry.values()).map((p) => p.info);
}

export function isProviderRegistered(key: string): boolean {
  return registry.has(key);
}
