import type { ModelAttemptEvent, ModelRunner } from './types.js';

/**
 * Shared test helper for every adapter. A runner may retry, but each emitted
 * start must have exactly one matching terminal event and no orphan terminal.
 */
export async function assertAttemptLifecycle<TRequest, TResult>(
  runner: ModelRunner<TRequest, TResult>,
  request: TRequest,
  events: readonly ModelAttemptEvent[],
): Promise<TResult> {
  const result = await runner.run(request);
  const starts = events.filter(
    (event): event is Extract<ModelAttemptEvent, { phase: 'started' }> => event.phase === 'started',
  );
  const finishes = events.filter(
    (event): event is Extract<ModelAttemptEvent, { phase: 'finished' }> =>
      event.phase === 'finished',
  );
  const finishCounts = new Map(finishes.map((event) => [event.attemptId, 0]));
  for (const finish of finishes)
    finishCounts.set(finish.attemptId, (finishCounts.get(finish.attemptId) ?? 0) + 1);

  if (starts.length === 0) throw new Error(`${runner.transport} emitted no attempt start`);
  for (const start of starts) {
    if (finishCounts.get(start.attemptId) !== 1) {
      throw new Error(
        `${runner.transport} attempt ${start.attemptId} did not emit exactly one terminal event`,
      );
    }
  }
  for (const finish of finishes) {
    if (!starts.some((start) => start.attemptId === finish.attemptId)) {
      throw new Error(`${runner.transport} emitted terminal event without a start`);
    }
  }
  return result;
}
