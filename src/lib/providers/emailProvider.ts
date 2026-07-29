/**
 * emailProvider.ts
 * Email Provider Interface
 * Future: Resend, SendGrid, Amazon SES, Mailgun, SMTP
 */

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailMessage {
  to: EmailAddress | EmailAddress[];
  from?: EmailAddress;
  replyTo?: EmailAddress;
  subject: string;
  html?: string;
  text?: string;
  templateId?: string;
  templateData?: Record<string, unknown>;
  attachments?: Array<{
    filename: string;
    content: string; // base64
    contentType: string;
  }>;
  tags?: string[];
}

export interface EmailReceipt {
  messageId: string;
  status: 'queued' | 'sent' | 'failed';
  error?: string;
}

export interface EmailProvider {
  readonly providerKey: string;
  readonly displayName: string;

  /** Send an email verification link */
  sendVerification(to: string, verificationUrl: string, name?: string): Promise<EmailReceipt>;

  /** Send a password reset email */
  sendPasswordReset(to: string, resetUrl: string, name?: string): Promise<EmailReceipt>;

  /** Send an announcement to a list of recipients */
  sendAnnouncement(recipients: string[], subject: string, html: string): Promise<EmailReceipt[]>;

  /** Send a system / transactional email */
  send(message: EmailMessage): Promise<EmailReceipt>;

  /** Check provider health */
  checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'>;
}
