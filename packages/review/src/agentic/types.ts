/** Legal states for one agentic investigation turn. Provider adapters must not add more. */
export type AgenticTurn<TTool, TFinal> =
  | { type: 'tool'; value: TTool; shape?: string }
  | { type: 'final'; value: TFinal; shape?: string }
  | { type: 'invalid'; shape?: string };

export type AgenticTurnSource = 'normal' | 'recovery';

/** Production log label for which generation produced this turn. */
export type AgenticSourceLabel = 'normal' | 'repair_1' | 'repair_2';

export type AgenticFailureReason =
  | 'parse_failure'
  | 'repair_budget_exhausted'
  | 'tool_loop_exhaustion'
  | 'timeout'
  | 'rate_limit'
  | 'provider_error'
  | 'cancelled';

export interface AgenticGenerateRequest {
  turn: number;
  lastTurn: boolean;
  source: AgenticTurnSource;
  previousText: string;
  /** Why previousText is attached. Last-turn tools are valid protocol nudges, not malformed JSON. */
  previousKind?: 'malformed' | 'last_turn_tool';
  thinking: boolean;
  /**
   * 0 for a normal generation. Semantic-repair attempts are 1 then 2.
   * Last-turn forced-final recovery is also 1 (one final-only repair).
   */
  repairAttempt?: number;
}

export interface AgenticTurnLog {
  runnerType: 'agentic';
  stage: string;
  turn: number;
  source: AgenticTurnSource;
  sourceLabel?: AgenticSourceLabel;
  kind: `${AgenticTurnSource}_${'tool' | 'final' | 'invalid'}`;
  responseShape: 'tool' | 'final' | 'invalid';
  parseResult: 'tool' | 'final' | 'invalid';
  classifiedShape?: string;
  toolCallCount: number;
  totalRepairAttempts: number;
  consecutiveParseFailures: number;
  /** 0 for normal; 1 or 2 for a fresh semantic repair. */
  repairAttempt?: number;
  semanticRepairAttempt?: number;
  agentTurnCount?: number;
  accepted: boolean;
  reenteredAgentLoop: boolean;
  schemaEnforced?: boolean;
  schemaName?: string | null;
  toolsEnabled?: boolean;
  toolChoice?: 'tool_or_final' | 'final_only';
  api?: string;
  /** Transport-level JSON continuations are logged on [llm] lines; agentic turns stay 0. */
  continuationAttempt: number;
  model?: string;
  provider?: string;
  accountId?: number;
  reviewId?: string;
  finishReason?: string;
  durationMs?: number;
  [key: string]: unknown;
}

export interface AgenticLoopFailure {
  reason: AgenticFailureReason;
  message: string;
  error?: unknown;
}

export interface AgenticReviewLoopOptions<TTool, TFinal, TResult> {
  maxTurns: number;
  /** Per-turn fresh semantic repairs after a completed contract miss. Default 2. */
  maxSemanticRepairsPerTurn?: number;
  /** Alias for maxSemanticRepairsPerTurn when the newer option is omitted. */
  maxConsecutiveParseFailures?: number;
  maxTotalRepairAttempts?: number;
  /**
   * Last-turn budget policy applied equally to normal and recovery generations.
   * When true, a tool on the final remaining turn is not executed; one final-only
   * recovery is attempted instead. This is a loop bound, not a repair-only rule.
   */
  lastTurnForcesFinal?: boolean;
  classify: (text: string) => AgenticTurn<TTool, TFinal>;
  generate: (request: AgenticGenerateRequest) => Promise<string>;
  executeTool: (tool: TTool) => Promise<void>;
  onFinal: (value: TFinal) => TResult;
  onFailure: (failure: AgenticLoopFailure) => TResult;
  isParseError?: (error: unknown) => boolean;
  extractParseText?: (error: unknown) => string;
  isTransientError?: (error: unknown) => boolean;
  classifyProviderFailure?: (error: unknown) => AgenticFailureReason;
  log?: (entry: AgenticTurnLog) => void;
  signal?: AbortSignal;
  stage?: string;
  model?: string;
  provider?: string;
  reviewId?: string;
  accountId?: () => number | undefined;
}
