/**
 * smsProvider.ts
 * SMS Provider Interface
 * Future: Twilio, Vonage, Egyptian SMS Gateway
 */

export interface SmsMessage {
  to: string;   // E.164 format e.g. +201001234567
  body: string;
  from?: string;
  ttl?: number; // seconds (for OTP validity)
}

export interface SmsReceipt {
  messageId: string;
  status: 'queued' | 'sent' | 'failed';
  to: string;
  error?: string;
}

export interface SmsProvider {
  readonly providerKey: string;
  readonly displayName: string;

  /** Send an OTP code */
  sendOtp(to: string, code: string, expiryMinutes?: number): Promise<SmsReceipt>;

  /** Send a verification message */
  sendVerification(to: string, message: string): Promise<SmsReceipt>;

  /** Send a generic notification SMS */
  send(message: SmsMessage): Promise<SmsReceipt>;

  /** Check provider health */
  checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'>;
}
