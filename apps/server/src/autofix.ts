/**
 * Compatibility facade for queue-worker callers.
 *
 * Interactive command behavior lives in application/autofix so admission,
 * accounting, GitHub state, and command-specific mutation policies remain
 * independently testable. Keep this public shape stable for the worker.
 */
import type { ReviewJobPayload } from '@orvex-review/queue';
import { accountLimitReason, createUsageRecorder, type WorkerConfig } from './pipeline.js';
import type { ServerConfig } from './bootstrap/config.js';
import {
  processAskJob as ask,
  processExplainJob as explain,
  processFixJob as fix,
  processResolveJob as resolve,
  type AutofixDependencies,
  type FixResult,
} from './application/autofix/index.js';

export type { FixResult } from './application/autofix/index.js';

function dependenciesFrom(config: WorkerConfig): AutofixDependencies {
  return {
    github: config.github,
    store: config.store,
    standardModel: config.standardModel,
    maxFileBytes: config.maxFileBytes,
    maxFiles: config.maxFiles,
    leaseValid: config.leaseValid,
    createUsageRecorder: (runId, tenantId, stage) =>
      createUsageRecorder(config, runId, tenantId, 'standard', config.standardModel, stage),
    commandLimitReason: (owner, plan, tenantId) =>
      accountLimitReason(config.store, owner, plan, 1, 0, { tenantId, cogsOnly: true }),
  };
}

type Runtime = Pick<ServerConfig, 'autofix' | 'verificationEnabled'>;

export function processFixJob(
  job: ReviewJobPayload,
  config: WorkerConfig,
  runtime: Runtime,
): Promise<FixResult> {
  return fix(job, dependenciesFrom(config), runtime);
}

export function processExplainJob(
  job: ReviewJobPayload,
  config: WorkerConfig,
  runtime: Runtime,
): Promise<void> {
  return explain(job, dependenciesFrom(config), runtime);
}

export function processAskJob(
  job: ReviewJobPayload,
  config: WorkerConfig,
  runtime: Runtime,
): Promise<void> {
  return ask(job, dependenciesFrom(config), runtime);
}

export function processResolveJob(
  job: ReviewJobPayload,
  config: WorkerConfig,
  runtime: Runtime,
): Promise<void> {
  return resolve(job, dependenciesFrom(config), runtime);
}
