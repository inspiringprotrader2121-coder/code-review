/**
 * Circuit breaker for the worker pump: after several consecutive provider
 * rate-limit/quota/transport failures, pause dequeuing new jobs for a cooldown
 * instead of continuing to hammer a provider that's clearly down or exhausted.
 *
 * This is the direct fix for a real incident: once MiniMax's token plan was
 * exhausted, the worker kept dequeuing and immediately failing job after job —
 * a flurry of multi-second "reviews" with nothing useful happening. A few
 * consecutive failures should be enough to conclude "the provider is down right
 * now" and back off, then retry after the cooldown in case it recovered.
 *
 * Pure state-transition function — no timers, no I/O — so it's fully unit
 * testable; queue-runner.ts owns the actual mutable state and timer.
 */
export interface BackoffState {
  consecutiveFailures: number;
  pausedUntil: number; // epoch ms; 0 = not paused
}

export const INITIAL_BACKOFF_STATE: BackoffState = { consecutiveFailures: 0, pausedUntil: 0 };

export type JobOutcome = 'success' | 'transient_failure' | 'other_failure';

export function nextBackoffState(
  state: BackoffState,
  outcome: JobOutcome,
  now: number,
  opts: { threshold: number; backoffMs: number },
): BackoffState {
  // A success OR a non-provider failure (e.g. a genuine bug, bad diff) doesn't
  // indicate the provider is down — reset the streak. Only repeated transient
  // (rate-limit/quota/network) failures trip the breaker.
  if (outcome !== 'transient_failure') {
    return { consecutiveFailures: 0, pausedUntil: state.pausedUntil };
  }
  const consecutiveFailures = state.consecutiveFailures + 1;
  const pausedUntil =
    consecutiveFailures >= opts.threshold ? now + opts.backoffMs : state.pausedUntil;
  return { consecutiveFailures, pausedUntil };
}

export function isPaused(state: BackoffState, now: number): boolean {
  return now < state.pausedUntil;
}
