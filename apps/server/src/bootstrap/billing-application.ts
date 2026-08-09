import { createBillingApplication, type BillingStore } from '@orvex-review/billing';
import { sendOperationalAlert } from '../alerts.js';
import type { ServerConfig } from './config.js';

/** Server composition adapter. The billing package has no server/global dependencies. */
export function createServerBillingApplication(
  store: BillingStore,
  config: Pick<ServerConfig, 'billing' | 'billingCatalog' | 'alerts'>,
) {
  return createBillingApplication(store, config.billing, config.billingCatalog, {
    // Resolve the process transport at request time. The package still receives
    // an explicit port, while server test/observability shims remain effective.
    http: (...args) => globalThis.fetch(...args),
    clock: { now: () => new Date() },
    alert: (input) => sendOperationalAlert(input, config.alerts.webhookUrl),
    logger: {
      info: (message) => console.log(message),
      warn: (message) => console.warn(message),
      error: (message) => console.error(message),
    },
  });
}
