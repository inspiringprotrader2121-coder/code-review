/**
 * Whether adversarial verification should run.
 *
 * `ORVEX_VERIFY=0` disables verification in non-production only. Production
 * never publishes through a configuration-only verifier bypass; an emergency
 * rollback must deploy known code rather than silently weakening every plan.
 */
export function isVerificationEnabled(): boolean {
  const production =
    process.env.NODE_ENV === 'production' || process.env.ORVEX_ENV === 'production';
  if (production) return true;
  return process.env.ORVEX_VERIFY !== '0';
}
