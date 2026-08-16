export type QueueJobState =
  | 'submitted'
  | 'ready'
  | 'claimed'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'dead-lettered';

const TRANSITIONS: Readonly<Record<QueueJobState, readonly QueueJobState[]>> = Object.freeze({
  submitted: ['ready', 'cancelled'],
  ready: ['claimed', 'cancelled'],
  claimed: ['running', 'ready', 'cancelled', 'dead-lettered'],
  running: ['succeeded', 'failed', 'cancelled', 'dead-lettered', 'ready'],
  succeeded: [],
  failed: ['ready', 'dead-lettered'],
  cancelled: [],
  'dead-lettered': ['ready'],
});

export function canTransitionJob(from: QueueJobState, to: QueueJobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertJobTransition(from: QueueJobState, to: QueueJobState): void {
  if (!canTransitionJob(from, to)) {
    throw new Error(`invalid queue transition ${from} -> ${to}`);
  }
}
