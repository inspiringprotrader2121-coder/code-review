import { redactSecrets } from '../redact.js';

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated, ${text.length - max} chars omitted)`;
}

/** Grep hits often lack surrounding context that multi-line redact rules need. */
export function redactGrepOutput(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const match = /^([^:]+):(\d+):(.*)$/.exec(line);
      return match ? `${match[1]}:${match[2]}:${redactSecrets(match[3])}` : redactSecrets(line);
    })
    .join('\n')
    .replace(/^([^\n]*?:\d+:[ \t]*value:[ \t]*)(['"]?)([^\s'"\r\n]{6,})\2/gim, '$1$2[REDACTED]$2')
    .replace(/^([ \t]*value:[ \t]*)(['"]?)([^\s'"\r\n]{6,})\2/gim, '$1$2[REDACTED]$2');
}
