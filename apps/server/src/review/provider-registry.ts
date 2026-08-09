import {
  AnthropicRunner,
  CodexCliRunner,
  CompatibleChatRunner,
  ResponsesRunner,
  runLlmReview,
  type CodexCliReviewOptions,
  type LlmReviewOptions,
  type LlmReviewResponse,
  type ModelRunner,
  type ProviderDependencies,
  type ReviewableFile,
  type TextModelRunRequest,
} from '@orvex-review/review';
import type { LlmTarget } from './worker-types.js';

type TextRunner = ModelRunner<TextModelRunRequest>;

export interface ProviderAdapterRegistryOptions {
  dependencies?: ProviderDependencies;
}

/** Dispatches by the explicit target transport. It has no URL/model inference. */
export class ProviderAdapterRegistry {
  private readonly runners: ReadonlyMap<LlmTarget['transport'], TextRunner | CodexCliRunner>;

  constructor(options: ProviderAdapterRegistryOptions = {}) {
    const dependencies = options.dependencies ?? {};
    this.runners = new Map<LlmTarget['transport'], TextRunner | CodexCliRunner>([
      ['responses', new ResponsesRunner(dependencies)],
      ['compatible-chat', new CompatibleChatRunner(dependencies)],
      ['anthropic', new AnthropicRunner(dependencies)],
      ['codex-cli', new CodexCliRunner(dependencies)],
    ]);
  }

  textRunnerFor(target: LlmTarget): TextRunner {
    if (target.transport === 'codex-cli') {
      throw new Error('Codex CLI target must use runCodexReview, never an HTTP provider adapter');
    }
    const runner = this.runners.get(target.transport);
    if (!runner) throw new Error(`No provider runner registered for ${target.transport}`);
    return runner as TextRunner;
  }

  async runReview(
    files: ReviewableFile[],
    target: LlmTarget,
    options: Omit<
      LlmReviewOptions,
      'apiKey' | 'model' | 'baseUrl' | 'api' | 'reasoningEffort' | 'maxTokens' | 'runner' | 'target'
    >,
  ): Promise<LlmReviewResponse> {
    return runLlmReview(files, {
      ...options,
      apiKey: target.apiKey,
      model: target.model,
      baseUrl: target.baseUrl,
      reasoningEffort: target.reasoningEffort,
      maxTokens: target.maxTokens,
      runner: this.textRunnerFor(target),
      target: {
        transport: target.transport,
        apiKey: target.apiKey,
        model: target.model,
        baseUrl: target.baseUrl,
        reasoningEffort: target.reasoningEffort,
        maxTokens: target.maxTokens,
      },
    });
  }

  runText(target: LlmTarget, request: Omit<TextModelRunRequest, 'target'>): Promise<string> {
    return this.textRunnerFor(target).run({
      ...request,
      target: {
        transport: target.transport,
        apiKey: target.apiKey,
        model: target.model,
        baseUrl: target.baseUrl,
        reasoningEffort: target.reasoningEffort,
        maxTokens: target.maxTokens,
      },
    });
  }

  runCodexReview(
    files: ReviewableFile[],
    target: LlmTarget,
    options: Omit<CodexCliReviewOptions, 'model' | 'reasoningEffort' | 'dependencies'>,
  ) {
    if (target.transport !== 'codex-cli') {
      throw new Error(`Target ${target.model} is not configured for Codex CLI transport`);
    }
    const runner = this.runners.get('codex-cli') as CodexCliRunner;
    return runner.run({
      files,
      target: {
        transport: 'codex-cli',
        apiKey: target.apiKey,
        model: target.model,
        reasoningEffort: target.reasoningEffort,
      },
      options,
    });
  }
}

/** Compatibility construction only. New worker configs should inject dependencies. */
export function createProviderAdapterRegistry(
  options: ProviderAdapterRegistryOptions = {},
): ProviderAdapterRegistry {
  return new ProviderAdapterRegistry(options);
}
