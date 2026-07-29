/**
 * implementations/internalAnalytics.ts
 * Internal analytics implementation — logs events to Supabase.
 */
import { supabase } from '@/client/supabase';
import type { AnalyticsProvider, AnalyticsEvent, UserTraits } from '../analyticsProvider';

class InternalAnalyticsProvider implements AnalyticsProvider {
  readonly providerKey = 'internal_analytics';
  readonly displayName = 'Internal Analytics';

  async track(userId: string, event: AnalyticsEvent): Promise<void> {
    await supabase.from('analytics_events').insert({
      user_id: userId,
      event_name: event.name,
      properties: event.properties ?? {},
      occurred_at: event.timestamp ?? new Date().toISOString(),
    }).then(() => {});
  }

  async identify(userId: string, traits: UserTraits): Promise<void> {
    await supabase.from('profiles').update({
      analytics_traits: traits,
    }).eq('id', userId).then(() => {});
  }

  async page(userId: string, screenName: string, properties?: Record<string, unknown>): Promise<void> {
    await this.track(userId, { name: 'screen_view', properties: { screen: screenName, ...properties } });
  }

  async group(userId: string, groupId: string, traits?: Record<string, unknown>): Promise<void> {
    await this.track(userId, { name: 'group', properties: { group_id: groupId, ...traits } });
  }

  async reset(_userId: string): Promise<void> { /* no-op for internal */ }

  async checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'> {
    return 'healthy';
  }
}

export const internalAnalyticsProvider = new InternalAnalyticsProvider();
