import { createHash } from 'node:crypto';

export interface StoreMigrationMetadata {
  version: number;
  timestamp: string;
  name: string;
  artifact: string;
  checksum: string;
  legacyChecksums: readonly string[];
}

export interface ExecutableMigrationArtifact {
  readonly format: 'sqlite-sql-v1' | 'sqlite-program-v1';
  readonly sql?: string;
  readonly operations?: readonly string[];
}

export const REVIEW_USAGE_CACHE_PRICING_ARTIFACT: ExecutableMigrationArtifact = Object.freeze({
  format: 'sqlite-program-v1',
  operations: Object.freeze([
    'add review_run_usage.cached_input_tokens with zero backfill',
    'add review_run_usage.cached_input_rate_per_m with zero backfill',
    'add review usage cached-input integrity triggers',
  ]),
});

export const REVIEW_USAGE_CACHE_WRITE_PRICING_ARTIFACT: ExecutableMigrationArtifact = Object.freeze(
  {
    format: 'sqlite-program-v1',
    operations: Object.freeze([
      'add review_run_usage.cache_write_tokens with zero backfill',
      'add review_run_usage.cache_write_rate_per_m with zero backfill',
      'replace review usage cache integrity triggers with read and write bounds',
    ]),
  },
);

export const REVIEW_ATTEMPT_DISPATCH_ARTIFACT: ExecutableMigrationArtifact = Object.freeze({
  format: 'sqlite-program-v1',
  operations: Object.freeze([
    'add review_run_attempts.dispatched with legacy true backfill',
    'record pre-provider admission rejections separately from dispatched attempts',
  ]),
});

export const REVIEW_ATTEMPT_ROLE_ARTIFACT: ExecutableMigrationArtifact = Object.freeze({
  format: 'sqlite-program-v1',
  operations: Object.freeze([
    'add review_run_attempts.role with primary backfill',
    'constrain attempt role to primary, retry, or continuation',
  ]),
});

export const REVIEW_USAGE_LUNA_REPRICE_ARTIFACT: ExecutableMigrationArtifact = Object.freeze({
  format: 'sqlite-sql-v1',
  sql: `
UPDATE review_run_usage
SET input_rate_per_m = 1,
    cached_input_rate_per_m = 0.1,
    cache_write_rate_per_m = 1.25,
    output_rate_per_m = 6,
    cost_usd = (
      ((input_tokens - cached_input_tokens - cache_write_tokens) * 1)
      + (cached_input_tokens * 0.1)
      + (cache_write_tokens * 1.25)
      + (output_tokens * 6)
    ) / 1000000.0
WHERE lower(trim(model)) = 'gpt-5.6-luna'
  AND abs(input_rate_per_m - 0.2) < 0.000001
  AND abs(cached_input_rate_per_m - 0.02) < 0.000001
  AND abs(output_rate_per_m - 1.2) < 0.000001;

UPDATE review_runs
SET input_tokens = COALESCE((
      SELECT SUM(usage.input_tokens)
      FROM review_run_usage AS usage
      WHERE usage.run_id = review_runs.id
    ), 0),
    output_tokens = COALESCE((
      SELECT SUM(usage.output_tokens)
      FROM review_run_usage AS usage
      WHERE usage.run_id = review_runs.id
    ), 0),
    cost_usd = COALESCE((
      SELECT SUM(usage.cost_usd)
      FROM review_run_usage AS usage
      WHERE usage.run_id = review_runs.id
    ), 0)
WHERE EXISTS (
  SELECT 1
  FROM review_run_usage AS usage
  WHERE usage.run_id = review_runs.id
    AND lower(trim(usage.model)) = 'gpt-5.6-luna'
    AND abs(usage.input_rate_per_m - 1) < 0.000001
    AND abs(usage.cached_input_rate_per_m - 0.1) < 0.000001
    AND abs(usage.output_rate_per_m - 6) < 0.000001
);`,
});

