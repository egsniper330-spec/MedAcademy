// ─────────────────────────────────────────────────────────────────────────────
// Type definitions matching @supabase/supabase-js for compatibility
// These replace the Supabase types after migration to PHP backend.
// ─────────────────────────────────────────────────────────────────────────────

export interface Session {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  user: {
    id: string;
    email?: string | null;
    phone?: string | null;
    role?: string;
    aud?: string;
    app_metadata?: Record<string, unknown>;
    user_metadata?: Record<string, unknown>;
    created_at?: string;
  };
}

export interface RealtimeChannel {
  on(
    event: string,
    opts: { event?: string; table?: string; schema?: string; filter?: string },
    callback: (payload: { eventType: string; new: unknown; old: unknown }) => void
  ): RealtimeChannel;
  subscribe(callback?: (status: string) => void): RealtimeChannel;
  unsubscribe(): Promise<string>;
}
