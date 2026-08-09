import { sanitizeFindingText } from './sanitize.js';

const APPLY_MARKER_PREFIX = '<!--orvex:apply:';
const FINGERPRINT_CHARS = '[a-zA-Z0-9_-]{6,64}';

export function applyMarker(fingerprint: string): string {
  return `${APPLY_MARKER_PREFIX}${fingerprint}-->`;
}

export const APPLY_LINE_RE = new RegExp(`^.*<!--orvex:apply:${FINGERPRINT_CHARS}-->.*$`, 'm');

export function applyCheckboxLine(fingerprint: string, hasFix: boolean): string {
  const label = hasFix ? 'Apply this fix' : 'Fix this with Orvex';
  return `- [ ] ${applyMarker(fingerprint)} **${label}** — Orvex commits to this PR branch`;
}

export function applyingLine(fingerprint: string, requestedBy?: string): string {
  const by = requestedBy ? ` (requested by @${requestedBy})` : '';
  return `⏳ ${applyMarker(fingerprint)} **Applying fix…**${by}`;
}

export function appliedLine(fingerprint: string, shortSha: string): string {
  return `✅ ${applyMarker(fingerprint)} **Fix applied** in \`${shortSha}\``;
}

export function failedApplyLine(fingerprint: string, reason: string): string {
  return `- [ ] ${applyMarker(fingerprint)} **Apply this fix** — last attempt failed (${sanitizeFindingText(reason)}); tick to retry`;
}

export function replaceApplyLine(body: string, newLine: string): string {
  return body.replace(APPLY_LINE_RE, () => newLine);
}

export function parseApplyMarker(body: string): string | null {
  const match = body.match(new RegExp(`<!--orvex:apply:(${FINGERPRINT_CHARS})-->`));
  return match ? match[1] : null;
}

export function applyCheckboxChecked(bodyBefore: string | undefined, bodyAfter: string): boolean {
  if (!/- \[x\] <!--orvex:apply:/i.test(bodyAfter)) return false;
  return bodyBefore !== undefined && /- \[ \] <!--orvex:apply:/.test(bodyBefore);
}
