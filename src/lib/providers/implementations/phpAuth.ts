/**
 * implementations/phpAuth.ts
 * PHP JWT Auth implementation of AuthProvider.
 */
import { backendClient } from '@/client/backendClient';
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

class PhpAuthProvider implements AuthProvider {
  readonly providerKey = 'php_auth';
  readonly displayName = 'PHP JWT Auth';

  async loginWithEmail(email: string, password: string): Promise<AuthSession> {
    const { data, error } = await backendClient.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(error?.message ?? 'Login failed');
    return mapSession(data.session);
  }

  async loginWithPhone(phone: string, otp: string): Promise<AuthSession> {
    const { data, error } = await backendClient.auth.verifyOtp({ phone, token: otp, type: 'sms' });
    if (error || !data.session) throw new Error(error?.message ?? 'OTP verification failed');
    return mapSession(data.session);
  }

  async logout(): Promise<void> {
    await backendClient.auth.signOut();
  }

  async register(options: {
    email?: string; phone?: string; password: string; metadata?: Record<string, unknown>;
  }): Promise<AuthSession> {
    const params: any = { password: options.password, options: { data: options.metadata } };
    if (options.email) params.email = options.email;
    if (options.phone) params.phone = options.phone;
    const { data, error } = await backendClient.auth.signUp(params);
    if (error || !data.session) throw new Error(error?.message ?? 'Registration failed');
    return mapSession(data.session);
  }

  async refreshSession(refreshToken: string): Promise<AuthSession> {
    const { data, error } = await backendClient.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) throw new Error(error?.message ?? 'Token refresh failed');
    return mapSession(data.session);
  }

  async resetPassword(email: string): Promise<void> {
    const { error } = await backendClient.auth.resetPasswordForEmail(email);
    if (error) throw new Error(error.message);
  }

  async getSession(): Promise<AuthSession | null> {
    const { data } = await backendClient.auth.getSession();
    if (!data.session) return null;
    return mapSession(data.session);
  }

  async getUserById(userId: string): Promise<AuthUser | null> {
    const { data } = await backendClient.from('profiles').select('id,email,role').eq('id', userId).single();
    if (!data) return null;
    return { id: data.id, email: data.email, role: data.role, emailVerified: true };
  }

  async checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'> {
    try {
      const { error } = await backendClient.auth.getSession();
      return error ? 'warning' : 'healthy';
    } catch {
      return 'offline';
    }
  }
}

export const backendAuthProvider = new PhpAuthProvider();
