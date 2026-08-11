import { FLEET_PROVIDER_BUCKETS } from '@orvex-review/config';
import type { ProviderCapacityPlan } from '@orvex-review/queue';
import type { ServerConfig } from './config.js';

/**
 * Build the only fleet capacity plan accepted by the Redis admission adapter.
 * Per-process limits remain in `providerConcurrency`; this plan is the shared
 * whole-fleet ceiling and is registered by the scheduler before workers start.
 */
export function providerCapacityPlanFor(
  config: Pick<ServerConfig, 'review'>,
): ProviderCapacityPlan {
  return Object.freeze({
    epoch: config.review.fleetProviderCapacityEpoch,
    tenantConcurrency: config.review.fleetTenantConcurrency,
    limits: Object.freeze(
      Object.fromEntries(
        FLEET_PROVIDER_BUCKETS.map((provider) => [
          provider,
          config.review.fleetProviderConcurrency(provider),
        ]),
      ),
    ),
  });
}
