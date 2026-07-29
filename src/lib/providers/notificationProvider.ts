/**
 * notificationProvider.ts
 * Notification Provider Interface
 * Current: Expo Push
 * Future: Firebase FCM, OneSignal, Huawei Push
 */

export interface NotificationPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  badge?: number;
  sound?: 'default' | 'none';
  channelId?: string;       // Android
  categoryId?: string;
  imageUrl?: string;
  ttl?: number;             // seconds
}

export interface NotificationReceipt {
  id: string;
  status: 'ok' | 'error';
  message?: string;
}

export interface ScheduledNotification {
  at: Date;
  payload: NotificationPayload;
  repeat?: 'daily' | 'weekly';
}

export interface NotificationProvider {
  readonly providerKey: string;
  readonly displayName: string;

  /** Send a notification to a single user by their push token */
  sendToUser(token: string, payload: NotificationPayload): Promise<NotificationReceipt>;

  /** Send to multiple tokens */
  sendToMany(tokens: string[], payload: NotificationPayload): Promise<NotificationReceipt[]>;

  /** Send to a named topic (all subscribed devices) */
  sendToTopic(topic: string, payload: NotificationPayload): Promise<NotificationReceipt>;

  /** Broadcast to all registered users */
  broadcast(payload: NotificationPayload): Promise<NotificationReceipt>;

  /** Schedule a future notification */
  schedule(token: string, notification: ScheduledNotification): Promise<string>;

  /** Cancel a scheduled notification */
  cancel(notificationId: string): Promise<void>;

  /** Check provider health */
  checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'>;
}
