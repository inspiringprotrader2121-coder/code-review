import {
  classifyAgenticProviderFailure,
  extractAgenticParseText,
  isAgenticParseError,
  isAgenticTransientError,
} from './errors.js';
import type {
  AgenticLoopFailure,
  AgenticReviewLoopOptions,
  AgenticSourceLabel,
  AgenticTurn,
  AgenticTurnLog,
  AgenticTurnSource,
} from './types.js';

const DEFAULT_SEMANTIC_REPAIRS_PER_TURN = 2;

function failure(
  reason: AgenticLoopFailure['reason'],
  message: string,
  error?: unknown,
): AgenticLoopFailure {
  return { reason, message, error };
}

function responseShapeOf<TTool, TFinal>(
  classified: AgenticTurn<TTool, TFinal>,
): 'tool' | 'final' | 'invalid' {
  return classified.type === 'tool' ? 'tool' : classified.type === 'final' ? 'final' : 'invalid';
}

function sourceLabelFor(source: AgenticTurnSource, repairAttempt: number): AgenticSourceLabel {
  if (source !== 'recovery') return 'normal';
  return repairAttempt >= 2 ? 'repair_2' : 'repair_1';
}

/**
 * Shared agentic investigation loop. Any tool-capable reviewer injects generate /
 * classify / executeTool. Legal states on an active turn are TOOL or FINAL for
 * both normal and recovery generations.
 */
