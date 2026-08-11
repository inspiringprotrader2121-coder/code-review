export const PROCESS_ROLES = ['all', 'api', 'worker', 'scheduler'] as const;

export type ProcessRole = (typeof PROCESS_ROLES)[number];

const PROCESS_ROLE_SET = new Set<string>(PROCESS_ROLES);

/**
 * A role keeps the legacy single-process deployment working while allowing a
 * production fleet to run API, review-worker, and scheduling responsibilities
 * independently.
 */
export function loadProcessRole(value: string | undefined): ProcessRole {
  const role = value?.trim().toLowerCase() || 'all';
  if (PROCESS_ROLE_SET.has(role)) return role as ProcessRole;
  throw new Error(`ORVEX_PROCESS_ROLE must be one of: ${PROCESS_ROLES.join(', ')}`);
}

export function processRoleRunsHttp(role: ProcessRole): boolean {
  return role === 'all' || role === 'api';
}

export function processRoleRunsWorkers(role: ProcessRole): boolean {
  return role === 'all' || role === 'worker';
}

export function processRoleRunsScheduler(role: ProcessRole): boolean {
  return role === 'all' || role === 'scheduler';
}
