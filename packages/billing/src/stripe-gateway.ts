import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BillingClock } from './types.js';

export interface StripeGatewayConfig {
  readonly secretKey?: string;
  readonly webhookSecrets: readonly string[];
  readonly webhookToleranceSeconds: number;
}

/** Narrow Stripe HTTP adapter. Credentials, transport, and clock are all injected. */
export class StripeGateway {
  constructor(
    private readonly config: StripeGatewayConfig,
    private readonly http: typeof fetch,
    private readonly clock: BillingClock,
  ) {}

  configured(): boolean {
    return Boolean(this.config.secretKey);
  }
  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    return this.config.webhookSecrets.some((secret) =>
      verifyStripeSignature(
        rawBody,
        signature,
        secret,
        this.config.webhookToleranceSeconds,
        this.clock,
      ),
    );
  }
  createCheckout(
    params: Record<string, string>,
    idempotencyKey?: string,
  ): Promise<{ url?: string }> {
    return this.post('/v1/checkout/sessions', params, idempotencyKey);
  }
  createPortal(params: Record<string, string>): Promise<{ url?: string }> {
    return this.post('/v1/billing_portal/sessions', params);
  }
  getSubscription(
    subscriptionId: string,
  ): Promise<{ status?: string; current_period_start?: number; current_period_end?: number }> {
    return this.get(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }
  async cancelSubscription(subscriptionId: string): Promise<void> {
    const response = await this.request(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'DELETE',
    });
    if (!response.ok && response.status !== 404)
      throw new Error(
        `Stripe cancel ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`,
      );
  }
  private async post<T>(
    path: string,
    params: Record<string, string>,
    idempotencyKey?: string,
  ): Promise<T> {
    return parseStripeResponse<T>(
      await this.request(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: new URLSearchParams(params),
      }),
    );
  }
  private async get<T>(path: string): Promise<T> {
    return parseStripeResponse<T>(await this.request(path, { method: 'GET' }));
  }
  private async request(path: string, init: RequestInit): Promise<Response> {
    if (!this.config.secretKey) throw new Error('Stripe is not configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      return await this.http(`https://api.stripe.com${path}`, {
        ...init,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.config.secretKey}`, ...init.headers },
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

async function parseStripeResponse<T>(response: Response): Promise<T> {
  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error =
      typeof json === 'object' && json !== null && 'error' in json ? json.error : undefined;
    const message =
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof error.message === 'string'
        ? error.message
        : `Stripe request failed: ${response.status}`;
    throw new Error(message);
  }
  return json as T;
}

export function verifyStripeSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
  toleranceSeconds: number,
  clock: BillingClock,
): boolean {
  if (!signature || !secret) return false;
  let timestamp: string | undefined;
  const expected: string[] = [];
  for (const part of signature.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value) timestamp = value;
    if (key === 'v1' && value) expected.push(value);
  }
  if (!timestamp || expected.length === 0) return false;
  const t = Number(timestamp);
  if (!Number.isFinite(t) || Math.abs(clock.now().getTime() / 1_000 - t) > toleranceSeconds)
    return false;
  const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(digest);
  return expected.some((candidate) => {
    const b = Buffer.from(candidate);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

export function stripeId(value: string | { id?: string } | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.id;
}
