import { sampleHostResources } from '../../active-reviews.js';

export interface HostAdmissionThresholds {
  /** Require this much MemAvailable (0 disables the memory gate). */
  minAvailableMemoryBytes: number;
  /** Require this much free disk on the monitored path (0 disables the disk gate). */
  minAvailableDiskBytes: number;
  diskPath?: string;
}

export interface HostAdmissionDecision {
  ok: boolean;
  reason?: string;
  availableMemoryBytes: number;
  availableDiskBytes: number;
}

/**
 * Refuse to claim a new review when the host is short on memory or sandbox disk.
 * A failed sample (unknown disk) fails open so a transient fs probe cannot stall
 * the fleet; only concrete below-threshold readings block dequeue.
 */
export function assessHostAdmission(thresholds: HostAdmissionThresholds): HostAdmissionDecision {
  const sample = sampleHostResources(thresholds.diskPath);
  const availableMemoryBytes = sample.memory.availableBytes;
  const availableDiskBytes = sample.disk.availableBytes;
  if (
    thresholds.minAvailableMemoryBytes > 0 &&
    availableMemoryBytes > 0 &&
    availableMemoryBytes < thresholds.minAvailableMemoryBytes
  ) {
    return {
      ok: false,
      reason: `available memory ${availableMemoryBytes} < ${thresholds.minAvailableMemoryBytes}`,
      availableMemoryBytes,
      availableDiskBytes,
    };
  }
  if (
    thresholds.minAvailableDiskBytes > 0 &&
    availableDiskBytes > 0 &&
    availableDiskBytes < thresholds.minAvailableDiskBytes
  ) {
    return {
      ok: false,
      reason: `available disk ${availableDiskBytes} < ${thresholds.minAvailableDiskBytes} on ${sample.disk.path}`,
      availableMemoryBytes,
      availableDiskBytes,
    };
  }
  return { ok: true, availableMemoryBytes, availableDiskBytes };
}
