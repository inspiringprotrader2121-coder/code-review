import { createHmac, timingSafeEqual } from 'node:crypto';
import type { GitHubAppConfig } from './types.js';

export function verifyWebhookSignature(
  config: GitHubAppConfig,
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  if (!config.webhookSecret) {
    // FAIL CLOSED: with no secret we can't verify signatures, so an unsigned
    // request could forge any event (spoof author_association:OWNER → drive
    // commits/reviews). Reject by default; only accept unsigned in explicit dev
    // via ORVEX_ALLOW_UNSIGNED_WEBHOOKS=1.
    if (process.env.ORVEX_ALLOW_UNSIGNED_WEBHOOKS === '1') {
      console.warn('[webhook] GITHUB_WEBHOOK_SECRET not set — accepting unsigned (ORVEX_ALLOW_UNSIGNED_WEBHOOKS=1)');
      return true;
    }
    console.error('[webhook] GITHUB_WEBHOOK_SECRET not set — REJECTING (set the secret, or ORVEX_ALLOW_UNSIGNED_WEBHOOKS=1 for local dev)');
    return false;
  }
  if (!signatureHeader?.startsWith('sha256=')) {
    return false;
  }

  const expected = createHmac('sha256', config.webhookSecret)
    .update(rawBody)
    .digest('hex');
  const received = signatureHeader.slice('sha256='.length);

  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  } catch {
    return false;
  }
}
