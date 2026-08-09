import type { ReviewJobPayload, ReviewQueue } from '@orvex-review/queue';

export interface LeaseHeartbeat {
  leaseValid(): Promise<boolean>;
  stop(): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOwnershipLoss(message: string): boolean {
  return /lease lost/i.test(message);
}

/**
 * Keeps a claimed PR fenced while it runs. Only an explicit compare-and-swap
 * ownership failure is sticky; transient Redis trouble never discards a result
 * that has already spent provider budget or persisted a review run.
 */
export function startLeaseHeartbeat(input: {
  queue: Pick<ReviewQueue, 'renewLease'>;
  job: ReviewJobPayload;
  renewMs: number;
  log?: Pick<Console, 'warn'>;
}): LeaseHeartbeat {
  const log = input.log ?? console;
  let leaseLost = false;
  const key = `${input.job.installationId}/${input.job.owner}/${input.job.repo}#${input.job.pr}`;

  const renew = async (context: 'heartbeat' | 'check'): Promise<boolean> => {
    if (leaseLost) return false;
    if (!input.queue.renewLease) return true;
    try {
      await input.queue.renewLease(input.job);
      return true;
    } catch (error) {
      const message = messageOf(error);
      if (isOwnershipLoss(message)) {
        leaseLost = true;
        log.warn(`[worker] lease ownership lost for ${key}:`, message);
        return false;
      }
      log.warn(`[worker] transient lease ${context} failed for ${key}:`, message);
      return false;
    }
  };

  const timer = input.queue.renewLease
    ? setInterval(() => {
        void renew('heartbeat');
      }, input.renewMs)
    : undefined;
  timer?.unref?.();

  return {
    async leaseValid(): Promise<boolean> {
      if (leaseLost || !input.queue.renewLease) return !leaseLost;
      if (await renew('check')) return true;
      if (leaseLost) return false;
      // Retry a transient live check once. A second transient error still does
      // not revoke ownership: the completion CAS remains authoritative.
      const valid = await renew('check');
      if (!valid && !leaseLost) {
        log.warn(
          `[worker] lease check still transient for ${key}; treating as valid for completion`,
        );
        return true;
      }
      return valid;
    },
    stop(): void {
      if (timer) clearInterval(timer);
    },
  };
}
