/**
 * Whether adversarial verification should run.
 *
 * `ORVEX_VERIFY=0` disables verification in non-production. In production
 * (`NODE_ENV=production` or `ORVEX_ENV=production`) that disable is ignored
 * unless `ORVEX_VERIFY_FORCE_OFF=1` is also set — a mis-set env must not silently
 * ship unverified findings/fixes.
 */
export function isVerificationEnabled(): boolean {
  if (process.env.ORVEX_VERIFY !== '0') return true;
  const production =
    process.env.NODE_ENV === 'production' || process.env.ORVEX_ENV === 'production';
  if (production && process.env.ORVEX_VERIFY_FORCE_OFF !== '1') return true;
  return false;
}