interface HistoricalMigrationArtifact {
  version: number;
  timestamp: string;
  name: string;
  artifact: string;
  legacyChecksums?: readonly string[];
}

const ARTIFACT_TIMESTAMP = '2026-08-09T00:00:00.000Z';

// These v1-v17 entries are historical ledger records. Their v3 checksums must
// never be recalculated from refactored source, because deployed databases
// already persist them. New migrations use defineExecutableMigration instead.
const historicalArtifacts: readonly HistoricalMigrationArtifact[] = [
  {
    version: 1,
    timestamp: ARTIFACT_TIMESTAMP,
    name: 'baseline-schema-v2',
    artifact:
      'sqlite-schema: tenants, installations, reviews, identity, billing, repositories, analytics',
    legacyChecksums: ['89034cb224be712dd646e40b9e39f47c32a57c09bd2e727f691c279779f08851'],
  },
  {
    version: 2,
    timestamp: ARTIFACT_TIMESTAMP,
    name: 'legacy-pr-reviews',
    artifact: 'sqlite-upgrade: rebuild legacy pr_reviews columns and preserve review state',
    legacyChecksums: ['3fd5f8311c77d1bf3646a0dae96cb774347c0c5721ceaebe23373f66014cdcf0'],
  },
  {
    version: 3,
    timestamp: ARTIFACT_TIMESTAMP,
    name: 'user-auth-columns',
    artifact:
      'sqlite-upgrade: email, normalized email, password, google identity, superadmin columns',
    legacyChecksums: ['d5a9778cab1d409e314e0034b3b16580389f1fb0eaf56cbf324c4b74508e0844'],
  },
  {
    version: 4,
    timestamp: ARTIFACT_TIMESTAMP,
    name: 'user-security-columns',
    artifact: 'sqlite-upgrade: MFA security factor columns',
    legacyChecksums: ['f8deb54b9dec0897cd8bea265f7e79ae1ca2210404e7ce5f76f5791d521ffaf0'],
  },
  {
    version: 5,
    timestamp: ARTIFACT_TIMESTAMP,
    name: 'tenant-plan',
    artifact: 'sqlite-upgrade: tenant plan default free',
    legacyChecksums: ['a3f926eb3f2aacc68bbbbe8e3edfe42311d2433f784fe07a2d4359e7f129307f'],
  },
  {
    version: 6,
    timestamp: ARTIFACT_TIMESTAMP,
    name: 'tenant-billing-columns',
    artifact: 'sqlite-upgrade: Stripe customer, subscription, status, and period columns',
    legacyChecksums: ['2f9e20d0a840b6089cc850bd374feb3a4b2bc8ad64ddfe927e48400d6a00d6fe'],
  },
  {
    version: 7,
    timestamp: ARTIFACT_TIMESTAMP,
    name: 'prepaid-credit-ledger',
    artifact: 'sqlite-schema: tenant prepaid credit ledger and idempotency indexes',
    legacyChecksums: ['946274622092a3ee5448f460afbf794e9f395548c7f36cacec54ecf95ae12ce3'],
  },
  {
    version: 8,
    timestamp: ARTIFACT_TIMESTAMP,
    name: 'repo-automation-toggles',
    artifact: 'sqlite-upgrade: repository open and push automation toggles',
    legacyChecksums: ['9ec13d62711fb350966eb3f659271825eaca2952dfda7ad2ceb13efa9aca51d6'],
  },
  {
    version: 9,
    timestamp: ARTIFACT_TIMESTAMP,
    name: 'review-run-cost-columns',
    artifact: 'sqlite-upgrade: review usage, cost, depth, free-tier, and findings columns',
    legacyChecksums: ['b5392688caf5ad676294a4efa8cdbd8b8047b895b0ae5ae26cacc8490d92ebd2'],
  },
  {
    version: 10,
    timestamp: ARTIFACT_TIMESTAMP,
    name: 'review-run-lifecycle-integrity',
    artifact:
      'sqlite-upgrade: review lifecycle fields, indexes, checks, and parent integrity triggers',
    legacyChecksums: ['eb1037d0ac54b034317238367a782f3a2c1f88df61b15ec5902ea18243d0da56'],
  },
  {
    version: 11,
    timestamp: ARTIFACT_TIMESTAMP,
    name: 'pr-review-columns',
    artifact: 'sqlite-upgrade: codex thread and manual review persistence',
    legacyChecksums: ['d9f4461b6d52b50742395b7d1f49d09c6853205568ab81ce6a68f0982f6465cb'],
  },
  {
    version: 12,
    timestamp: ARTIFACT_TIMESTAMP,
    name: 'stripe-revenue-indexes',
    artifact: 'sqlite-upgrade: invoice-paid uniqueness and refund-safe revenue indexes',
    legacyChecksums: ['0f12fa43a4372f74f19e1e1a801fd3856432ef334bf1b0709c67e91fcee25102'],
  },
  {
    version: 13,
    timestamp: ARTIFACT_TIMESTAMP,
    name: 'webhook-claim-token',
    artifact: 'sqlite-upgrade: durable webhook claim token fencing',
    legacyChecksums: ['2ee532b4a844316cebb9f502eaa4db09dbf3d7a131e1b66657e4904924a2b4f4'],
  },
  {
    version: 14,
    timestamp: ARTIFACT_TIMESTAMP,
    name: 'review-attempt-lineage-integrity',
    artifact: 'sqlite-upgrade: review attempt and usage same-run lineage triggers',
    legacyChecksums: ['c63b0b465720e2ac065bc79b751beb30006e3783d44407c13226c4898fbaa492'],
  },
  {
    version: 15,
    timestamp: ARTIFACT_TIMESTAMP,
    name: 'canonical-migration-artifacts',
    artifact:
      'sqlite-upgrade: record canonical artifact timestamp and replace accepted legacy ledger checksums',
  },
  {
    version: 16,
    timestamp: ARTIFACT_TIMESTAMP,
    name: 'review-publication-fencing',
    artifact: 'sqlite-schema: tenant and run scoped durable GitHub publication claims',
  },
  {
    version: 17,
    timestamp: ARTIFACT_TIMESTAMP,
    name: 'review-publication-resolution-audit',
    artifact: 'sqlite-schema: explicit operator resolution ledger for abandoned publication claims',
  },
];

