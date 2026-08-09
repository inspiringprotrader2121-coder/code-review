/**
 * Email-based identity + anti-abuse helpers.
 *
 * Trial-farming's cheapest vector is email aliases: `johndoe@gmail.com`,
 * `john.doe@gmail.com`, and `johndoe+1@gmail.com` all deliver to ONE inbox but
 * look like three distinct accounts to a naive lowercase check. `normalizeEmail`
 * collapses them so one real inbox = one identity. `isDisposableEmail` blocks
 * throwaway-inbox domains that farmers use to mint unlimited "real" emails.
 */

import { loadTenantRuntimeConfig, type TenantRuntimeConfig } from './config.js';

// Providers whose local-part is dot-insensitive AND +tag-subaddressed. Gmail is
// the canonical one; a few others share the semantics.
const DOT_INSENSITIVE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const GMAIL_CANONICAL = 'gmail.com';

/**
 * Canonicalize an email to its delivering identity:
 *  - lowercase + trim
 *  - drop everything after the first `+` in the local part (subaddressing —
 *    supported by Gmail, Outlook, Fastmail, ProtonMail, iCloud, and most others)
 *  - for Gmail/Googlemail: also strip dots from the local part and fold
 *    googlemail.com → gmail.com
 * Returns the input lowercased/trimmed if it isn't a parseable `local@domain`.
 */
export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0 || at === e.length - 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);

  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus); // strip +tag everywhere

  if (DOT_INSENSITIVE_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
    domain = GMAIL_CANONICAL;
  }
  return `${local}@${domain}`;
}

// Known disposable / temporary-inbox domains. Not exhaustive — it's the head of
// the distribution that catches the overwhelming majority of throwaway signups.
// Extend via ORVEX_EXTRA_DISPOSABLE_DOMAINS (comma-separated).
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.info',
  'guerrillamail.biz',
  'sharklasers.com',
  'grr.la',
  'yopmail.com',
  'yopmail.fr',
  'trashmail.com',
  '10minutemail.com',
  '10minutemail.net',
  'temp-mail.org',
  'tempmail.com',
  'tempmailo.com',
  'tempr.email',
  'throwawaymail.com',
  'getnada.com',
  'nada.email',
  'maildrop.cc',
  'dispostable.com',
  'mailnesia.com',
  'fakeinbox.com',
  'mohmal.com',
  'moakt.com',
  'mytemp.email',
  'emailondeck.com',
  'spam4.me',
  'burnermail.io',
  'mailcatch.com',
  'inboxbear.com',
  'harakirimail.com',
  'tmpmail.org',
  'tmpmail.net',
  'discard.email',
  'mailtemp.net',
  'jetable.org',
  'trbvm.com',
  'cock.li',
  'anonaddy.me',
]);

function disposableDomains(config: TenantRuntimeConfig): ReadonlySet<string> {
  if (config.extraDisposableDomains.length === 0) return DISPOSABLE_DOMAINS;
  const set = new Set(DISPOSABLE_DOMAINS);
  for (const domain of config.extraDisposableDomains) set.add(domain);
  return set;
}

/** True when the email's domain is a known disposable/temp-inbox provider —
 *  exact match OR any subdomain (`x.mailinator.com` is the same throwaway
 *  inbox as `mailinator.com`; several providers hand out per-user subdomains). */
export function isDisposableEmail(
  email: string,
  config: TenantRuntimeConfig = loadTenantRuntimeConfig(),
): boolean {
  const at = email.lastIndexOf('@');
  // at <= 0: no local part (or no @) — not a parseable email; don't classify on
  // the domain alone. at === length-1: no domain at all.
  if (at <= 0 || at === email.length - 1) return false;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  for (const d of disposableDomains(config)) {
    if (domain === d || domain.endsWith(`.${d}`)) return true;
  }
  return false;
}

/** Basic shape check — a syntactically plausible email. Not RFC-perfect; just
 *  enough to reject garbage before we normalize/store it. */
export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email.trim());
}
