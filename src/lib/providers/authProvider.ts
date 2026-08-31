/**
 * authProvider.ts
 * Auth Provider Interface
 * Current: PHP JWT Auth
 */

export interface AuthUser {
  id: string;
  email?: string;
  phone?: string;
  role?: string;
  emailVerified: boolean;
  metadata?: Record<string, unknown>;
}

export interface AuthSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  user: AuthUser;
}

export interface AuthProvider {
  readonly providerKey: string;
  readonly displayName: string;

  /** Sign in with email + password */
  loginWithEmail(email: string, password: string): Promise<AuthSession>;

  /** Sign in with phone OTP */
  loginWithPhone(phone: string, otp: string): Promise<AuthSession>;

  /** Sign out */
  logout(): Promise<void>;

  /** Register a new user */
  register(options: {
    email?: string;
    phone?: string;
    password: string;
    metadata?: Record<string, unknown>;
  }): Promise<AuthSession>;

  /** Refresh an access token */
  refreshSession(refreshToken: string): Promise<AuthSession>;

  /** Trigger a password reset email */
  resetPassword(email: string): Promise<void>;

  /** Get the current session */
  getSession(): Promise<AuthSession | null>;

  /** Get user by ID (server-side only) */
  getUserById(userId: string): Promise<AuthUser | null>;

  /** Check provider health */
  checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'>;
}
