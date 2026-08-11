import {
  runCodexCliReview,
  type CodexCliReviewOptions,
  type CodexCliReviewResult,
} from '../codex-cli.js';
import { llmChat, type LlmClientOptions } from '../llm-client.js';
import type {
  ModelRunner,
  ModelTarget,
  ProviderDependencies,
  TextModelRunRequest,
} from './types.js';

type LlmTransport = Extract<
  ModelTarget['transport'],
  'responses' | 'compatible-chat' | 'anthropic'
>;

function assertTransport(target: ModelTarget, expected: LlmTransport): void {
  if (target.transport !== expected) {
    throw new Error(`Model target transport ${target.transport} cannot run on ${expected}`);
  }
}

function llmOptions(
  request: TextModelRunRequest,
  transport: LlmTransport,
  dependencies: ProviderDependencies,
): LlmClientOptions {
  assertTransport(request.target, transport);
  return {
    apiKey: request.target.apiKey,
    model: request.target.model,
    baseUrl: request.target.baseUrl,
    api: transport === 'compatible-chat' ? 'chat' : transport,
    reasoningEffort: request.target.reasoningEffort,
    maxTokens: request.target.maxTokens,
    json: request.json,
    thinking: request.thinking,
    temperature: request.temperature,
    signal: request.signal,
    onUsage: request.onUsage,
    onAttempt: request.onAttempt,
    attemptLineage: request.attemptLineage,
    dependencies,
  };
}

type LlmExecutor = (system: string, user: string, options: LlmClientOptions) => Promise<string>;

abstract class BaseTextRunner implements ModelRunner<TextModelRunRequest> {
  abstract readonly transport: LlmTransport;

  constructor(
    protected readonly dependencies: ProviderDependencies = {},
    private readonly execute: LlmExecutor = llmChat,
  ) {}

  run(request: TextModelRunRequest): Promise<string> {
    return this.execute(
      request.system,
      request.user,
      llmOptions(request, this.transport, this.dependencies),
    );
  }
}

export class ResponsesRunner extends BaseTextRunner {
  readonly transport = 'responses' as const;
}

export class CompatibleChatRunner extends BaseTextRunner {
  readonly transport = 'compatible-chat' as const;
}

export class AnthropicRunner extends BaseTextRunner {
  readonly transport = 'anthropic' as const;
}

export interface CodexCliRunRequest {
  files: Array<{ filename: string; status: string; patch?: string }>;
  target: ModelTarget;
  options?: Omit<CodexCliReviewOptions, 'model' | 'reasoningEffort' | 'onAttempt'>;
}

type CodexExecutor = (
  files: CodexCliRunRequest['files'],
  options: CodexCliReviewOptions,
) => Promise<CodexCliReviewResult>;

/** Explicit high-tier Luna adapter. The existing runner retains its pinned-model guard. */
export class CodexCliRunner implements ModelRunner<CodexCliRunRequest, CodexCliReviewResult> {
  readonly transport = 'codex-cli' as const;

  constructor(
    private readonly dependencies: ProviderDependencies = {},
    private readonly execute: CodexExecutor = runCodexCliReview,
  ) {}

  run(request: CodexCliRunRequest): Promise<CodexCliReviewResult> {
    if (request.target.transport !== this.transport) {
      throw new Error(`Model target transport ${request.target.transport} cannot run on codex-cli`);
    }
    return this.execute(request.files, {
      ...request.options,
      model: request.target.model,
      reasoningEffort: request.target.reasoningEffort,
      dependencies: this.dependencies,
    });
  }
}
