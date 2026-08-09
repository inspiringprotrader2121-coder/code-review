/**
 * Whether adversarial verification should run.
 *
 * `ORVEX_VERIFY=0` disables verification in non-production only. Production
 * never publishes through a configuration-only verifier bypass; an emergency
 * rollback must deploy known code rather than silently weakening every plan.
 */
import type { ServerConfig } from './bootstrap/config.js';

/**
 * Runtime callers receive the immutable bootstrap snapshot explicitly.
 */
export function isVerificationEnabled(config: Pick<ServerConfig, 'verificationEnabled'>): boolean {
  return config.verificationEnabled;
}
