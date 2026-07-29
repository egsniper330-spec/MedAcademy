/**
 * crashProvider.ts
 * Crash Reporting Provider Interface
 * Current: Internal Logging
 * Future: Sentry, Crashlytics, Bugsnag, Rollbar
 */

export interface CrashBreadcrumb {
  category: string;
  message: string;
  level?: 'debug' | 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
  timestamp?: string;
}

export interface CrashContext {
  userId?: string;
  email?: string;
  extra?: Record<string, unknown>;
  tags?: Record<string, string>;
}

export interface CrashProvider {
  readonly providerKey: string;
  readonly displayName: string;

  /** Capture an error */
  captureError(error: Error | string, context?: CrashContext): Promise<string | null>;

  /** Add a breadcrumb (trail of events) */
  addBreadcrumb(breadcrumb: CrashBreadcrumb): void;

  /** Set user context */
  setUser(context: CrashContext): void;

  /** Clear user context (on logout) */
  clearUser(): void;

  /** Flush pending events */
  flush(timeoutMs?: number): Promise<boolean>;

  /** Check provider health */
  checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'>;
}
