// ─────────────────────────────────────────────────────────────────────────────
// PHP Backend Adapter — Infrastructure Layer
// All application calls in this adapter route through the authoritative PHP client.
// ─────────────────────────────────────────────────────────────────────────────

import { backendClient } from '@/client/backendClient';
import type {
  AuthAdapter,
  AuthSession,
  BackendAdapter,
  DataAdapter,
  FunctionAdapter,
  StorageAdapter,
} from './types';

// ── Auth ──────────────────────────────────────────────────────────────────────

const phpAuth: AuthAdapter = {
  async getSession() {
    const { data, error } = await backendClient.auth.getSession();
    if (error) throw error;
    if (!data.session) return null;
    return {
      accessToken: data.session.access_token,
      user: {
        id: data.session.user.id,
        email: data.session.user.email ?? null,
        phone: data.session.user.phone ?? null,
      },
    };
  },

  onAuthStateChange(callback) {
    const { data } = backendClient.auth.onAuthStateChange((_event, session) => {
      callback(
        session
          ? {
              accessToken: session.access_token,
              user: {
                id: session.user.id,
                email: session.user.email ?? null,
                phone: session.user.phone ?? null,
              },
            }
          : null
      );
    });
    return () => data.subscription.unsubscribe();
  },

  async signInWithEmail(email, password) {
    const { data, error } = await backendClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return {
      accessToken: data.session!.access_token,
      user: {
        id: data.user!.id,
        email: data.user!.email ?? null,
        phone: data.user!.phone ?? null,
      },
    };
  },

  async signUpWithEmail(email, password) {
    const { data, error } = await backendClient.auth.signUp({ email, password });
    if (error) throw error;
    return {
      accessToken: data.session?.access_token ?? '',
      user: {
        id: data.user!.id,
        email: data.user!.email ?? null,
        phone: data.user!.phone ?? null,
      },
    };
  },

  async signOut() {
    const { error } = await backendClient.auth.signOut();
    if (error) throw error;
  },

  async resetPassword(email) {
    const { error } = await backendClient.auth.resetPasswordForEmail(email);
    if (error) throw error;
  },
};

// ── Storage ───────────────────────────────────────────────────────────────────

const phpStorage: StorageAdapter = {
  async upload(bucket, path, file, contentType) {
    const { error } = await backendClient.storage
      .from(bucket)
      .upload(path, file, { contentType, upsert: true });
    if (error) throw error;
    return phpStorage.getPublicUrl(bucket, path);
  },

  getPublicUrl(bucket, path) {
    const { data } = backendClient.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  },

  async remove(bucket, path) {
    const { error } = await backendClient.storage.from(bucket).remove([path]);
    if (error) throw error;
  },
};

// ── Functions ─────────────────────────────────────────────────────────────────

const phpFunctions: FunctionAdapter = {
  async invoke<T = unknown>(
    name: string,
    body: Record<string, unknown>,
    options?: { idempotencyKey?: string }
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (options?.idempotencyKey) headers['x-idempotency-key'] = options.idempotencyKey;

    const { data, error } = await backendClient.functions.invoke(name, {
      body,
      method: 'POST',
      headers,
    });

    if (error) {
      const msg = await error?.context?.text?.().catch(() => error.message);
      throw new Error(msg || error.message);
    }

    if (data && typeof data === 'object' && 'error' in data) {
      throw new Error((data as { error: string }).error);
    }

    return data as T;
  },
};

// ── Data ──────────────────────────────────────────────────────────────────────

const phpData: DataAdapter = {
  async rpc<T = unknown>(procedure: string, params?: Record<string, unknown>): Promise<T> {
    const { data, error } = await backendClient.rpc(procedure, params);
    if (error) throw error;
    return data as T;
  },
};

// ── Composed adapter ──────────────────────────────────────────────────────────

export const phpBackendAdapter: BackendAdapter = {
  auth: phpAuth,
  storage: phpStorage,
  functions: phpFunctions,
  data: phpData,
  appId: process.env.EXPO_PUBLIC_APP_ID ?? 'medacademy',
};
