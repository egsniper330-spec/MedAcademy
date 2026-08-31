// ─────────────────────────────────────────────────────────────────────────────
// Backend Abstraction — Contracts
//
// The application layer depends ONLY on these interfaces.
// Swapping the backend provider requires implementing another adapter and
// updating backend/index.ts; application code does not change.
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string | null;
  phone: string | null;
}

export interface AuthSession {
  accessToken: string;
  user: AuthUser;
}

export interface AuthAdapter {
  /** Returns the current session or null. */
  getSession(): Promise<AuthSession | null>;
  /** Subscribes to auth state changes. Returns an unsubscribe function. */
  onAuthStateChange(callback: (session: AuthSession | null) => void): () => void;
  /** Sign in with email + password. */
  signInWithEmail(email: string, password: string): Promise<AuthSession>;
  /** Register with email + password. */
  signUpWithEmail(email: string, password: string): Promise<AuthSession>;
  /** Sign out the current user. */
  signOut(): Promise<void>;
  /** Send a password-reset email. */
  resetPassword(email: string): Promise<void>;
}

export interface StorageAdapter {
  /** Upload a file and return its public URL. */
  upload(bucket: string, path: string, file: Blob | ArrayBuffer, contentType?: string): Promise<string>;
  /** Return the public URL for a stored object. */
  getPublicUrl(bucket: string, path: string): string;
  /** Delete a stored object. */
  remove(bucket: string, path: string): Promise<void>;
}

export interface FunctionAdapter {
  /** Invoke a named server-side function. */
  invoke<T = unknown>(
    name: string,
    body: Record<string, unknown>,
    options?: { idempotencyKey?: string }
  ): Promise<T>;
}

// Data adapter is intentionally thin — complex queries live in api.ts,
// which composes the adapters above. Add query helpers only when they
// represent a reusable cross-cutting concern (e.g. pagination, retry).
export interface DataAdapter {
  /** Execute a named remote procedure call. */
  rpc<T = unknown>(procedure: string, params?: Record<string, unknown>): Promise<T>;
}

export interface BackendAdapter {
  readonly auth: AuthAdapter;
  readonly storage: StorageAdapter;
  readonly functions: FunctionAdapter;
  readonly data: DataAdapter;
  /** The stable, backend-agnostic app identifier. */
  readonly appId: string;
}
