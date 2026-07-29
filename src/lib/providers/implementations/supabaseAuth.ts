/**
 * implementations/supabaseAuth.ts
 * Supabase Auth implementation of AuthProvider.
 */
import { supabase } from '@/client/supabase';
import type { AuthProvider, AuthUser, AuthSession } from '../authProvider';

function mapSession(session: any): AuthSession {
  return {
    accessToken: session.access_token ?? '',
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at ?? 0,
    user: {
      id: session.user.id,
      email: session.user.email,
      phone: session.user.phone,
      emailVerified: !!session.user.email_confirmed_at,
      metadata: session.user.user_metadata,
    },
  };
}

class SupabaseAuthProvider implements AuthProvider {
  readonly providerKey = 'supabase_auth';
  readonly displayName = 'Supabase Auth';

  async loginWithEmail(email: string, password: string): Promise<AuthSession> {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(error?.message ?? 'Login failed');
    return mapSession(data.session);
  }

  async loginWithPhone(phone: string, otp: string): Promise<AuthSession> {
    const { data, error } = await supabase.auth.verifyOtp({ phone, token: otp, type: 'sms' });
    if (error || !data.session) throw new Error(error?.message ?? 'OTP verification failed');
    return mapSession(data.session);
  }

  async loginWithOAuth(provider: string): Promise<AuthSession> {
    const { error } = await supabase.auth.signInWithOAuth({ provider: provider as any });
    if (error) throw new Error(error.message);
    // OAuth redirect — session returned via callback
    return {} as AuthSession;
  }

  async logout(): Promise<void> {
    await supabase.auth.signOut();
  }

  async register(options: {
    email?: string; phone?: string; password: string; metadata?: Record<string, unknown>;
  }): Promise<AuthSession> {
    const params: any = { password: options.password, options: { data: options.metadata } };
    if (options.email) params.email = options.email;
    if (options.phone) params.phone = options.phone;
    const { data, error } = await supabase.auth.signUp(params);
    if (error || !data.session) throw new Error(error?.message ?? 'Registration failed');
    return mapSession(data.session);
  }

  async refreshSession(refreshToken: string): Promise<AuthSession> {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) throw new Error(error?.message ?? 'Token refresh failed');
    return mapSession(data.session);
  }

  async resetPassword(email: string): Promise<void> {
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) throw new Error(error.message);
  }

  async getSession(): Promise<AuthSession | null> {
    const { data } = await supabase.auth.getSession();
    if (!data.session) return null;
    return mapSession(data.session);
  }

  async getUserById(userId: string): Promise<AuthUser | null> {
    const { data } = await supabase.from('profiles').select('id,email,role').eq('id', userId).single();
    if (!data) return null;
    return { id: data.id, email: data.email, role: data.role, emailVerified: true };
  }

  async checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'> {
    try {
      const { error } = await supabase.auth.getSession();
      return error ? 'warning' : 'healthy';
    } catch {
      return 'offline';
    }
  }
}

export const supabaseAuthProvider = new SupabaseAuthProvider();
