import { currentEnvironment } from './runtime.js';

export interface ReviewRuntimeConfig {
  readonly llmTimeoutMs: number;
  readonly llmMaxTotalMs: number;
  readonly testShortTimeouts: boolean;
  readonly maxOutputTokens: number;
  readonly maxOutputTokensCap: number;
  readonly rateLimitMaxRetries: number;
  readonly rateLimitMaxWaitMs: number;
  readonly rateLimitBaseMs: number;
  readonly rateLimitTotalWaitMs: number;
  readonly anthropicThinkingBudgetTokens: number | undefined;
  readonly responsesTimeoutMs: number;
  readonly openAiReasoningEffort: string;
  readonly maxFindings: number;
  readonly agentContextChars: number;
  readonly commandTrigger: string;
  readonly inlineEvidenceGate: boolean;
  readonly verifyFileChars: number;
  readonly verifyTotalChars: number;
  readonly verifyBatchSize: number;
  readonly verifyConcurrency: number;
  readonly riskProbes: number | undefined;
  readonly riskProbeSelectivity: number;
  readonly largePrFiles: number;
  readonly largePrPatchChars: number;
  readonly breadthMode: string;
  readonly investigateMaxSteps: number;
  readonly investigateToolChars: number;
  readonly investigateFileBytes: number;
  readonly aggregationRuns: number;
  readonly aggregationTemperature: number;
  readonly aggregationMaxCandidates: number;
  readonly aggregationMinOccurrences: number;
  readonly codexAllowedRepos: readonly string[];
  readonly codexTimeoutMs: number;
  readonly codexInactivityTimeoutMs: number;
  readonly codexRateLimitMaxWaitMs: number;
  readonly codexRateLimitTotalWaitMs: number;
  readonly codexHome: string | undefined;
  readonly codexHomes: readonly string[];
  readonly codexProxies: readonly string[];
  readonly codexProxy: string | undefined;
  readonly codexCliPath: string | undefined;
  readonly codexUsageFloorInput: number;
  readonly codexUsageFloorOutput: number;
  readonly childProcessEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly providerConcurrency: (provider: string) => number;
  readonly codexApiKeyConcurrency: number;
  readonly reviewWorkerConcurrency: number;
  readonly codexCliEnabled: boolean;
  readonly promptTreePaths: number;
  readonly promptDiffChars: number;
  readonly promptChangedChars: number;
  readonly promptRelatedChars: number;
  readonly promptOtherChars: number;
  readonly promptFullChangedFileChars: number;
  readonly promptChangedContextLines: number;
  readonly promptChangedChunksPerFile: number;
  readonly promptChangedChunkChars: number;
  readonly codexSlimDiffChars: number;
  readonly codexMaxDiffChars: number;
  readonly codexMaxTreePaths: number;
  readonly codexSlimPromptChars: number;
  readonly codexMaxPromptChars: number;
  /** Provider credentials and transport choices. These remain raw only at the
   * configuration boundary; server bootstrap turns them into explicit targets. */
  readonly providers: Readonly<{
    minimaxApiKey: string | undefined;
    minimaxBaseUrl: string | undefined;
    minimaxModel: string;
    minimaxApi: 'chat' | 'anthropic' | undefined;
    anthropicApiKey: string | undefined;
    anthropicModel: string;
    standardApiKey: string | undefined;
    standardBaseUrl: string | undefined;
    standardModel: string;
    standardApi: 'chat' | 'responses' | 'anthropic' | undefined;
    openAiApiKey: string | undefined;
    openAiBaseUrl: string;
    openAiApi: string | undefined;
    openAiModel: string;
    deepseekApiKey: string | undefined;
    deepseekBaseUrl: string;
    deepseekModel: string;
    deepseekFlashModel: string;
  }>;
  readonly routing: Readonly<{
    investigateEnabled: boolean;
    riskHuntEnabled: boolean;
    investigateTier: 'deepseek-flash' | 'deepseek' | 'openai' | 'standard';
  }>;
  readonly reviewInput: Readonly<{
    maxFileBytes: number;
    maxFiles: number;
    checkRunsEnabled: boolean;
  }>;
  readonly accountLimits: Readonly<{
    freeTierDailyCap: number;
    cogsReservationUsd: number;
  }>;
  readonly pricing: Readonly<{
    premium: Readonly<{ input: number; cachedInput: number; output: number }>;
    standard: Readonly<{ input: number; cachedInput: number; output: number }>;
    openai: Readonly<{ input: number; cachedInput: number; output: number }>;
    deepseek: Readonly<{ input: number; cachedInput: number; output: number }>;
    deepseekFlash: Readonly<{ input: number; cachedInput: number; output: number }>;
    modelRates: Readonly<
      Record<string, Readonly<{ input: number; cachedInput: number; output: number }>>
    >;
  }>;
  readonly preparation: Readonly<{
    deepContextEnabled: boolean;
    contextSourceFiles: number;
    contextRelatedFiles: number;
    contextDependents: number;
    contextFileBytes: number;
    archiveMaxBytes: number;
  }>;
  readonly publication: Readonly<{
    requestChangesOnP1: boolean;
    maxUnanchoredComments: number;
    failCheckOnP1: boolean;
  }>;
  readonly execution: Readonly<{
    abortPollMs: number;
    maxCalls: number;
    concurrency: number;
    maxOtherChars: number;
    sweepFileChars: number;
    maxInlinePerPr: number;
  }>;
  readonly cooldownSeconds: number;
  readonly verificationEnabled: boolean;
}

