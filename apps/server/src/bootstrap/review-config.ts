import {
  DEFAULT_CODEX_CLI_MODEL,
  DEFAULT_CODEX_CLI_REASONING_EFFORT,
  createReviewAggregationConfig,
} from '@orvex-review/review';
import type { AppDatabase } from '@orvex-review/store';
import {
  createReviewRoutingPolicy,
  maxOutputTokensForModel,
  validateNativeOpenAiResponsesConfig,
} from '../review/model-routing.js';
import type { LlmTarget, WorkerConfig } from '../review/worker-types.js';
import { githubAppConfig, loadServerConfig, type ServerConfig } from './config.js';

function transportFor(api: 'chat' | 'responses' | 'anthropic'): LlmTarget['transport'] {
  return api === 'responses' ? 'responses' : api === 'anthropic' ? 'anthropic' : 'compatible-chat';
}

function minimaxTransport(
  api: 'chat' | 'anthropic' | undefined,
  baseUrl: string | undefined,
): 'chat' | 'anthropic' {
  if (api === 'anthropic' || api === 'chat') return api;
  return baseUrl?.includes('/anthropic') ? 'anthropic' : 'chat';
}

/** Constructs the sole worker snapshot from the already-frozen ServerConfig. */
export function createWorkerConfig(config: ServerConfig, store: AppDatabase): WorkerConfig {
  const runtime = config.review;
  const providers = runtime.providers;
  const github = githubAppConfig(config);
  if (!github) {
    throw new Error(
      'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH are required',
    );
  }
  const routingPolicy = createReviewRoutingPolicy({
    codexCliEnabled: runtime.codexCliEnabled,
    codexRepoAllowed: (repoId, installationId) => {
      if (typeof store.isRepoEnabled === 'function' && typeof installationId === 'number') {
        return store.isRepoEnabled(installationId, repoId);
      }
      return store.hasEnabledRepo?.(repoId) === true;
    },
    investigateEnabled: runtime.routing.investigateEnabled,
    riskHuntEnabled: runtime.routing.riskHuntEnabled,
    investigateTier: runtime.routing.investigateTier,
  });

  const minimaxKey = providers.minimaxApiKey;
  const anthropicKey = providers.anthropicApiKey;
  if (!minimaxKey && !anthropicKey) {
    throw new Error('MINIMAX_API_KEY or ANTHROPIC_API_KEY is required');
  }
  const premiumApi = minimaxKey
    ? minimaxTransport(providers.minimaxApi, providers.minimaxBaseUrl)
    : 'anthropic';
  const premiumApiKey = minimaxKey ?? anthropicKey!;
  const premiumBaseUrl = minimaxKey
    ? (providers.minimaxBaseUrl ??
      (premiumApi === 'anthropic'
        ? 'https://api.minimax.io/anthropic'
        : 'https://api.minimax.io/v1'))
    : undefined;
  const premiumModel = minimaxKey ? providers.minimaxModel : providers.anthropicModel;

  const standardApi =
    providers.standardApi ??
    (providers.standardBaseUrl?.includes('/anthropic') ? 'anthropic' : 'chat');
  const standardModel: LlmTarget = providers.standardApiKey
    ? {
        apiKey: providers.standardApiKey,
        baseUrl:
          providers.standardBaseUrl ??
          (standardApi === 'anthropic'
            ? 'https://api.minimax.io/anthropic'
            : 'https://api.minimax.io/v1'),
        model: providers.standardModel,
        api: standardApi,
        transport: transportFor(standardApi),
        admissionBucket: /^minimax(?:-|$)/i.test(providers.standardModel) ? 'minimax' : 'standard',
        thinking: /^minimax(?:-|$)/i.test(providers.standardModel),
        maxTokens: maxOutputTokensForModel(providers.standardModel, routingPolicy),
      }
    : {
        apiKey: premiumApiKey,
        baseUrl: premiumBaseUrl,
        model: premiumModel,
        api: premiumApi,
        transport: transportFor(premiumApi),
        admissionBucket: /^minimax(?:-|$)/i.test(premiumModel) ? 'minimax' : 'premium',
        thinking: /^minimax(?:-|$)/i.test(premiumModel),
        maxTokens: maxOutputTokensForModel(premiumModel, routingPolicy),
      };

  const openaiModel: LlmTarget | null = providers.openAiApiKey
    ? {
        apiKey: providers.openAiApiKey,
        baseUrl: validateNativeOpenAiResponsesConfig(providers.openAiBaseUrl, providers.openAiApi),
        model: providers.openAiModel,
        api: 'responses',
        transport: 'responses',
        admissionBucket: 'luna',
        thinking: true,
        reasoningEffort: 'max',
      }
    : null;
  const codexCliModel: LlmTarget | null = runtime.codexCliEnabled
    ? {
        apiKey: '',
        model: DEFAULT_CODEX_CLI_MODEL,
        transport: 'codex-cli',
        admissionBucket: 'luna',
        thinking: true,
        reasoningEffort: DEFAULT_CODEX_CLI_REASONING_EFFORT,
      }
    : null;
  const deepseekModel: LlmTarget | null = providers.deepseekApiKey
    ? {
        apiKey: providers.deepseekApiKey,
        baseUrl: providers.deepseekBaseUrl,
        model: providers.deepseekModel,
        api: 'chat',
        transport: 'compatible-chat',
        admissionBucket: 'deepseek',
        thinking: true,
        reasoningEffort: 'max',
        maxTokens: maxOutputTokensForModel(providers.deepseekModel, routingPolicy),
      }
    : null;
  const deepseekFlashModel: LlmTarget | null = providers.deepseekApiKey
    ? {
        apiKey: providers.deepseekApiKey,
        baseUrl: providers.deepseekBaseUrl,
        model: providers.deepseekFlashModel,
        api: 'chat',
        transport: 'compatible-chat',
        admissionBucket: 'deepseek',
        thinking: true,
        reasoningEffort: 'max',
        maxTokens: maxOutputTokensForModel(providers.deepseekFlashModel, routingPolicy),
      }
    : null;

  return Object.freeze({
    github,
    llmApiKey: premiumApiKey,
    llmBaseUrl: premiumBaseUrl,
    llmModel: premiumModel,
    llmApi: premiumApi,
    standardModel,
    openaiModel,
    codexCliModel,
    deepseekModel,
    deepseekFlashModel,
    maxFileBytes: runtime.reviewInput.maxFileBytes,
    maxFiles: runtime.reviewInput.maxFiles,
    enableCheckRuns: runtime.reviewInput.checkRunsEnabled,
    store,
    reviewRuntime: Object.freeze({
      routingPolicy,
      accountLimits: runtime.accountLimits,
      usageCosts: Object.freeze({
        premium: runtime.pricing.premium,
        standard: runtime.pricing.standard,
        openai: runtime.pricing.openai,
        deepseek: runtime.pricing.deepseek,
        'deepseek-flash': runtime.pricing.deepseekFlash,
        modelRates: runtime.pricing.modelRates,
      }),
      preparation: Object.freeze({
        ...runtime.preparation,
        riskContextBoost: runtime.routing.riskHuntEnabled,
      }),
      publication: runtime.publication,
      execution: Object.freeze({
        ...runtime.execution,
        aggregation: createReviewAggregationConfig({
          runs: runtime.aggregationRuns,
          minOccurrences: runtime.aggregationMinOccurrences,
          temperature: runtime.aggregationTemperature,
          maxCandidates: runtime.aggregationMaxCandidates,
        }),
      }),
      verifyConcurrency: runtime.verifyConcurrency,
      cooldownSeconds: runtime.cooldownSeconds,
      verificationEnabled: runtime.verificationEnabled,
    }),
  });
}

/** Compatibility for narrowly scoped command/tests. Production passes config. */
export function loadWorkerConfig(
  store: AppDatabase,
  config: ServerConfig = loadServerConfig(),
): WorkerConfig {
  return createWorkerConfig(config, store);
}
