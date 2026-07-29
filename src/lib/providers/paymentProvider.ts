/**
 * paymentProvider.ts
 * Payment Provider Interface
 * Future: Paymob, Stripe, PayPal, Fawry, Meeza
 */

export interface PaymentIntent {
  id: string;
  amount: number;         // in smallest currency unit (piasters / cents)
  currency: string;       // ISO 4217 e.g. 'EGP' | 'USD'
  status: 'created' | 'pending' | 'completed' | 'failed' | 'refunded';
  paymentUrl?: string;    // redirect URL for hosted checkout
  clientSecret?: string;  // for SDK-based flows
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface RefundResult {
  refundId: string;
  status: 'pending' | 'completed' | 'failed';
  amount: number;
  reason?: string;
}

export interface WebhookVerification {
  valid: boolean;
  event: string;
  payload: Record<string, unknown>;
}

export interface Invoice {
  id: string;
  number: string;
  amount: number;
  currency: string;
  status: string;
  pdfUrl?: string;
  createdAt: string;
}

export interface PaymentProvider {
  readonly providerKey: string;
  readonly displayName: string;

  /** Create a payment intent / order */
  createPayment(options: {
    amount: number;
    currency: string;
    description?: string;
    customerId?: string;
    metadata?: Record<string, unknown>;
    returnUrl?: string;
  }): Promise<PaymentIntent>;

  /** Refund a payment */
  refund(paymentId: string, amount?: number, reason?: string): Promise<RefundResult>;

  /** Verify and parse an incoming webhook */
  verifyWebhook(rawBody: string, headers: Record<string, string>): Promise<WebhookVerification>;

  /** Verify a payment was completed */
  verifyPayment(paymentId: string): Promise<PaymentIntent>;

  /** Generate an invoice for a payment */
  getInvoice(paymentId: string): Promise<Invoice>;

  /** Check provider health */
  checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'>;
}