export async function runAgenticReviewLoop<TTool, TFinal, TResult>(
  options: AgenticReviewLoopOptions<TTool, TFinal, TResult>,
): Promise<TResult> {
  const maxTurns = Math.max(1, options.maxTurns);
  const maxSemanticRepairsPerTurn = Math.max(
    1,
    options.maxSemanticRepairsPerTurn ??
      options.maxConsecutiveParseFailures ??
      DEFAULT_SEMANTIC_REPAIRS_PER_TURN,
  );
  const maxTotalRepairAttempts =
    options.maxTotalRepairAttempts ?? Math.max(maxTurns, maxSemanticRepairsPerTurn);
  const lastTurnForcesFinal = options.lastTurnForcesFinal !== false;
  const isParseError = options.isParseError ?? isAgenticParseError;
  const extractParseText = options.extractParseText ?? extractAgenticParseText;
  const isTransientError = options.isTransientError ?? isAgenticTransientError;
  const classifyProviderFailure = options.classifyProviderFailure ?? classifyAgenticProviderFailure;
  const stage = options.stage ?? 'investigate';
  const startedMs = Date.now();
  let consecutiveParseFailures = 0;
  let totalRepairAttempts = 0;
  let toolCallCount = 0;

  const emit = (
    classified: AgenticTurn<TTool, TFinal>,
    turn: number,
    source: AgenticTurnSource,
    extra: Record<string, unknown> = {},
  ): void => {
    const responseShape = responseShapeOf(classified);
    const repairAttempt =
      typeof extra.repairAttempt === 'number' ? extra.repairAttempt : source === 'recovery' ? 1 : 0;
    options.log?.({
      runnerType: 'agentic',
      stage,
      turn,
      source,
      sourceLabel: sourceLabelFor(source, repairAttempt),
      kind: `${source}_${responseShape}`,
      responseShape,
      parseResult: classified.type,
      classifiedShape: classified.shape,
      continuationAttempt: 0,
      toolCallCount,
      totalRepairAttempts,
      consecutiveParseFailures,
      repairAttempt,
      semanticRepairAttempt: repairAttempt,
      agentTurnCount: turn + 1,
      accepted: classified.type !== 'invalid',
      reenteredAgentLoop: source === 'recovery' && classified.type === 'tool',
      model: options.model,
      provider: options.provider,
      reviewId: options.reviewId,
      accountId: options.accountId?.(),
      ...extra,
    } satisfies AgenticTurnLog);
  };

  const emitFailure = (turn: number, source: AgenticTurnSource, extra: Record<string, unknown>) => {
    const repairAttempt = typeof extra.repairAttempt === 'number' ? extra.repairAttempt : 0;
    options.log?.({
      runnerType: 'agentic',
      stage,
      turn,
      source,
      sourceLabel: sourceLabelFor(source, repairAttempt),
      kind: `${source}_invalid`,
      responseShape: 'invalid',
      parseResult: 'invalid',
      continuationAttempt: 0,
      toolCallCount,
      totalRepairAttempts,
      consecutiveParseFailures,
      repairAttempt,
      semanticRepairAttempt: repairAttempt,
      agentTurnCount: turn + 1,
      accepted: false,
      reenteredAgentLoop: false,
      model: options.model,
      provider: options.provider,
      reviewId: options.reviewId,
      accountId: options.accountId?.(),
      ...extra,
    });
  };

  const recover = async (
    turn: number,
    lastTurn: boolean,
    previousText: string,
  ): Promise<
    | { ok: true; classified: AgenticTurn<TTool, TFinal> }
    | { ok: false; reason: AgenticLoopFailure['reason']; message: string }
  > => {
    let previous = previousText;
    let lastMessage = 'agentic recovery reply remained unparseable';
    for (let attempt = 1; attempt <= maxSemanticRepairsPerTurn; attempt++) {
      if (totalRepairAttempts >= maxTotalRepairAttempts) {
        emitFailure(turn, 'recovery', {
          finishReason: 'repair_budget_exhausted',
          repairAttempt: attempt,
        });
        return {
          ok: false,
          reason: 'repair_budget_exhausted',
          message: 'agentic recovery budget exhausted',
        };
      }
      totalRepairAttempts++;
      consecutiveParseFailures++;
      const recoveryStarted = Date.now();
      try {
        const repaired = await options.generate({
          turn,
          lastTurn,
          source: 'recovery',
          previousText: previous,
          previousKind: 'malformed',
          thinking: false,
          repairAttempt: attempt,
        });
        const classified = options.classify(repaired);
        emit(classified, turn, 'recovery', {
          durationMs: Date.now() - recoveryStarted,
          repairAttempt: attempt,
        });
        if (classified.type !== 'invalid') {
          consecutiveParseFailures = 0;
          return { ok: true, classified };
        }
        previous = repaired;
        lastMessage = 'agentic recovery reply remained unparseable';
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        if (isTransientError(error)) throw error;
        if (isParseError(error)) {
          const extracted = extractParseText(error);
          if (extracted) {
            const classified = options.classify(extracted);
            emit(classified, turn, 'recovery', {
              durationMs: Date.now() - recoveryStarted,
              repairAttempt: attempt,
            });
            if (classified.type !== 'invalid') {
              consecutiveParseFailures = 0;
              return { ok: true, classified };
            }
            previous = extracted;
          } else {
            emitFailure(turn, 'recovery', {
              finishReason: 'parse_failure',
              durationMs: Date.now() - recoveryStarted,
              repairAttempt: attempt,
            });
          }
          lastMessage = error instanceof Error ? error.message : String(error);
          continue;
        }
        const reason = classifyProviderFailure(error);
        emitFailure(turn, 'recovery', {
          finishReason: reason,
          durationMs: Date.now() - recoveryStarted,
          repairAttempt: attempt,
        });
        return {
          ok: false,
          reason,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    emitFailure(turn, 'recovery', {
      finishReason: 'parse_failure',
      repairAttempt: maxSemanticRepairsPerTurn,
    });
    return {
      ok: false,
      reason: 'parse_failure',
      message: lastMessage,
    };
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    if (options.signal?.aborted)
      throw options.signal.reason ?? new Error('agentic review cancelled');
    const lastTurn = turn === maxTurns - 1;
    const turnStarted = Date.now();
    let classified: AgenticTurn<TTool, TFinal>;
    try {
      const text = await options.generate({
        turn,
        lastTurn,
        source: 'normal',
        previousText: '',
        thinking: lastTurn,
        repairAttempt: 0,
      });
      classified = options.classify(text);
      emit(classified, turn, 'normal', {
        durationMs: Date.now() - turnStarted,
        elapsedMs: Date.now() - startedMs,
        repairAttempt: 0,
      });
      if (classified.type === 'invalid') {
        const recovered = await recover(turn, lastTurn, text);
        if (!recovered.ok) {
          return options.onFailure(failure(recovered.reason, recovered.message));
        }
        classified = recovered.classified;
      } else {
        consecutiveParseFailures = 0;
      }
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      if (isTransientError(error)) {
        emitFailure(turn, 'normal', {
          finishReason: classifyProviderFailure(error),
          durationMs: Date.now() - turnStarted,
          repairAttempt: 0,
        });
        throw error;
      }
      if (isParseError(error)) {
        const previous = extractParseText(error);
        if (previous) {
          const recovered = options.classify(previous);
          if (recovered.type !== 'invalid') {
            consecutiveParseFailures = 0;
            emit(recovered, turn, 'normal', {
              durationMs: Date.now() - turnStarted,
              repairAttempt: 0,
            });
            classified = recovered;
          } else {
            const repaired = await recover(turn, lastTurn, previous);
            if (!repaired.ok) {
              return options.onFailure(failure(repaired.reason, repaired.message));
            }
            classified = repaired.classified;
          }
        } else {
          const repaired = await recover(turn, lastTurn, '');
          if (!repaired.ok) {
            return options.onFailure(failure(repaired.reason, repaired.message));
          }
          classified = repaired.classified;
        }
      } else {
        const reason = classifyProviderFailure(error);
        emitFailure(turn, 'normal', {
          finishReason: reason,
          durationMs: Date.now() - turnStarted,
          repairAttempt: 0,
        });
        if (turn === 0) throw error;
        return options.onFailure(
          failure(reason, error instanceof Error ? error.message : String(error), error),
        );
      }
    }

    if (classified.type === 'final') return options.onFinal(classified.value);
    if (classified.type === 'tool') {
      if (lastTurn && lastTurnForcesFinal) {
        if (totalRepairAttempts >= maxTotalRepairAttempts) {
          emitFailure(turn, 'recovery', {
            finishReason: 'repair_budget_exhausted',
            repairAttempt: 1,
          });
          return options.onFailure(
            failure(
              'repair_budget_exhausted',
              'last agentic turn returned a tool after repair budget',
            ),
          );
        }
        totalRepairAttempts++;
        try {
          const repairedText = await options.generate({
            turn,
            lastTurn: true,
            source: 'recovery',
            previousText: JSON.stringify(classified.value),
            previousKind: 'last_turn_tool',
            thinking: false,
            repairAttempt: 1,
          });
          const repaired = options.classify(repairedText);
          emit(repaired, turn, 'recovery', { lastTurnForcesFinal: true, repairAttempt: 1 });
          if (repaired.type === 'final') return options.onFinal(repaired.value);
          emitFailure(turn, 'recovery', {
            finishReason: 'tool_loop_exhaustion',
            lastTurnForcesFinal: true,
            repairAttempt: 1,
          });
        } catch (error) {
          if (options.signal?.aborted) throw options.signal.reason ?? error;
          if (isTransientError(error)) throw error;
          const reason = classifyProviderFailure(error);
          emitFailure(turn, 'recovery', {
            finishReason: reason,
            lastTurnForcesFinal: true,
            repairAttempt: 1,
          });
          return options.onFailure(
            failure(reason, error instanceof Error ? error.message : String(error), error),
          );
        }
        return options.onFailure(
          failure('tool_loop_exhaustion', 'last agentic turn required a final review'),
        );
      }
      await options.executeTool(classified.value);
      toolCallCount++;
      continue;
    }

    return options.onFailure(
      failure('parse_failure', 'agentic classifier returned no legal state'),
    );
  }

  emitFailure(maxTurns, 'normal', {
    finishReason: 'tool_loop_exhaustion',
    durationMs: Date.now() - startedMs,
    repairAttempt: 0,
  });
  return options.onFailure(
    failure('tool_loop_exhaustion', 'agentic review reached the tool-loop limit without a final'),
  );
}
