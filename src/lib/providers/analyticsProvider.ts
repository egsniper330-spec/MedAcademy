/**
 * analyticsProvider.ts
 * Analytics Provider Interface
 * Current: Internal (Supabase-backed)
 * Future: Firebase Analytics, PostHog, Mixpanel, Amplitude
 */

export interface AnalyticsEvent {
  name: string;
  properties?: Record<string, unknown>;
  timestamp?: string;
}

export interface UserTraits {
  email?: string;
  name?: string;
  role?: string;
  plan?: string;
  [key: string]: unknown;
}

export interface AnalyticsProvider {
  readonly providerKey: string;
  readonly displayName: string;

  /** Track an event */
  track(userId: string, event: AnalyticsEvent): Promise<void>;

  /** Identify a user with traits */
  identify(userId: string, traits: UserTraits): Promise<void>;

  /** Track a page/screen view */
  page(userId: string, screenName: string, properties?: Record<string, unknown>): Promise<void>;

  /** Group a user into an account/org */
  group(userId: string, groupId: string, traits?: Record<string, unknown>): Promise<void>;

  /** Reset user identity (on logout) */
  reset(userId: string): Promise<void>;

  /** Check provider health */
  checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'>;
}
