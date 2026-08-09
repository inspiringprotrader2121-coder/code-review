import type { GitHubAppConfig } from '@orvex-review/github';
import type { ReviewJobPayload } from '@orvex-review/queue';
import type { AppDatabase } from '@orvex-review/store';

export interface LlmTarget {
  apiKey: string;
  baseUrl?: string;
  model: string;
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
