/**
 * implementations/internalCrash.ts
 * Internal crash reporting — logs to console and Supabase.
 */
import { supabase } from '@/client/supabase';
import type { CrashProvider, CrashBreadcrumb, CrashContext } from '../crashProvider';

class InternalCrashProvider implements CrashProvider {
  readonly providerKey = 'internal_crash';
  readonly displayName = 'Internal Logging';

  private breadcrumbs: CrashBreadcrumb[] = [];
  private userContext: CrashContext = {};

  async captureError(error: Error | string, context?: CrashContext): Promise<string | null> {
    const message = typeof error === 'string' ? error : error.message;
    const stack   = error instanceof Error ? error.stack : undefined;
    const id = `crash-${Date.now()}`;
    console.error('[CrashProvider]', message, stack);
    await supabase.from('crash_logs').insert({
      error_message: message,
      stack_trace: stack,
      context: { ...this.userContext, ...context },
      breadcrumbs: this.breadcrumbs.slice(-20),
    }).then(() => {});
    return id;
  }

  addBreadcrumb(breadcrumb: CrashBreadcrumb): void {
    this.breadcrumbs.push({ ...breadcrumb, timestamp: breadcrumb.timestamp ?? new Date().toISOString() });
    if (this.breadcrumbs.length > 50) this.breadcrumbs.shift();
  }

  setUser(context: CrashContext): void { this.userContext = context; }
  clearUser(): void { this.userContext = {}; }

  async flush(_timeoutMs?: number): Promise<boolean> { return true; }

  async checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'> {
    return 'healthy';
  }
}

export const internalCrashProvider = new InternalCrashProvider();
