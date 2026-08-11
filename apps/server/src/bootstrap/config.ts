import {
  boundedInteger,
  loadGitHubRuntimeConfig,
  loadQueueConfig,
  loadReviewRuntimeConfig,
  type GitHubRuntimeConfig,
  type QueueConfig,
  type ReviewRuntimeConfig,
} from '@orvex-review/config';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { GitHubAppConfig } from '@orvex-review/github';
import type { StoreRuntimeOptions } from '@orvex-review/store';
import { type BillingConfig, type PlanCatalog } from '@orvex-review/billing';
import { loadBillingConfig, loadPlanCatalog } from './billing-config.js';
import {
  identityRateLimitPolicies,
  type IdentityRateLimitName,
  type RateLimitPolicy,
} from '../application/identity/rate-limits.js';
import {
  createSandboxRuntimeBindings,
  type SandboxRuntimeBindings,
} from '../sandbox-runtime-options.js';
import { loadProcessRole, type ProcessRole } from './topology.js';

type Environment = Readonly<NodeJS.ProcessEnv>;

function optional(raw: string | undefined): string | undefined {
  return raw?.trim() || undefined;
}

function list(raw: string | undefined): readonly string[] {
  return Object.freeze(
    (raw ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function bounded(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return boundedInteger(raw, fallback, minimum, maximum);
}

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly appUrl: string;
  readonly isProduction: boolean;
  readonly allowPublicNoLogin: boolean;
  readonly requireLogin: boolean;
  readonly authDisabled: boolean;
  readonly platformSecret: string;
  readonly adminSecret: string | undefined;
  readonly reviewApiSecret: string | undefined;
  readonly storePath: string | undefined;
  readonly databasePath: string;
  readonly store: StoreRuntimeOptions;
  readonly staleRunMs: number;
  readonly codexStatusFile: string;
  readonly deployDrainPath: string;
  readonly monitorDiskPath: string | undefined;
  readonly queue: QueueConfig;
  readonly github: GitHubRuntimeConfig;
  readonly oauth: Readonly<{
    github: Readonly<{ clientId: string; clientSecret: string }> | null;
    google: Readonly<{ clientId: string; clientSecret: string }> | null;
  }>;
  readonly identity: Readonly<{
    rateLimits: Readonly<Record<IdentityRateLimitName, RateLimitPolicy>>;
    ipAccountLimit: number;
    ipAbuseBlock: boolean;
    trustedProxyIps: readonly string[];
  }>;
  readonly billing: BillingConfig;
  readonly billingCatalog: PlanCatalog;
  readonly topology: Readonly<{ role: ProcessRole }>;
  readonly worker: Readonly<{
    concurrency: number;
    maxJobRetries: number;
    leaseRenewMs: number;
    shutdownDrainMs: number;
    shutdownCancelMs: number;
  }>;
  readonly webhook: Readonly<{ bodyDedupTtlMs: number }>;
  readonly quota: Readonly<{ monthlyCogsCapUsd: number }>;
  readonly costVisibilityTenants: readonly string[];
  readonly alerts: Readonly<{ webhookUrl: string | undefined }>;
  readonly nightly: Readonly<{
    enabled: boolean;
    lookbackDays: number;
    hour: number;
    maxScansPerTenantDay: number;
  }>;
  readonly autofix: Readonly<{
    commandsPerHour: number;
    maxFixRunsPerDay: number;
    maxFixTargets: number;
    deepContext: boolean;
    context: Readonly<{
      maxSourceFiles: number;
      maxRelated: number;
      maxDependents: number;
      maxFileBytes: number;
      maxOthers: number;
    }>;
  }>;
  readonly verificationEnabled: boolean;
  /** One immutable provider/pricing/review execution snapshot for all workers. */
  readonly review: ReviewRuntimeConfig;
  readonly sandbox: SandboxRuntimeBindings;
}

/**
 * The sole runtime environment boundary for the server. It creates a complete
 * immutable snapshot during bootstrap; request and worker code receive this
 * value through composition and never observe a later process.env mutation.
 */
export function loadServerConfig(env: Environment = process.env): ServerConfig {
  const host = optional(env.HOST) ?? '127.0.0.1';
  const port = bounded(env.PORT, 8787, 1, 65_535);
  const appUrl = (optional(env.APP_URL) ?? `http://localhost:${port}`).replace(/\/+$/, '');
  const configuredPlatformSecret = optional(env.PLATFORM_SECRET);
  const platformSecret = configuredPlatformSecret ?? optional(env.GITHUB_WEBHOOK_SECRET) ?? '';
  const githubOauthId = optional(env.GITHUB_OAUTH_CLIENT_ID);
  const githubOauthSecret = optional(env.GITHUB_OAUTH_CLIENT_SECRET);
  const googleOauthId = optional(env.GOOGLE_OAUTH_CLIENT_ID);
  const googleOauthSecret = optional(env.GOOGLE_OAUTH_CLIENT_SECRET);
  const monthlyCogsCap = Number(env.ORVEX_MONTHLY_COGS_CAP_USD ?? 250);
  const monthlyCogsCapUsd =
    Number.isFinite(monthlyCogsCap) && monthlyCogsCap > 0 ? monthlyCogsCap : 250;
  const production = env.NODE_ENV === 'production' || env.ORVEX_ENV === 'production';
  const processRole = loadProcessRole(env.ORVEX_PROCESS_ROLE);
  if (
    (production || !isLoopbackHost(host)) &&
    Buffer.byteLength(configuredPlatformSecret ?? '', 'utf8') < 32
  ) {
    throw new Error(
      'PLATFORM_SECRET must be an explicit random value of at least 32 bytes for production or public binds',
    );
  }
  const storePath = optional(env.STORE_PATH);
  const dataDir = path.join(process.cwd(), '.data');
  const legacyDbPath = path.join(dataDir, 'velatrix-review.db');
  const currentDbPath = path.join(dataDir, 'orvex-review.db');
  const databasePath =
    storePath ??
    (!existsSync(currentDbPath) && existsSync(legacyDbPath) ? legacyDbPath : currentDbPath);
  const requireDurableStorage = production || env.ORVEX_REQUIRE_DURABLE_STORAGE === '1';
  const configuredWorkerId = optional(env.ORVEX_WORKER_ID);
  if (
    production &&
    (processRole === 'worker' || processRole === 'scheduler') &&
    !configuredWorkerId
  ) {
    throw new Error(
      'ORVEX_WORKER_ID is required for a production worker or scheduler role so fleet ownership remains stable',
    );
  }
  const store = Object.freeze({
    databasePath,
    workerIdBase: configuredWorkerId ?? String(process.pid),
    checkoutRoot: path.resolve(optional(env.ORVEX_CHECKOUT_ROOT) ?? process.cwd()),
    requireDurableStorage,
    defaultPlan: optional(env.ORVEX_DEFAULT_PLAN) ?? 'free',
  }) satisfies StoreRuntimeOptions;
  if (
    requireDurableStorage &&
    (!storePath || !path.isAbsolute(storePath) || storePath.includes(`${path.sep}.data${path.sep}`))
  ) {
    throw new Error('STORE_PATH must be an absolute path outside the checkout in production');
  }

  const review = loadReviewRuntimeConfig(env);
  return Object.freeze({
    host,
    port,
    appUrl,
    isProduction: production,
    allowPublicNoLogin: env.ORVEX_ALLOW_PUBLIC_NOLOGIN === '1',
    requireLogin: env.ORVEX_REQUIRE_LOGIN === '1',
    authDisabled: env.AUTH_DISABLED === '1',
    platformSecret,
    adminSecret: optional(env.ORVEX_ADMIN_SECRET),
    reviewApiSecret: optional(env.REVIEW_API_SECRET),
    storePath,
    databasePath,
    store,
    staleRunMs: bounded(env.ORVEX_RUNNING_STALE_MS, 15 * 60_000, 60_000, 24 * 3_600_000),
    codexStatusFile:
      optional(env.ORVEX_CODEX_STATUS_FILE) ?? '/home/orvex/orvex-data/codex-auth-status',
    deployDrainPath: optional(env.ORVEX_DEPLOY_DRAIN_PATH) ?? '/home/orvex/orvex-data/deploy-drain',
    monitorDiskPath: optional(env.ORVEX_MONITOR_DISK_PATH),
    queue: loadQueueConfig(env),
    github: loadGitHubRuntimeConfig(env),
    oauth: Object.freeze({
      github:
        githubOauthId && githubOauthSecret
          ? Object.freeze({ clientId: githubOauthId, clientSecret: githubOauthSecret })
          : null,
      google:
        googleOauthId && googleOauthSecret
          ? Object.freeze({ clientId: googleOauthId, clientSecret: googleOauthSecret })
          : null,
    }),
    identity: Object.freeze({
      rateLimits: identityRateLimitPolicies(env),
      ipAccountLimit: bounded(env.ORVEX_IP_MAX_ACCOUNTS_PER_DAY, 5, 1, 10_000),
      ipAbuseBlock: env.ORVEX_IP_ABUSE_BLOCK !== '0',
      trustedProxyIps: list(env.ORVEX_TRUSTED_PROXY_IPS),
    }),
    billing: loadBillingConfig(env),
    billingCatalog: loadPlanCatalog(env),
    topology: Object.freeze({ role: processRole }),
    worker: Object.freeze({
      concurrency: bounded(env.ORVEX_MAX_CONCURRENT_REVIEWS, 8, 1, 100),
      maxJobRetries: bounded(env.ORVEX_MAX_JOB_RETRIES, 0, 0, 1),
      leaseRenewMs: bounded(env.ORVEX_LEASE_RENEW_MS, 300_000, 10_000, 300_000),
      shutdownDrainMs: bounded(env.ORVEX_SHUTDOWN_DRAIN_MS, 240_000, 1_000, 86_400_000),
      shutdownCancelMs: bounded(env.ORVEX_SHUTDOWN_CANCEL_MS, 10_000, 100, 60_000),
    }),
    webhook: Object.freeze({
      bodyDedupTtlMs: bounded(
        env.ORVEX_WEBHOOK_BODY_DEDUP_TTL_MS,
        2 * 3_600_000,
        1,
        7 * 24 * 3_600_000,
      ),
    }),
    quota: Object.freeze({ monthlyCogsCapUsd }),
    costVisibilityTenants: list(env.ORVEX_LLM_COST_VISIBLE_TENANTS).map((slug) =>
      slug.toLowerCase(),
    ),
    alerts: Object.freeze({ webhookUrl: optional(env.ORVEX_ALERT_WEBHOOK_URL) }),
    nightly: Object.freeze({
      enabled: env.ORVEX_NIGHTLY_SCANS === '1',
      lookbackDays: bounded(env.ORVEX_NIGHTLY_LOOKBACK_DAYS, 1, 1, 30),
      hour: bounded(env.ORVEX_NIGHTLY_HOUR, 3, 0, 23),
      maxScansPerTenantDay: bounded(env.ORVEX_NIGHTLY_MAX_SCANS_PER_TENANT, 25, 1, 500),
    }),
    autofix: Object.freeze({
      commandsPerHour: bounded(env.ORVEX_COMMANDS_PER_HOUR, 60, 1, 10_000),
      maxFixRunsPerDay: bounded(env.ORVEX_MAX_FIX_RUNS_PER_DAY, 30, 1, 10_000),
      maxFixTargets: bounded(env.ORVEX_MAX_FIX_TARGETS, 25, 1, 500),
      deepContext: env.ORVEX_DEEP_CONTEXT !== '0',
      context: Object.freeze({
        maxSourceFiles: bounded(env.ORVEX_CTX_SOURCE, 100, 1, 10_000),
        maxRelated: bounded(env.ORVEX_CTX_RELATED, 30, 0, 10_000),
        maxDependents: bounded(env.ORVEX_CTX_DEPENDENTS, 20, 0, 10_000),
        maxFileBytes: bounded(env.ORVEX_CTX_FILE_BYTES, 32_000, 1, 10_000_000),
        maxOthers: bounded(env.ORVEX_CTX_OTHERS, 20, 0, 10_000),
      }),
    }),
    verificationEnabled: review.verificationEnabled,
    review,
    sandbox: createSandboxRuntimeBindings(env),
  });
}

/** Compatibility alias retained for callers while they migrate to ServerConfig. */
export type ServerRuntimeConfig = ServerConfig;
export const loadServerRuntimeConfig = loadServerConfig;

/** Materialize a GitHub App credential from the immutable bootstrap snapshot. */
export function githubAppConfig(config: Pick<ServerConfig, 'github'>): GitHubAppConfig | undefined {
  const { appId, privateKeyInline, privateKeyPath, webhookSecret, botLogin, allowedRepo, appSlug } =
    config.github;
  if (!appId) return undefined;
  const privateKey =
    privateKeyInline ?? (privateKeyPath ? readFileSync(privateKeyPath, 'utf8') : undefined);
  if (!privateKey) return undefined;
  return Object.freeze({
    appId,
    privateKey: privateKey.replace(/\\n/g, '\n'),
    webhookSecret,
    botLogin,
    allowedRepo,
    appSlug,
  });
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
