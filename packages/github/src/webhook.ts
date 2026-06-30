import { createHmac, timingSafeEqual } from 'node:crypto';
import type { GitHubAppConfig } from './types.js';

export function verifyWebhookSignature(
  config: GitHubAppConfig,
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  if (!config.webhookSecret) {
    console.warn('[webhook] GITHUB_WEBHOOK_SECRET not set — skipping signature verify (dev only)');
    return true;
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
