/**
 * implementations/expoNotifications.ts
 * Expo Push Notifications implementation of NotificationProvider.
 * All notification sends go through this — never call Expo Push API directly.
 * Token registration / permission handling stays in the app; this handles delivery.
 */
import { backendClient } from '@/client/backendClient';
import type {
  NotificationProvider, NotificationPayload,
  NotificationReceipt, ScheduledNotification,
} from '../notificationProvider';

const EXPO_PUSH_API = 'https://exp.host/--/api/v2/push/send';

class ExpoNotificationProvider implements NotificationProvider {
  readonly providerKey = 'expo_push';
  readonly displayName = 'Expo Push';

  private buildMessage(token: string, payload: NotificationPayload) {
    return {
      to: token,
      title: payload.title,
      body: payload.body,
      data: payload.data ?? {},
      badge: payload.badge,
      sound: payload.sound ?? 'default',
      channelId: payload.channelId,
      categoryIdentifier: payload.categoryId,
      ttl: payload.ttl,
      ...(payload.imageUrl ? { richContent: { image: payload.imageUrl } } : {}),
    };
  }

  async sendToUser(token: string, payload: NotificationPayload): Promise<NotificationReceipt> {
    const receipts = await this.sendToMany([token], payload);
    return receipts[0];
  }

  async sendToMany(tokens: string[], payload: NotificationPayload): Promise<NotificationReceipt[]> {
    if (tokens.length === 0) return [];
    // Expo push accepts up to 100 messages per request
    const chunks: string[][] = [];
    for (let i = 0; i < tokens.length; i += 100) chunks.push(tokens.slice(i, i + 100));

    const results: NotificationReceipt[] = [];
    for (const chunk of chunks) {
      const messages = chunk.map((t) => this.buildMessage(t, payload));
      try {
        const res = await fetch(EXPO_PUSH_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(messages),
        });
        const json = await res.json();
        const data: any[] = json.data ?? [];
        data.forEach((r, i) => {
          results.push({
            id: r.id ?? `${Date.now()}-${i}`,
            status: r.status === 'ok' ? 'ok' : 'error',
            message: r.message,
          });
        });
      } catch (e) {
        chunk.forEach(() => results.push({ id: '', status: 'error', message: String(e) }));
      }
    }
    return results;
  }

  async sendToTopic(topic: string, payload: NotificationPayload): Promise<NotificationReceipt> {
    // Expo doesn't have native topics — look up tokens subscribed to this topic
    const { data: devices } = await backendClient
      .from('devices')
      .select('push_token')
      .eq('notification_topic', topic)
      .not('push_token', 'is', null);
    const tokens = (devices ?? []).map((d: any) => d.push_token).filter(Boolean);
    const receipts = await this.sendToMany(tokens, payload);
    return receipts[0] ?? { id: '', status: 'ok' };
  }

  async broadcast(payload: NotificationPayload): Promise<NotificationReceipt> {
    const { data: devices } = await backendClient
      .from('devices')
      .select('push_token')
      .not('push_token', 'is', null)
      .eq('is_active', true);
    const tokens = (devices ?? []).map((d: any) => d.push_token).filter(Boolean);
    const receipts = await this.sendToMany(tokens, payload);
    return receipts[0] ?? { id: '', status: 'ok' };
  }

  async schedule(_token: string, _notification: ScheduledNotification): Promise<string> {
    // Expo doesn't support server-side scheduling — use a PHP scheduler or explicit server-side job
    console.warn('[ExpoNotificationProvider] schedule() is not implemented server-side; configure a PHP/cPanel scheduler if needed.');
    return `scheduled-${Date.now()}`;
  }

  async cancel(_notificationId: string): Promise<void> {
    // No-op for Expo push (no cancellation API)
  }

  async checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'> {
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [] }),
      });
      return res.ok ? 'healthy' : 'warning';
    } catch {
      return 'offline';
    }
  }
}

export const expoNotificationProvider = new ExpoNotificationProvider();
