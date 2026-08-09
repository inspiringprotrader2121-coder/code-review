export interface ServerRuntimeConfig {
  host: string;
  port: number;
  allowPublicNoLogin: boolean;
  staleRunMs: number;
  codexStatusFile: string;
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
    : fallback;
}

export function loadServerRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerRuntimeConfig {
  return Object.freeze({
    host: env.HOST?.trim() || '0.0.0.0',
    port: boundedInteger(env.PORT, 8787, 1, 65_535),
    allowPublicNoLogin: env.ORVEX_ALLOW_PUBLIC_NOLOGIN === '1',
    staleRunMs: boundedInteger(
      env.ORVEX_RUNNING_STALE_MS,
      15 * 60_000,
      60_000,
      24 * 3_600_000,
    ),
    codexStatusFile:
      env.ORVEX_CODEX_STATUS_FILE?.trim()
      || '/home/orvex/orvex-data/codex-auth-status',
  });
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
