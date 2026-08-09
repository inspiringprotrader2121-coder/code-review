export class ReviewCancelledError extends Error {
  override name = 'ReviewCancelledError';

  constructor(message = 'review cancelled') {
    super(message);
  }
}

export function isReviewCancelledError(error: unknown): boolean {
  return (
    error instanceof ReviewCancelledError ||
    (error as { name?: string })?.name === 'ReviewCancelledError'
  );
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ReviewCancelledError();
}

export function linkAbortSignal(
  signal: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!signal) return () => {};
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener('abort', abort);
}