/** Legacy v3 rule retained only for already-deployed v1-v17 ledger rows. */
function checksumHistoricalArtifact(
  artifact: Pick<HistoricalMigrationArtifact, 'version' | 'timestamp' | 'name' | 'artifact'>,
): string {
  return createHash('sha256')
    .update(
      `orvex-store-migration-v3:${artifact.version}:${artifact.timestamp}:${artifact.name}:${artifact.artifact}`,
    )
    .digest('hex');
}

export function canonicalExecutableArtifact(artifact: ExecutableMigrationArtifact): string {
  if (artifact.format === 'sqlite-sql-v1') {
    if (typeof artifact.sql !== 'string')
      throw new Error('sqlite-sql-v1 migration artifacts require sql');
    return JSON.stringify({ format: artifact.format, sql: artifact.sql });
  }
  if (
    !Array.isArray(artifact.operations) ||
    artifact.operations.some((operation) => typeof operation !== 'string')
  ) {
    throw new Error('sqlite-program-v1 migration artifacts require ordered operations');
  }
  return JSON.stringify({ format: artifact.format, operations: artifact.operations });
}

export function checksumExecutableMigrationArtifact(input: {
  version: number;
  timestamp: string;
  name: string;
  artifact: ExecutableMigrationArtifact;
}): string {
  return createHash('sha256')
    .update(
      `orvex-store-migration-v4:${input.version}:${input.timestamp}:${input.name}:${canonicalExecutableArtifact(input.artifact)}`,
    )
    .digest('hex');
}

