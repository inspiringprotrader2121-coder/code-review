import {
  DEFAULT_CODEX_CLI_MODEL,
  DEFAULT_CODEX_CLI_REASONING_EFFORT,
  compileReviewPlan,
  type ReviewStage,
} from '@orvex-review/review';
import type { LlmTarget, PassTier, WorkerConfig } from './worker-types.js';
import { DEEPSEEK_REVIEW_OUTPUT_TOKENS, MINIMAX_REVIEW_OUTPUT_TOKENS } from './model-routing.js';

export interface ResolvedStageTarget {
  stage: ReviewStage;
  target: LlmTarget;
  tier: PassTier;
  mode: 'agentic' | 'investigate' | 'api';
  required: boolean;
}

export interface ResolvedPublicPlan {
  discovery: readonly ResolvedStageTarget[];
  verification: ResolvedStageTarget;
}

function requireTarget(target: LlmTarget | null, message: string): LlmTarget {
  if (!target) throw new Error(message);
  return target;
}

/**
 * The only catalog for fixed public-plan stages. It deliberately resolves named
 * slots, not URLs/model-name heuristics, so a provider change is localized here.
 */
export class ProviderCatalog {
  constructor(private readonly config: WorkerConfig) {}

  resolveStage(stage: ReviewStage, opts: { agenticLuna: boolean }): ResolvedStageTarget {
    switch (stage.modelSlot) {
      case 'luna': {
        const target = requireTarget(
          this.config.codexCliModel,
          'high-tier Luna requires the pinned Codex CLI; direct API substitution is disabled',
        );
        if (
          !opts.agenticLuna ||
          target.transport !== 'codex-cli' ||
          target.admissionBucket !== 'luna' ||
          !target.thinking ||
          target.model !== DEFAULT_CODEX_CLI_MODEL
        ) {
          throw new Error(
            'high-tier Luna requires the pinned Codex CLI; direct API substitution is disabled',
          );
        }
        if (target.reasoningEffort !== DEFAULT_CODEX_CLI_REASONING_EFFORT) {
          throw new Error('high-tier Luna must run at max reasoning effort');
        }
        return { stage, target, tier: 'openai', mode: 'agentic', required: stage.required };
      }
      case 'deepseek-flash': {
        const target = requireTarget(
          this.config.deepseekFlashModel,
          `DeepSeek v4 Flash is required for ${stage.id}`,
        );
        if (
          target.model.toLowerCase() !== 'deepseek-v4-flash' ||
          target.transport !== 'compatible-chat' ||
          target.admissionBucket !== 'deepseek' ||
          !target.thinking ||
          target.reasoningEffort !== 'max' ||
          target.maxTokens !== DEEPSEEK_REVIEW_OUTPUT_TOKENS
        ) {
          throw new Error(`DeepSeek v4 Flash at max reasoning is required for ${stage.id}`);
        }
        // Alongside Luna, Flash is the second agentic reviewer (checkout + tools).
        // Verification and dual-model discovery stay one-shot API calls.
        const mode =
          opts.agenticLuna && stage.kind === 'discovery' ? 'investigate' : 'api';
        return { stage, target, tier: 'deepseek-flash', mode, required: stage.required };
      }
      case 'minimax': {
        const target = this.config.standardModel;
        if (
          !/^minimax(?:-|$)/i.test(target.model) ||
          !['compatible-chat', 'anthropic'].includes(target.transport) ||
          target.admissionBucket !== 'minimax' ||
          !target.thinking ||
          target.maxTokens !== MINIMAX_REVIEW_OUTPUT_TOKENS
        ) {
          throw new Error(`MiniMax thinking is required for ${stage.id}`);
        }
        return { stage, target, tier: 'standard', mode: 'api', required: stage.required };
      }
    }
  }

  compilePublicPlan(
    modelTier: string | undefined,
    opts: { agenticLuna: boolean },
  ): ResolvedPublicPlan | null {
    const plan = compileReviewPlan(modelTier);
    if (!plan) return null;
    return {
      discovery: plan.discovery.map((stage) => this.resolveStage(stage, opts)),
      verification: this.resolveStage(plan.verification, opts),
    };
  }

  /** Resolves a named discovery stage for additive work on an already-compiled
   * public plan. This deliberately has no model-name or URL fallback. */
  resolvePublicDiscoveryStage(
    modelTier: string | undefined,
    modelIndex: number,
    opts: { agenticLuna: boolean },
  ): ResolvedStageTarget | null {
    const plan = this.compilePublicPlan(modelTier, opts);
    if (!plan) return null;
    const stage = plan.discovery.find((candidate) => candidate.stage.modelIndex === modelIndex);
    if (!stage) {
      throw new Error(`public review plan has no discovery stage at index ${modelIndex}`);
    }
    return stage;
  }
}

export function createProviderCatalog(config: WorkerConfig): ProviderCatalog {
  return new ProviderCatalog(config);
}
