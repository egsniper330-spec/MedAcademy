/**
 * implementations/stubProviders.ts
 * Stub implementations for future providers (Email, SMS, Payment, AI).
 * These throw a clear error guiding devs to implement the real provider.
 * Register these so the system boots cleanly without real credentials.
 */
import type { EmailProvider, EmailMessage, EmailReceipt } from '../emailProvider';
import type { SmsProvider, SmsMessage, SmsReceipt } from '../smsProvider';
import type { PaymentProvider, PaymentIntent, RefundResult, WebhookVerification, Invoice } from '../paymentProvider';
import type { AiProvider, CompletionOptions, CompletionResult, EmbeddingResult } from '../aiProvider';

// ── Email Stub ────────────────────────────────────────────────────────────────
class StubEmailProvider implements EmailProvider {
  readonly providerKey = 'resend';
  readonly displayName = 'Resend (Not Configured)';
  private warn(op: string) { console.warn(`[EmailProvider:${op}] No email provider configured. Configure RESEND_API_KEY.`); }
  async sendVerification(to: string): Promise<EmailReceipt> { this.warn('sendVerification'); return { messageId: 'stub', status: 'failed', error: 'Not configured' }; }
  async sendPasswordReset(to: string): Promise<EmailReceipt> { this.warn('sendPasswordReset'); return { messageId: 'stub', status: 'failed', error: 'Not configured' }; }
  async sendAnnouncement(): Promise<EmailReceipt[]> { this.warn('sendAnnouncement'); return []; }
  async send(_msg: EmailMessage): Promise<EmailReceipt> { this.warn('send'); return { messageId: 'stub', status: 'failed', error: 'Not configured' }; }
  async checkHealth() { return 'unknown' as const; }
}

// ── SMS Stub ──────────────────────────────────────────────────────────────────
class StubSmsProvider implements SmsProvider {
  readonly providerKey = 'twilio';
  readonly displayName = 'Twilio (Not Configured)';
  private warn(op: string) { console.warn(`[SmsProvider:${op}] No SMS provider configured. Configure TWILIO_ACCOUNT_SID.`); }
  async sendOtp(to: string, code: string): Promise<SmsReceipt> { this.warn('sendOtp'); return { messageId: 'stub', status: 'failed', to, error: 'Not configured' }; }
  async sendVerification(to: string): Promise<SmsReceipt> { this.warn('sendVerification'); return { messageId: 'stub', status: 'failed', to, error: 'Not configured' }; }
  async send(msg: SmsMessage): Promise<SmsReceipt> { this.warn('send'); return { messageId: 'stub', status: 'failed', to: msg.to, error: 'Not configured' }; }
  async checkHealth() { return 'unknown' as const; }
}

// ── Payment Stub ──────────────────────────────────────────────────────────────
class StubPaymentProvider implements PaymentProvider {
  readonly providerKey = 'paymob';
  readonly displayName = 'Paymob (Not Configured)';
  private warn(op: string) { console.warn(`[PaymentProvider:${op}] No payment provider configured. Configure PAYMOB_API_KEY.`); }
  async createPayment(): Promise<PaymentIntent> { this.warn('createPayment'); throw new Error('Payment provider not configured'); }
  async refund(): Promise<RefundResult> { this.warn('refund'); throw new Error('Payment provider not configured'); }
  async verifyWebhook(): Promise<WebhookVerification> { return { valid: false, event: '', payload: {} }; }
  async verifyPayment(): Promise<PaymentIntent> { this.warn('verifyPayment'); throw new Error('Payment provider not configured'); }
  async getInvoice(): Promise<Invoice> { this.warn('getInvoice'); throw new Error('Payment provider not configured'); }
  async checkHealth() { return 'unknown' as const; }
}

// ── AI Stub ───────────────────────────────────────────────────────────────────
class StubAiProvider implements AiProvider {
  readonly providerKey = 'internal_ai';
  readonly displayName = 'Internal AI (Stub)';
  async complete(prompt: string, _opts?: CompletionOptions): Promise<CompletionResult> {
    console.warn('[AiProvider] Stub — configure an AI provider. Prompt received:', prompt.slice(0, 80));
    return { text: '[AI not configured]', model: 'stub', finishReason: 'stop' };
  }
  async embed(_text: string): Promise<EmbeddingResult> { return { vector: [], model: 'stub' }; }
  async classify(_text: string, categories: string[]): Promise<Record<string, number>> {
    return Object.fromEntries(categories.map((c) => [c, 0]));
  }
  async summarize(text: string): Promise<string> { return text.slice(0, 200); }
  async translate(text: string): Promise<string> { return text; }
  async checkHealth() { return 'healthy' as const; }
}

export const stubEmailProvider   = new StubEmailProvider();
export const stubSmsProvider     = new StubSmsProvider();
export const stubPaymentProvider = new StubPaymentProvider();
export const stubAiProvider      = new StubAiProvider();
