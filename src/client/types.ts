// ─────────────────────────────────────────────────────────────────────────────
// Shared session and polling contracts for the PHP-backed application client.
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

export interface PollingChannel {
  on(
    event: string,
    opts: { event?: string; table?: string; schema?: string; filter?: string },
    callback: (payload: { eventType: string; new: unknown; old: unknown }) => void
  ): PollingChannel;
  subscribe(callback?: (status: string) => void): PollingChannel;
  unsubscribe(): Promise<string>;
}