/**
 * Compatibility export. String artifacts intentionally use the historical v3
 * rule. New call sites must pass an executable artifact object.
 */
export function checksumMigrationArtifact(input: {
  version: number;
  timestamp: string;
  name: string;
  artifact: string | ExecutableMigrationArtifact;
}): string {
  if (typeof input.artifact === 'string') {
    return checksumHistoricalArtifact({
      version: input.version,
      timestamp: input.timestamp,
      name: input.name,
      artifact: input.artifact,
    });
  }
  return checksumExecutableMigrationArtifact({ ...input, artifact: input.artifact });
}

export function defineExecutableMigration(input: {
  version: number;
  timestamp: string;
  name: string;
  artifact: ExecutableMigrationArtifact;
}): StoreMigrationMetadata {
  const artifact = canonicalExecutableArtifact(input.artifact);
  return Object.freeze({
    version: input.version,
    timestamp: input.timestamp,
    name: input.name,
    artifact,
    checksum: checksumExecutableMigrationArtifact(input),
    legacyChecksums: Object.freeze([]),
  });
}

export const STORE_MIGRATIONS: readonly StoreMigrationMetadata[] = Object.freeze([
  ...historicalArtifacts.map((artifact) =>
    Object.freeze({
      ...artifact,
      checksum: checksumHistoricalArtifact(artifact),
      legacyChecksums: Object.freeze([...(artifact.legacyChecksums ?? [])]),
    }),
  ),
  defineExecutableMigration({
    version: 18,
    timestamp: '2026-08-10T00:00:00.000Z',
    name: 'review-usage-cache-pricing',
    artifact: REVIEW_USAGE_CACHE_PRICING_ARTIFACT,
  }),
  defineExecutableMigration({
    version: 19,
    timestamp: '2026-08-10T00:00:00.000Z',
    name: 'review-usage-cache-write-pricing',
    artifact: REVIEW_USAGE_CACHE_WRITE_PRICING_ARTIFACT,
  }),
  defineExecutableMigration({
    version: 20,
    timestamp: '2026-08-11T00:00:00.000Z',
    name: 'review-attempt-dispatch-provenance',
    artifact: REVIEW_ATTEMPT_DISPATCH_ARTIFACT,
  }),
  defineExecutableMigration({
    version: 21,
    timestamp: '2026-08-11T00:00:00.000Z',
    name: 'review-attempt-role-provenance',
    artifact: REVIEW_ATTEMPT_ROLE_ARTIFACT,
  }),
  defineExecutableMigration({
    version: 22,
    timestamp: '2026-08-11T00:00:00.000Z',
    name: 'reprice-gpt-5-6-luna-usage',
    artifact: REVIEW_USAGE_LUNA_REPRICE_ARTIFACT,
  }),
]);

export interface MigrationLedgerRow {
  version: number;
  name: string;
  checksum: string;
  artifact_timestamp?: string | null;
}

export function validateMigrationLedger(rows: readonly MigrationLedgerRow[]): void {
  for (let index = 0; index < rows.length; index += 1) {
    const actual = rows[index]!;
    const expected = STORE_MIGRATIONS[index];
    if (!expected || actual.version !== expected.version)
      throw new Error(
        `schema migration ledger version mismatch at position ${index + 1}: found ${actual.version}`,
      );
    if (actual.name !== expected.name)
      throw new Error(
        `schema migration ledger name mismatch at version ${actual.version}: found ${actual.name}`,
      );
    if (
      actual.checksum !== expected.checksum &&
      !expected.legacyChecksums.includes(actual.checksum)
    ) {
      throw new Error(
        `schema migration ledger checksum mismatch at version ${actual.version} (${actual.name})`,
      );
    }
    if (actual.artifact_timestamp && actual.artifact_timestamp !== expected.timestamp) {
      throw new Error(
        `schema migration ledger artifact timestamp mismatch at version ${actual.version} (${actual.name})`,
      );
    }
  }
}