function finite(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function positive(raw: string | undefined, fallback: number): number {
  const value = finite(raw, fallback);
  return value > 0 ? Math.floor(value) : fallback;
}

function optionalPositive(raw: string | undefined): number | undefined {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function boundedConcurrency(raw: string | undefined, fallback: number, maximum: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(1, Math.floor(parsed))) : fallback;
}

function promptLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function positiveBounded(raw: string | undefined, fallback: number, maximum: number): number {
  return Math.min(maximum, positive(raw, fallback));
}

function nonNegativeBounded(raw: string | undefined, fallback: number, maximum: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.floor(value))) : fallback;
}

function boundedRange(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback;
}

function positiveNumber(raw: string | undefined, fallback: number, maximum = 1_000_000): number {
  const value = finite(raw, fallback);
  return value > 0 ? Math.min(maximum, value) : fallback;
}

function apiKind(raw: string | undefined): 'chat' | 'responses' | 'anthropic' | undefined {
  return raw === 'chat' || raw === 'responses' || raw === 'anthropic' ? raw : undefined;
}

function list(raw: string | undefined): readonly string[] {
  return Object.freeze(
    (raw ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

/** Preserve the historical coercion/ranges while giving review code typed values. */
export function loadReviewRuntimeConfig(
  env: NodeJS.ProcessEnv = currentEnvironment(),
): ReviewRuntimeConfig {
  const childProcessEnvironment: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries({
      PATH: env.PATH,
      HOME: env.HOME,
      USER: env.USER,
      LOGNAME: env.LOGNAME,
      LANG: env.LANG,
      LC_ALL: env.LC_ALL,
      LC_CTYPE: env.LC_CTYPE,
      TERM: env.TERM,
      TMPDIR: env.TMPDIR,
      SHELL: env.SHELL,
      SSL_CERT_FILE: env.SSL_CERT_FILE,
      SSL_CERT_DIR: env.SSL_CERT_DIR,
      NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS,
    }).filter(([, value]) => value !== undefined),
  );
  const config: ReviewRuntimeConfig = {
    llmTimeoutMs: Math.min(Math.max(positive(env.ORVEX_LLM_TIMEOUT_MS, 240_000), 1_000), 900_000),
    llmMaxTotalMs: Math.min(
      Math.max(
        Number.isFinite(Number(env.ORVEX_LLM_MAX_TOTAL_MS ?? 300_000))
          ? Number(env.ORVEX_LLM_MAX_TOTAL_MS ?? 300_000)
          : 300_000,
        env.ORVEX_TEST_SHORT_TIMEOUTS === '1' ? 10 : 30_000,
      ),
      300_000,
    ),
    testShortTimeouts: env.ORVEX_TEST_SHORT_TIMEOUTS === '1',
    maxOutputTokens: positive(env.ORVEX_MAX_OUTPUT_TOKENS, 64_000),
    maxOutputTokensCap: Math.min(positive(env.ORVEX_MAX_OUTPUT_TOKENS_CAP, 64_000), 1_000_000),
    rateLimitMaxRetries: finite(env.ORVEX_RATELIMIT_MAX_RETRIES, 2),
    rateLimitMaxWaitMs: finite(env.ORVEX_RATELIMIT_MAX_WAIT_MS, 60_000),
    rateLimitBaseMs: finite(env.ORVEX_RATELIMIT_BASE_MS, 2_000),
    rateLimitTotalWaitMs: finite(env.ORVEX_RATELIMIT_TOTAL_WAIT_MS, 60_000),
    anthropicThinkingBudgetTokens: optionalPositive(env.ORVEX_ANTHROPIC_THINKING_BUDGET_TOKENS),
    responsesTimeoutMs: Math.min(
      Math.max(positive(env.ORVEX_RESPONSES_TIMEOUT_MS, 900_000), 1_000),
      900_000,
    ),
    openAiReasoningEffort: env.ORVEX_OPENAI_REASONING_EFFORT ?? 'high',
    maxFindings: Math.min(positive(env.ORVEX_MAX_FINDINGS, 25), 1_000),
    agentContextChars: Math.min(positive(env.ORVEX_AGENT_CTX_CHARS, 240_000), 2_000_000),
    commandTrigger: env.ORVEX_TRIGGER ?? '@orvex',
    inlineEvidenceGate: env.ORVEX_INLINE_EVIDENCE_GATE !== '0',
    verifyFileChars: positive(env.ORVEX_VERIFY_FILE_CHARS, 32_000),
    verifyTotalChars: positive(env.ORVEX_VERIFY_TOTAL_CHARS, 96_000),
    verifyBatchSize: positive(env.ORVEX_VERIFY_BATCH_SIZE, 3),
    verifyConcurrency: (() => {
      const raw = Number(env.ORVEX_VERIFY_CONCURRENCY ?? 3);
      return Number.isFinite(raw) ? Math.min(8, Math.max(1, Math.floor(raw))) : 3;
    })(),
    riskProbes:
      Number.isFinite(Number(env.ORVEX_RISK_PROBES)) && Number(env.ORVEX_RISK_PROBES) >= 0
        ? Math.min(4, Math.floor(Number(env.ORVEX_RISK_PROBES)))
        : undefined,
    riskProbeSelectivity:
      Number.isFinite(Number(env.ORVEX_RISK_PROBE_SELECTIVITY)) &&
      Number(env.ORVEX_RISK_PROBE_SELECTIVITY) >= 1.5
        ? Number(env.ORVEX_RISK_PROBE_SELECTIVITY)
        : 2,
    largePrFiles: positive(env.ORVEX_LARGE_PR_FILES, 40),
    largePrPatchChars: positive(env.ORVEX_LARGE_PR_PATCH_CHARS, 150_000),
    breadthMode: (env.ORVEX_BREADTH_ON ?? 'deep-or-large').trim().toLowerCase(),
    investigateMaxSteps: Math.max(1, Math.min(20, positive(env.ORVEX_INVESTIGATE_MAX_STEPS, 8))),
    investigateToolChars: Math.max(
      2_000,
      Math.min(80_000, positive(env.ORVEX_INVESTIGATE_TOOL_CHARS, 24_000)),
    ),
    investigateFileBytes: positive(env.ORVEX_INVESTIGATE_FILE_BYTES, 250_000),
    aggregationRuns: Math.floor(finite(env.ORVEX_REVIEW_AGGREGATION_RUNS, 1)),
    aggregationTemperature: Math.min(
      1,
      Math.max(0, finite(env.ORVEX_REVIEW_AGGREGATION_TEMPERATURE, 0.2)),
    ),
    aggregationMaxCandidates: Math.min(
      250,
      Math.max(10, Math.floor(finite(env.ORVEX_REVIEW_AGGREGATION_MAX_CANDIDATES, 120))),
    ),
    aggregationMinOccurrences: Math.floor(finite(env.ORVEX_REVIEW_AGGREGATION_MIN_OCCURRENCES, 2)),
    codexAllowedRepos: Object.freeze(
      list(env.ORVEX_CODEX_CLI_REPOS).map((value) => value.toLowerCase()),
    ),
    codexTimeoutMs: Math.min(
      480_000,
      Math.max(60_000, finite(env.ORVEX_CODEX_TIMEOUT_MS, 480_000)),
    ),
    codexInactivityTimeoutMs: 0,
    codexRateLimitMaxWaitMs: finite(env.ORVEX_CODEX_RATELIMIT_MAX_WAIT_MS, 60_000),
    codexRateLimitTotalWaitMs: finite(env.ORVEX_CODEX_RATELIMIT_TOTAL_WAIT_MS, 60_000),
    codexHome: env.ORVEX_CODEX_HOME,
    codexHomes: list(env.ORVEX_CODEX_HOMES),
    codexProxies: list(env.ORVEX_CODEX_PROXIES),
    codexProxy: env.ORVEX_CODEX_PROXY,
    codexCliPath: env.ORVEX_CODEX_CLI_PATH,
    codexUsageFloorInput: positive(env.ORVEX_CODEX_USAGE_FLOOR_INPUT, 50_000),
    codexUsageFloorOutput: positive(env.ORVEX_CODEX_USAGE_FLOOR_OUTPUT, 5_000),
    childProcessEnvironment: Object.freeze(childProcessEnvironment),
    providerConcurrency(provider: string): number {
      const name = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      const workerConcurrency = boundedConcurrency(env.ORVEX_MAX_CONCURRENT_REVIEWS, 8, 32);
      const codexConcurrency = boundedConcurrency(
        env.ORVEX_CODEX_APIKEY_CONCURRENCY,
        workerConcurrency,
        32,
      );
      const sharedCapacity = env.ORVEX_CODEX_CLI === '1' ? codexConcurrency : workerConcurrency;
      return boundedConcurrency(env[`ORVEX_PROVIDER_CONCURRENCY_${name}`], sharedCapacity, 32);
    },
    codexApiKeyConcurrency: boundedConcurrency(
      env.ORVEX_CODEX_APIKEY_CONCURRENCY,
      boundedConcurrency(env.ORVEX_MAX_CONCURRENT_REVIEWS, 8, 32),
      32,
    ),
    reviewWorkerConcurrency: boundedConcurrency(env.ORVEX_MAX_CONCURRENT_REVIEWS, 8, 100),
    codexCliEnabled: env.ORVEX_CODEX_CLI === '1',
    promptTreePaths: promptLimit(env.ORVEX_MAX_TREE_PATHS, 400),
    promptDiffChars: promptLimit(env.ORVEX_MAX_DIFF_CHARS, 96_000),
    promptChangedChars: Math.min(16_000, promptLimit(env.ORVEX_MAX_CHANGED_CHARS, 16_000)),
    promptRelatedChars: Math.min(6_000, promptLimit(env.ORVEX_MAX_RELATED_CHARS, 6_000)),
    promptOtherChars: Math.min(2_000, promptLimit(env.ORVEX_MAX_OTHER_CHARS, 2_000)),
    promptFullChangedFileChars: promptLimit(env.ORVEX_FULL_CHANGED_FILE_CHARS, 12_000),
    promptChangedContextLines: promptLimit(env.ORVEX_CHANGED_CONTEXT_LINES, 32),
    promptChangedChunksPerFile: promptLimit(env.ORVEX_MAX_CHANGED_CHUNKS_PER_FILE, 4),
    promptChangedChunkChars: promptLimit(env.ORVEX_MAX_CHANGED_CHUNK_CHARS, 12_000),
    codexSlimDiffChars: positive(env.ORVEX_CODEX_SLIM_DIFF_CHARS, 30_000),
    codexMaxDiffChars: positive(env.ORVEX_CODEX_MAX_DIFF_CHARS, 60_000),
    codexMaxTreePaths: positive(env.ORVEX_CODEX_MAX_TREE_PATHS, 400),
    codexSlimPromptChars: positive(env.ORVEX_CODEX_SLIM_PROMPT_CHARS, 50_000),
    codexMaxPromptChars: positive(env.ORVEX_CODEX_MAX_PROMPT_CHARS, 100_000),
    providers: Object.freeze({
      minimaxApiKey: env.MINIMAX_API_KEY,
      minimaxBaseUrl: env.MINIMAX_BASE_URL,
      minimaxModel: env.MINIMAX_MODEL ?? 'MiniMax-M3',
      minimaxApi:
        env.MINIMAX_API === 'anthropic'
          ? 'anthropic'
          : env.MINIMAX_API === 'chat'
            ? 'chat'
            : undefined,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514',
      standardApiKey: env.ORVEX_STANDARD_API_KEY,
      standardBaseUrl: env.ORVEX_STANDARD_BASE_URL,
      standardModel: env.ORVEX_STANDARD_MODEL ?? 'MiniMax-M3',
      standardApi: apiKind(env.ORVEX_STANDARD_API),
      openAiApiKey: env.ORVEX_OPENAI_API_KEY,
      openAiBaseUrl: env.ORVEX_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      openAiApi: env.ORVEX_OPENAI_API,
      openAiModel: env.ORVEX_OPENAI_MODEL ?? 'gpt-5.6-luna',
      deepseekApiKey: env.ORVEX_DEEPSEEK_API_KEY,
      deepseekBaseUrl: env.ORVEX_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      deepseekModel: env.ORVEX_DEEPSEEK_MODEL ?? 'deepseek-v4-pro',
      deepseekFlashModel: env.ORVEX_DEEPSEEK_FLASH_MODEL ?? 'deepseek-v4-flash',
    }),
    routing: Object.freeze({
      investigateEnabled: env.ORVEX_INVESTIGATE === '1',
      riskHuntEnabled: env.ORVEX_RISK_HUNT === '1',
      investigateTier: ['deepseek-flash', 'deepseek', 'openai', 'standard'].includes(
        env.ORVEX_INVESTIGATE_TIER?.trim().toLowerCase() ?? '',
      )
        ? (env.ORVEX_INVESTIGATE_TIER!.trim().toLowerCase() as
            | 'deepseek-flash'
            | 'deepseek'
            | 'openai'
            | 'standard')
        : 'deepseek-flash',
    }),
    reviewInput: Object.freeze({
      maxFileBytes: positiveBounded(env.MAX_FILE_BYTES, 300_000, 10_000_000),
      maxFiles: positiveBounded(env.MAX_FILES, 150, 1_000),
      checkRunsEnabled: env.CHECK_RUNS_ENABLED === '1',
    }),
    accountLimits: Object.freeze({
      freeTierDailyCap: nonNegativeBounded(env.ORVEX_FREE_TIER_DAILY_CAP, 300, 1_000_000),
      cogsReservationUsd: positiveNumber(env.ORVEX_COGS_RESERVATION_USD, 5),
    }),
    pricing: Object.freeze({
      premium: Object.freeze({
        input: positiveNumber(env.ORVEX_COST_INPUT_PER_M, 1.4),
        cachedInput: positiveNumber(env.ORVEX_COST_CACHED_INPUT_PER_M, 1.4),
        output: positiveNumber(env.ORVEX_COST_OUTPUT_PER_M, 4.4),
      }),
      standard: Object.freeze({
        input: positiveNumber(env.ORVEX_STANDARD_COST_INPUT_PER_M, 0.3),
        cachedInput: positiveNumber(env.ORVEX_STANDARD_CACHED_INPUT_COST_PER_M, 0.06),
        output: positiveNumber(env.ORVEX_STANDARD_COST_OUTPUT_PER_M, 1.2),
      }),
      openai: Object.freeze({
        input: positiveNumber(env.ORVEX_OPENAI_COST_INPUT_PER_M, 0.2),
        cachedInput: positiveNumber(env.ORVEX_OPENAI_CACHED_INPUT_COST_PER_M, 0.02),
        output: positiveNumber(env.ORVEX_OPENAI_COST_OUTPUT_PER_M, 1.2),
      }),
      deepseek: Object.freeze({
        input: positiveNumber(env.ORVEX_DEEPSEEK_COST_INPUT_PER_M, 0.435),
        cachedInput: positiveNumber(env.ORVEX_DEEPSEEK_CACHED_INPUT_COST_PER_M, 0.003625),
        output: positiveNumber(env.ORVEX_DEEPSEEK_COST_OUTPUT_PER_M, 0.87),
      }),
      deepseekFlash: Object.freeze({
        input: positiveNumber(env.ORVEX_DEEPSEEK_FLASH_COST_INPUT_PER_M, 0.14),
        cachedInput: positiveNumber(env.ORVEX_DEEPSEEK_FLASH_CACHED_INPUT_COST_PER_M, 0.0028),
        output: positiveNumber(env.ORVEX_DEEPSEEK_FLASH_COST_OUTPUT_PER_M, 0.28),
      }),
      // The contracted public reviewer models retain their own rates so a
      // legacy generic OpenAI variable cannot silently understate Luna spend.
      modelRates: Object.freeze({
        'gpt-5.6-luna': Object.freeze({
          input: positiveNumber(env.ORVEX_LUNA_COST_INPUT_PER_M, 0.2),
          cachedInput: positiveNumber(env.ORVEX_LUNA_CACHED_INPUT_COST_PER_M, 0.02),
          output: positiveNumber(env.ORVEX_LUNA_COST_OUTPUT_PER_M, 1.2),
        }),
        'deepseek-v4-pro': Object.freeze({
          input: positiveNumber(env.ORVEX_DEEPSEEK_COST_INPUT_PER_M, 0.435),
          cachedInput: positiveNumber(env.ORVEX_DEEPSEEK_CACHED_INPUT_COST_PER_M, 0.003625),
          output: positiveNumber(env.ORVEX_DEEPSEEK_COST_OUTPUT_PER_M, 0.87),
        }),
        'deepseek-v4-flash': Object.freeze({
          input: positiveNumber(env.ORVEX_DEEPSEEK_FLASH_COST_INPUT_PER_M, 0.14),
          cachedInput: positiveNumber(env.ORVEX_DEEPSEEK_FLASH_CACHED_INPUT_COST_PER_M, 0.0028),
          output: positiveNumber(env.ORVEX_DEEPSEEK_FLASH_COST_OUTPUT_PER_M, 0.28),
        }),
        'minimax-m3': Object.freeze({
          input: positiveNumber(env.ORVEX_STANDARD_COST_INPUT_PER_M, 0.3),
          cachedInput: positiveNumber(env.ORVEX_STANDARD_CACHED_INPUT_COST_PER_M, 0.06),
          output: positiveNumber(env.ORVEX_STANDARD_COST_OUTPUT_PER_M, 1.2),
        }),
      }),
    }),
    preparation: Object.freeze({
      deepContextEnabled: env.ORVEX_DEEP_CONTEXT !== '0',
      contextSourceFiles: nonNegativeBounded(env.ORVEX_CTX_SOURCE, 40, 500),
      contextRelatedFiles: nonNegativeBounded(env.ORVEX_CTX_RELATED, 12, 200),
      contextDependents: nonNegativeBounded(env.ORVEX_CTX_DEPENDENTS, 8, 200),
      contextFileBytes: nonNegativeBounded(env.ORVEX_CTX_FILE_BYTES, 120_000, 1_000_000),
      archiveMaxBytes: positiveBounded(env.ORVEX_AGENT_ARCHIVE_MAX_BYTES, 150_000_000, 500_000_000),
    }),
    publication: Object.freeze({
      requestChangesOnP1: env.ORVEX_REQUEST_CHANGES === '1',
      maxUnanchoredComments: nonNegativeBounded(env.ORVEX_MAX_UNANCHORED_COMMENTS, 3, 50),
      failCheckOnP1: env.ORVEX_FAIL_CHECK_ON_P1 === '1',
    }),
    execution: Object.freeze({
      abortPollMs: boundedRange(env.ORVEX_ABORT_POLL_MS, 5_000, 1_000, 900_000),
      maxCalls: boundedRange(env.ORVEX_REVIEW_MAX_CALLS, 28, 1, 100),
      concurrency: boundedRange(env.ORVEX_REVIEW_CONCURRENCY, 3, 1, 64),
      maxOtherChars: positiveBounded(env.ORVEX_MAX_OTHER_CHARS, 45_000, 2_000_000),
      sweepFileChars: positiveBounded(env.ORVEX_SWEEP_FILE_CHARS, 10_000, 200_000),
      maxInlinePerPr: nonNegativeBounded(env.ORVEX_MAX_INLINE_PER_PR, 100, 10_000),
    }),
    cooldownSeconds: nonNegativeBounded(env.ORVEX_REVIEW_COOLDOWN_S, 120, 86_400),
    verificationEnabled:
      env.NODE_ENV === 'production' || env.ORVEX_ENV === 'production' || env.ORVEX_VERIFY !== '0',
  };
  const inactivity = Math.min(
    config.codexTimeoutMs,
    Math.max(30_000, finite(env.ORVEX_CODEX_INACTIVITY_TIMEOUT_MS, 300_000)),
  );
  return Object.freeze({ ...config, codexInactivityTimeoutMs: inactivity });
}
