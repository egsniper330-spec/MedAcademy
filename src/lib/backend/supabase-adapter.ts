// ─────────────────────────────────────────────────────────────────────────────
// Supabase Adapter — Infrastructure Layer
//
// This is the ONLY file in the application that imports from Supabase directly.
// All other application code uses BackendAdapter via src/lib/backend/index.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from '@/client/supabase';
import type {
  AuthAdapter,
  AuthSession,
  BackendAdapter,
  DataAdapter,
  FunctionAdapter,
  StorageAdapter,
} from './types';

// ── Auth ──────────────────────────────────────────────────────────────────────

const supabaseAuth: AuthAdapter = {
  async getSession() {
    const { data, error } = await supabase.auth.getSession();
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
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
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
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
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
    const { data, error } = await supabase.auth.signUp({ email, password });
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
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  },

  async resetPassword(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) throw error;
  },
};

// ── Storage ───────────────────────────────────────────────────────────────────

const supabaseStorage: StorageAdapter = {
  async upload(bucket, path, file, contentType) {
    const { error } = await supabase.storage
      .from(bucket)
      .upload(path, file, { contentType, upsert: true });
    if (error) throw error;
    return supabaseStorage.getPublicUrl(bucket, path);
  },

  getPublicUrl(bucket, path) {
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  },

  async remove(bucket, path) {
    const { error } = await supabase.storage.from(bucket).remove([path]);
    if (error) throw error;
  },
};

// ── Functions ─────────────────────────────────────────────────────────────────

const supabaseFunctions: FunctionAdapter = {
  async invoke<T = unknown>(
    name: string,
    body: Record<string, unknown>,
    options?: { idempotencyKey?: string }
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (options?.idempotencyKey) headers['x-idempotency-key'] = options.idempotencyKey;

    const { data, error } = await supabase.functions.invoke(name, {
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

const supabaseData: DataAdapter = {
  async rpc<T = unknown>(procedure: string, params?: Record<string, unknown>): Promise<T> {
    const { data, error } = await supabase.rpc(procedure, params);
    if (error) throw error;
    return data as T;
  },
};

// ── Composed adapter ──────────────────────────────────────────────────────────

export const supabaseAdapter: BackendAdapter = {
  auth: supabaseAuth,
  storage: supabaseStorage,
  functions: supabaseFunctions,
  data: supabaseData,
  appId: process.env.EXPO_PUBLIC_APP_ID ?? 'medacademy',
};
