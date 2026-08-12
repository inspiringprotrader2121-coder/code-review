import type { GitHubAppConfig } from '@orvex-review/github';
import type { ReviewJobPayload } from '@orvex-review/queue';
import type { AppDatabase } from '@orvex-review/store';
import type { ModelTransport, ProviderAdmission, ProviderDependencies } from '@orvex-review/review';
import type { ProviderAdapterRegistry } from './provider-registry.js';
import type { SandboxRuntimeOptions } from '../sandbox.js';
import type { RuntimeVerifyDependencies } from '../runtime-verify.js';

export interface LlmTarget {
  apiKey: string;
  baseUrl?: string;
  model: string;
  /** Explicit provider transport. Fixed public plans never infer this from URLs. */
  transport: ModelTransport;
  /** Stable admission bucket used before any paid stage begins. */
  admissionBucket: 'luna' | 'deepseek' | 'minimax' | string;
  /** Explicit reasoning/thinking policy for the contracted model stage. */
  thinking: boolean;
  /** Compatibility-only mirror for legacy call sites. */
  api?: 'chat' | 'responses' | 'anthropic';
  reasoningEffort?: string;
  maxTokens?: number;
}

export interface WorkerConfig {
  github: GitHubAppConfig;
  llmApiKey: string;
  llmBaseUrl?: string;
  llmApi?: 'chat' | 'responses' | 'anthropic';
  llmModel: string;
  standardModel: LlmTarget;
  openaiModel: LlmTarget | null;
  codexCliModel: LlmTarget | null;
  deepseekFlashModel: LlmTarget | null;
  deepseekModel: LlmTarget | null;
  maxFileBytes: number;
  maxFiles: number;
  enableCheckRuns: boolean;
  store: AppDatabase;
  leaseValid?: () => boolean | Promise<boolean>;
  persistJob?: (job: ReviewJobPayload) => Promise<void>;
  /** New provider path: injected per worker instead of a mutable module global. */
  providerAdmission?: ProviderAdmission;
  providerDependencies?: Omit<ProviderDependencies, 'admission'>;
  providerRegistry?: ProviderAdapterRegistry;
  /** Bootstrap-owned sandbox snapshot; absent only in narrow compatibility tests. */
  sandboxRuntime?: SandboxRuntimeOptions;
  /** Runtime verification bound to the same immutable sandbox snapshot. */
  runtimeVerifyDependencies?: RuntimeVerifyDependencies;
  /** Immutable bootstrap-owned policy snapshot. Compatibility fixtures may omit
   * this, but production workers are always constructed with it. */
  reviewRuntime?: Readonly<{
    routingPolicy: Readonly<{
      codexCliEnabled: boolean;
      codexRepoAllowed: (repoId: string) => boolean;
      investigateEnabled: boolean;
      riskHuntEnabled: boolean;
      investigateTier: 'deepseek-flash' | 'deepseek' | 'openai' | 'standard';
      deepseekMaxOutputTokens: number;
      minimaxMaxOutputTokens: number;
    }>;
    accountLimits: Readonly<{
      freeTierDailyCap: number;
      cogsReservationUsd: number;
      monthlyCogsCapUsd: number;
    }>;
    usageCosts: Readonly<
      Record<PassTier, Readonly<{ input: number; cachedInput?: number; output: number }>> & {
        modelRates?: Readonly<
          Record<string, Readonly<{ input: number; cachedInput?: number; output: number }>>
        >;
      }
    >;
    preparation: Readonly<{
      deepContextEnabled: boolean;
      contextSourceFiles: number;
      contextRelatedFiles: number;
      contextDependents: number;
      contextFileBytes: number;
      riskContextBoost: boolean;
      archiveMaxBytes: number;
    }>;
    publication: Readonly<{
      requestChangesOnP1: boolean;
      maxUnanchoredComments: number;
      failCheckOnP1: boolean;
    }>;
    execution: Readonly<{
      abortPollMs: number;
      maxCalls: number;
      concurrency: number;
      maxOtherChars: number;
      sweepFileChars: number;
      maxInlinePerPr: number;
      aggregation: Readonly<{
        runs: number;
        minOccurrences: number;
        temperature: number;
        maxCandidates: number;
        enabled: boolean;
        disabledReason?: string;
      }>;
    }>;
    verifyConcurrency: number;
    cooldownSeconds: number;
    verificationEnabled: boolean;
  }>;
}

export type ModelTier =
  | 'premium'
  | 'standard'
  | 'hybrid'
  | 'openai'
  | 'codex-hybrid'
  | 'multi-model'
  | 'dual-model';

export type PassTier = 'premium' | 'standard' | 'openai' | 'deepseek' | 'deepseek-flash';
