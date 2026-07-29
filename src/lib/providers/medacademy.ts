/**
 * src/lib/providers/medacademy.ts
 * MedAcademy Video Provider
 *
 * Implements VideoProvider using VdoCipher internally.
 * NO code outside this file or Edge Functions should reference VdoCipher.
 * All UI/API shows "MedAcademy Video" branding only.
 */

import { supabase } from '@/client/supabase';
import type {
  VideoProvider, ProviderInfo, PlaybackToken, UploadTicket,
  VideoMetadata, HealthCheckResult, ProviderHealthStatus, WebhookEvent,
} from '../videoProvider';

class MedAcademyVideoProvider implements VideoProvider {
  readonly info: ProviderInfo = {
    key: 'medacademy',
    displayName: 'MedAcademy Video',
    supportsStreaming: true,
    supportsDRM: true,
    maxFileSizeGb: 5,
  };

  /**
   * Generate a secure playback token.
   * Calls the server-side Edge Function — secrets never leave the server.
   * userId is extracted from the JWT by requireAuth() in the Edge Function;
   * the body only needs video_id and lesson_id (for enrollment / draft guards).
   */
  async generatePlaybackToken(
    providerVideoId: string,
    _userId: string,
    options?: { lessonId?: string; domain?: string },
  ): Promise<PlaybackToken> {
    const { data, error } = await supabase.functions.invoke('vdocipher-otp', {
      body: {
        video_id:  providerVideoId,
        lesson_id: options?.lessonId ?? null,
      },
    });
    if (error) throw new Error(`Playback token failed: ${error.message}`);
    return { otp: data.otp, playbackInfo: data.playbackInfo };
  }

  /**
   * Create an upload ticket via the health-scan edge function.
   * Returns a presigned upload URL issued by the underlying provider.
   */
  async createUploadTicket(options: {
    title: string;
    mimeType?: string;
    fileSizeBytes?: number;
  }): Promise<UploadTicket> {
    const { data, error } = await supabase.functions.invoke('video-health-scan', {
      body: { action: 'create_upload_ticket', ...options },
    });
    if (error) throw new Error(`Upload ticket failed: ${error.message}`);
    return data;
  }

  async deleteVideo(providerVideoId: string): Promise<void> {
    const { error } = await supabase.functions.invoke('video-health-scan', {
      body: { action: 'delete_video', provider_video_id: providerVideoId },
    });
    if (error) throw new Error(`Delete failed: ${error.message}`);
  }

  async getMetadata(providerVideoId: string): Promise<VideoMetadata> {
    const { data, error } = await supabase.functions.invoke('video-health-scan', {
      body: { action: 'get_metadata', provider_video_id: providerVideoId },
    });
    if (error) throw new Error(`Metadata fetch failed: ${error.message}`);
    return data;
  }

  async getStatus(providerVideoId: string): Promise<string> {
    const meta = await this.getMetadata(providerVideoId);
    return meta.status ?? 'unknown';
  }

  async retryProcessing(providerVideoId: string): Promise<void> {
    const { error } = await supabase.functions.invoke('video-health-scan', {
      body: { action: 'retry_processing', provider_video_id: providerVideoId },
    });
    if (error) throw new Error(`Retry failed: ${error.message}`);
  }

  async getThumbnailUrl(providerVideoId: string): Promise<string | null> {
    try {
      const meta = await this.getMetadata(providerVideoId);
      return meta.thumbnailUrl ?? null;
    } catch {
      return null;
    }
  }

  async healthCheck(providerVideoId: string): Promise<HealthCheckResult> {
    const { data, error } = await supabase.functions.invoke('video-health-scan', {
      body: { action: 'health_check', provider_video_id: providerVideoId },
    });
    if (error) throw new Error(`Health check failed: ${error.message}`);
    return data;
  }

  async checkProviderHealth(): Promise<ProviderHealthStatus> {
    try {
      const { data, error } = await supabase.functions.invoke('video-health-scan', {
        body: { action: 'provider_health' },
      });
      if (error) return 'degraded';
      return data?.status ?? 'unknown';
    } catch {
      return 'offline';
    }
  }

  async verifyWebhook(
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<WebhookEvent | null> {
    // Webhook verification is handled server-side in the Edge Function
    // This client-side stub is a no-op
    return null;
  }
}

export const medAcademyProvider = new MedAcademyVideoProvider();
