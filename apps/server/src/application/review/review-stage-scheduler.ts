import {
  buildReviewPassAngles,
  detectRiskSignals,
  fitReviewAggregationToBudget,
  maxRiskProbes,
  RISK_HUNT_FOCUS,
  riskProbeFocus,
  selectRiskProbes,
  type ReviewPromptContext,
  type ReviewStage,
} from '@orvex-review/review';
import type { ChangedFile, RepoContext } from '@orvex-review/github';
import type { PlanFeatures } from '@orvex-review/tenants';
import {
  canRunRiskHunt,
  contextForReviewPass,
  modelForPass,
  modelForRiskHunt,
  type ReviewRoutingPolicy,
} from '../../review/model-routing.js';
import type { ProviderCatalog } from '../../review/provider-catalog.js';
import type { LlmTarget, ModelTier, PassTier, WorkerConfig } from '../../review/worker-types.js';
import {
  takeReviewCallsByPriority,
  type ReviewExecutionPolicy,
} from './review-execution-policy.js';

export interface ReviewCall {
  label: string;
  kind: 'pass' | 'sweep';
  mode: 'agentic' | 'investigate' | 'api';
  ctx: ReviewPromptContext;
  target: LlmTarget;
  tier: PassTier;
  passTag?: string;
  sample: number;
  modelPassIndex?: number;
  stage?: ReviewStage;
  temperature?: number;
  bestEffort?: boolean;
  files?: ChangedFile[];
  /** Stable required diff chunk identity. A sibling chunk cannot satisfy it. */
  requiredCoverageKey?: string;
}

export interface ReviewStageSchedule {
  calls: ReviewCall[];
  discoveryPasses: number;
}

export interface ScheduledReviewCalls {
  calls: ReviewCall[];
  aggregation: ReturnType<typeof fitReviewAggregationToBudget>;
}

const FOCUSED_REVIEW_DIFF_BUDGET_CHARS = 14_000;
const FOCUSED_REVIEW_HUNK_CHUNK_CHARS = 6_000;

function withFileShard(
  call: ReviewCall,
  shard: ChangedFile[],
  note: string,
  context: 'focused-source' | 'diff-only',
  replaceExistingFocus = false,
  diffBudgetChars?: number,
  requiredCoverageKey?: string,
): ReviewCall {
  const paths = new Set(shard.map((file) => file.filename));
  const changedContents =
    context === 'focused-source'
      ? call.ctx.changedContents?.filter((file) => paths.has(file.path))
      : undefined;
  return {
    ...call,
    files: shard,
    ctx: {
      ...(context === 'diff-only' ? { promptProfile: 'focused' as const } : {}),
      ...(diffBudgetChars ? { diffBudgetChars, diffCoverage: 'require-complete' as const } : {}),
      changedContents,
      extraFocus: replaceExistingFocus
        ? note
        : [call.ctx.extraFocus, note].filter(Boolean).join('\n'),
    },
    ...(requiredCoverageKey ? { requiredCoverageKey } : {}),
  };
}

function patchWeight(file: ChangedFile): number {
  return Math.max(1, file.patch?.length ?? 0);
}

function hunkHeaderParts(
  header: string,
): { oldStart: number; newStart: number; suffix: string } | undefined {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(header);
  if (!match) return undefined;
  return { oldStart: Number(match[1]), newStart: Number(match[2]), suffix: match[3] ?? '' };
}

function hunkLineCounts(line: string): { old: number; next: number } {
  if (line.startsWith('+')) return { old: 0, next: 1 };
  if (line.startsWith('-')) return { old: 1, next: 0 };
  if (line.startsWith('\\')) return { old: 0, next: 0 };
  return { old: 1, next: 1 };
}

/** Split an oversized unified-diff hunk while retaining valid line anchors. */
function splitOversizedHunk(hunk: string, maxChars: number): string[] {
  const [header, ...body] = hunk.split('\n');
  if (body.at(-1) === '') body.pop();
  const parts = hunkHeaderParts(header ?? '');
  if (!parts || body.length === 0) return [hunk];
  const chunks: string[] = [];
  let lines: string[] = [];
  let oldStart = parts.oldStart;
  let newStart = parts.newStart;
  let oldCount = 0;
  let newCount = 0;
  const render = () =>
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${parts.suffix}\n${lines.join('\n')}`;
  const flush = () => {
    if (lines.length === 0) return;
    chunks.push(render());
    oldStart += oldCount;
    newStart += newCount;
    lines = [];
    oldCount = 0;
    newCount = 0;
  };
  for (const line of body) {
    const proposed = `${render()}\n${line}`;
    if (lines.length > 0 && proposed.length > maxChars) flush();
    lines.push(line);
    const counts = hunkLineCounts(line);
    oldCount += counts.old;
    newCount += counts.next;
  }
  flush();
  return chunks.length > 0 ? chunks : [hunk];
}

function splitRawPatchFragment(file: ChangedFile, maxChars: number): ChangedFile[] {
  const patch = file.patch;
  if (!patch || patch.length <= maxChars) return [file];
  const fragments: ChangedFile[] = [];
  let offset = 0;
  while (offset < patch.length) {
    const marker =
      offset === 0 ? '' : `... [continued exact raw diff fragment at character ${offset}] ...\n`;
    const available = Math.max(1, maxChars - marker.length);
    let end = Math.min(patch.length, offset + available);
    if (end < patch.length) {
      const newline = patch.lastIndexOf('\n', end);
      if (newline > offset) end = newline + 1;
    }
    fragments.push({ ...file, patch: `${marker}${patch.slice(offset, end)}` });
    offset = end;
  }
  return fragments;
}

/** Break large files at hunk boundaries, retaining every byte of every patch. */
function splitFileForFocusedReview(file: ChangedFile): ChangedFile[] {
  const patch = file.patch;
  if (!patch || patch.length <= FOCUSED_REVIEW_HUNK_CHUNK_CHARS) return [file];
  const lines = patch.split('\n');
  const hunkStarts = lines
    .map((line, index) => (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (hunkStarts.length === 0) return splitRawPatchFragment(file, FOCUSED_REVIEW_HUNK_CHUNK_CHARS);
  const prefix = lines.slice(0, hunkStarts[0]).join('\n');
  const chunks: string[] = [];
  for (let index = 0; index < hunkStarts.length; index++) {
    const start = hunkStarts[index]!;
    const end = hunkStarts[index + 1] ?? lines.length;
    const hunk = lines.slice(start, end).join('\n');
    chunks.push(...splitOversizedHunk(hunk, FOCUSED_REVIEW_HUNK_CHUNK_CHARS));
  }
  if (chunks.length < 2) return splitRawPatchFragment(file, FOCUSED_REVIEW_HUNK_CHUNK_CHARS);
  return chunks.flatMap((chunk, index) =>
    splitRawPatchFragment(
      { ...file, patch: index === 0 && prefix ? `${prefix}\n${chunk}` : chunk },
      FOCUSED_REVIEW_HUNK_CHUNK_CHARS,
    ),
  );
}

/** Pack complete diff fragments in source order under the provider prompt budget. */
function completeDiffShards(files: ChangedFile[]): ChangedFile[][] {
  const units = files.flatMap(splitFileForFocusedReview);
  const shards: ChangedFile[][] = [];
  let shard: ChangedFile[] = [];
  let used = 0;
  for (const unit of units) {
    const weight = patchWeight(unit);
    if (weight > FOCUSED_REVIEW_DIFF_BUDGET_CHARS) {
      throw new Error(
        `required complete diff unit for ${unit.filename} exceeds ${FOCUSED_REVIEW_DIFF_BUDGET_CHARS}-character budget`,
      );
    }
    if (shard.length > 0 && used + weight > FOCUSED_REVIEW_DIFF_BUDGET_CHARS) {
      shards.push(shard);
      shard = [];
      used = 0;
    }
    shard.push(unit);
    used += weight;
  }
  if (shard.length > 0) shards.push(shard);
  return shards;
}

function coverageKey(call: ReviewCall, shardIndex: number, shardCount: number): string {
  const lens = call.stage ?? call.passTag ?? call.target.model.toLowerCase();
  return `required:${lens}:${call.modelPassIndex ?? 'unindexed'}:chunk:${shardIndex + 1}/${shardCount}`;
}

function compactCompleteDiffFocus(
  call: ReviewCall,
  shardIndex: number,
  shardCount: number,
): string {
  const lens =
    call.passTag === 'deep-dive'
      ? 'Audit concrete regressions in data integrity, authorization, concurrency, and failure/cleanup branch parity.'
      : call.passTag === 'removed-behavior/callers'
        ? 'Audit deleted or changed behaviour and visible caller/test contracts.'
        : 'Audit concrete performance, completeness, and API-contract regressions.';
  return `REQUIRED COMPLETE DIFF CHUNK ${shardIndex + 1}/${shardCount}: review every supplied diff hunk in this chunk. This is one explicit coverage unit of a larger PR; do not infer a clean result for chunks you were not given. ${lens} Use the configured maximum reasoning effort, complete one evidence-led pass, and return compact JSON before the worker time limit. Report at most 3 concrete findings, each with a file:line and failure scenario. Do not narrate private reasoning.`;
}

/**
 * Expand required API stages across every bounded diff chunk. This preserves the
 * fixed model-role lineup while allowing very large PRs to use additional calls
 * rather than silently sampling a prompt.
 */
export function boundHighTierDiscoveryWorkloads(
  calls: ReviewCall[],
  files: ChangedFile[],
): ReviewCall[] {
  const requiredApi = new Set(
    calls.filter((call) => call.kind === 'pass' && call.mode === 'api' && !call.bestEffort),
  );
  if (requiredApi.size === 0 || files.length === 0) return calls;
  const shards = completeDiffShards(files);
  return calls.flatMap((call) => {
    if (!requiredApi.has(call)) return [call];
    return shards.map((shard, shardIndex) => {
      const key = coverageKey(call, shardIndex, shards.length);
      const sharded = withFileShard(
        call,
        shard,
        compactCompleteDiffFocus(call, shardIndex, shards.length),
        'diff-only',
        true,
        FOCUSED_REVIEW_DIFF_BUDGET_CHARS,
        key,
      );
      return { ...sharded, label: `${call.label} chunk ${shardIndex + 1}/${shards.length}` };
    });
  });
}

/** Applies the call budget after the immutable plan lineup has been constructed. */
export function selectScheduledReviewCalls(input: {
  calls: ReviewCall[];
  discoveryPasses: number;
  maxCalls: number;
  plan: PlanFeatures;
  config: WorkerConfig;
  routing: ReviewRoutingPolicy;
  catalog: ProviderCatalog;
  requestedAggregation: ReviewExecutionPolicy['aggregation'];
  skippedLenses: string[];
}): ScheduledReviewCalls {
  const investigate = input.calls.filter((call) => call.mode === 'investigate');
  const risk = input.calls.filter((call) => call.passTag === 'risk-hunt');
  const passes = input.calls.filter(
    (call) => call.kind === 'pass' && call.mode !== 'investigate' && call.passTag !== 'risk-hunt',
  );
  const requiredPasses = passes.filter((call) => !call.bestEffort);
  const optionalPasses = passes.filter((call) => call.bestEffort);
  const sweeps = input.calls.filter((call) => call.kind === 'sweep');
  const aggregation = fitReviewAggregationToBudget(
    input.requestedAggregation,
    passes.length,
    input.maxCalls,
    Math.min(
      sweeps.length + investigate.length + risk.length,
      Math.max(0, input.maxCalls - passes.length),
    ),
  );
  if (input.requestedAggregation.enabled && !aggregation.enabled) {
    console.warn(`[worker] repeated-review aggregation disabled: ${aggregation.disabledReason}`);
  }
  let calls: ReviewCall[];
  if (aggregation.enabled) {
    const repeated = Array.from({ length: aggregation.effectiveRuns }, (_, sample) =>
      passes.map((call) => {
        if (sample === 0)
          return { ...call, label: `${call.label} sample 1/${aggregation.effectiveRuns}`, sample };
        const repeatedAgentic = call.mode === 'agentic';
        const fixedRoute = call.stage
          ? input.catalog.resolveStage(call.stage, { agenticLuna: repeatedAgentic })
          : null;
        // Existing calls were already compiled from the public plan. Repeating a
        // sample changes only its temperature, never its provider route.
        const routed = fixedRoute ?? { target: call.target, tier: call.tier };
        return {
          ...call,
          label: `${call.label} sample ${sample + 1}/${aggregation.effectiveRuns}`,
          mode: fixedRoute?.mode ?? (repeatedAgentic ? 'agentic' : 'api'),
          target: routed.target,
          tier: routed.tier,
          sample,
          temperature: aggregation.temperature,
        };
      }),
    ).flat();
    calls = takeReviewCallsByPriority(
      repeated.filter((call) => !call.bestEffort),
      [...repeated.filter((call) => call.bestEffort), ...sweeps, ...investigate, ...risk],
      input.maxCalls,
    );
  } else {
    calls = takeReviewCallsByPriority(
      requiredPasses,
      [...optionalPasses, ...sweeps, ...investigate, ...risk],
      input.maxCalls,
    );
  }
  if (investigate.length > 0 && !calls.some((call) => call.mode === 'investigate')) {
    console.warn('[worker] investigate skipped: maxCalls budget exhausted before investigate');
    input.skippedLenses.push('investigate (call budget exhausted)');
  }
  const keptRisk = calls.filter((call) => call.passTag === 'risk-hunt').length;
  if (keptRisk < risk.length) {
    const dropped = risk.length - keptRisk;
    console.warn(`[worker] ${dropped} risk probe(s) skipped: maxCalls budget exhausted`);
    input.skippedLenses.push(`risk-hunt (call budget exhausted, ${dropped} probe(s))`);
  }
  return { calls, aggregation };
}

/** Produces the exact fixed reviewer lineup before any provider is permitted to spend. */
export function scheduleReviewStages(input: {
  job: { deep?: boolean };
  plan: PlanFeatures;
  config: WorkerConfig;
  policy: ReviewExecutionPolicy;
  routing: ReviewRoutingPolicy;
  catalog: ProviderCatalog;
  useCodexCli: boolean;
  investigateModel: ReturnType<
    typeof import('../../review/model-routing.js').modelForInvestigate
  > | null;
  investigateCheckoutAvailable: boolean;
  filesForLlm: ChangedFile[];
  highRiskDiff: boolean;
  context?: RepoContext;
  skippedLenses: string[];
}): ReviewStageSchedule {
  const baseCtx: ReviewPromptContext = { ...(input.context ?? {}) };
  const passOthers = (input.context?.others ?? []).slice(
    0,
    input.plan.retrievalTopK + (input.highRiskDiff && input.routing.riskHuntEnabled ? 8 : 0),
  );
  const passCtx = { ...baseCtx, others: passOthers };
  const passAngles = buildReviewPassAngles({
    modelTier: input.plan.modelTier as ModelTier | undefined,
    deep: Boolean(input.job.deep),
    files: input.filesForLlm,
  });
  const discoveryPasses = input.catalog.compilePublicPlan(input.plan.modelTier, {
    agenticLuna: input.useCodexCli,
  })
    ? passAngles.length
    : passAngles.slice(0, Math.max(1, input.plan.reviewPasses)).length;
  const discoveryAngles = passAngles.slice(0, discoveryPasses);
  const deepExtras: Array<{ tag: string; focus: string; modelIdx: number }> = input.job.deep
    ? [
        {
          tag: 'deep:removed-behavior',
          modelIdx: 1,
          focus:
            'EXTRA DEEP-REVIEW PASS — REMOVED-BEHAVIOR & CALLER AUDIT. For every line this diff DELETES or replaces: name the invariant/behavior it enforced, then verify where the new code re-establishes it — a dropped guard, narrowed validation, or deleted error path that is NOT re-established is a finding. Then trace every changed function to its CALLERS: does any call site break on a new precondition, changed return shape, new exception, or ordering change? Report only concrete breakages with file:line.',
        },
        {
          tag: 'deep:second-opinion',
          modelIdx: 0,
          focus:
            'EXTRA DEEP-REVIEW PASS — ADVERSARIAL SECOND OPINION. Assume earlier review passes MISSED at least one real defect. Do not repeat the obvious; hunt specifically where reviews go blind: async boundaries and unawaited promises, error/cleanup paths, resource lifecycle (open/close/retry), identity scoping (tenant/user leaking across a boundary), and off-by-one/boundary conditions in new loops or slices. Report only findings with a concrete failure scenario.',
        },
      ]
    : [];
  if (input.job.deep)
    console.log(`[worker] deep review requested: +${deepExtras.length} extra passes`);

  const calls: ReviewCall[] = [];
  const totalDiscoverySlots = discoveryAngles.length + deepExtras.length;
  for (const [index, angle] of discoveryAngles.entries()) {
    const fixedRoute = angle.stage
      ? input.catalog.resolveStage(angle.stage, { agenticLuna: input.useCodexCli })
      : null;
    const routed =
      fixedRoute ??
      modelForPass(input.config, input.plan, angle.modelIdx, input.useCodexCli, input.routing);
    const lensContext = contextForReviewPass(passCtx, angle.modelIdx);
    calls.push({
      label: `pass ${index + 1}/${totalDiscoverySlots} (${angle.tag}) [${routed.target.model}]`,
      kind: 'pass',
      mode: fixedRoute?.mode ?? (input.useCodexCli && routed.tier === 'openai' ? 'agentic' : 'api'),
      ctx: angle.focus ? { ...lensContext, extraFocus: angle.focus } : lensContext,
      target: routed.target,
      tier: routed.tier,
      passTag: angle.tag,
      sample: 0,
      modelPassIndex: angle.modelIdx,
      stage: angle.stage,
      bestEffort: angle.bestEffort === true || fixedRoute?.required === false,
    });
  }
  for (const [index, extra] of deepExtras.entries()) {
    const extraUsesCodex = extra.modelIdx === 0 && input.useCodexCli;
    const routed =
      input.catalog.resolvePublicDiscoveryStage(input.plan.modelTier, extra.modelIdx, {
        agenticLuna: extraUsesCodex,
      }) ?? modelForPass(input.config, input.plan, extra.modelIdx, extraUsesCodex, input.routing);
    calls.push({
      label: `pass ${discoveryAngles.length + index + 1}/${totalDiscoverySlots} (${extra.tag}) [${routed.target.model}]`,
      kind: 'pass',
      mode: extraUsesCodex ? 'agentic' : 'api',
      ctx: { ...contextForReviewPass(passCtx, extra.modelIdx), extraFocus: extra.focus },
      target: routed.target,
      tier: routed.tier,
      passTag: extra.tag,
      sample: 0,
      modelPassIndex: extra.modelIdx,
      bestEffort: true,
    });
  }
  if (input.investigateModel && input.investigateCheckoutAvailable) {
    calls.push({
      label: `pass investigate (${input.investigateModel.target.model})`,
      kind: 'pass',
      mode: 'investigate',
      ctx: {
        ...passCtx,
        extraFocus:
          'INVESTIGATE PASS — P1-FIRST multi-hop search with tools. Prioritize only Critical/High defects this PR introduces or exposes: auth/authz bypass, data loss/corruption, resource leak on failure, asymmetric error paths (success records X but failure skips it), Promise.all/batch partial cleanup, dead checks after refactor, post-transform null/inconsistency, cross-tenant/identity scoping, auth/outage gate bypass, case-insensitive path allowlist drift, pagination past a hard ceiling, and OpenAPI/UI contract drift. Procedure: (1) list symbols this diff deletes or renames and grep their remaining callers; (2) for each changed function, read its full body + immediate callers/callees; (3) compare success vs failure/cleanup paths; (4) kill hypotheses that the code already handles. Report only concrete P1/P2 bugs with file:line and a failure scenario — no style/nits.',
      },
      target: input.investigateModel.target,
      tier: input.investigateModel.tier,
      passTag: 'investigate',
      sample: 0,
      modelPassIndex: 100,
      bestEffort: true,
    });
    console.log(`[worker] investigate pass enabled on ${input.investigateModel.target.model}`);
  }
  const riskHuntModel = modelForRiskHunt(input.config);
  if (
    canRunRiskHunt(
      input.plan,
      { highRisk: input.highRiskDiff, hasFlash: Boolean(riskHuntModel) },
      input.routing,
    ) &&
    riskHuntModel
  ) {
    const probes = selectRiskProbes(
      detectRiskSignals(input.filesForLlm),
      maxRiskProbes(input.plan),
    );
    const hunts =
      probes.length > 0
        ? probes.map((signal) => ({
            tag: `risk-probe:${signal.id}`,
            focus: riskProbeFocus(signal),
          }))
        : [{ tag: 'risk-hunt', focus: RISK_HUNT_FOCUS }];
    hunts.forEach((hunt, index) =>
      calls.push({
        label: `pass ${hunt.tag} (${riskHuntModel.target.model})`,
        kind: 'pass',
        mode: 'api',
        ctx: { ...passCtx, extraFocus: hunt.focus },
        target: riskHuntModel.target,
        tier: riskHuntModel.tier,
        passTag: 'risk-hunt',
        sample: 0,
        modelPassIndex: 101 + index,
        bestEffort: true,
      }),
    );
    console.log(
      `[worker] risk hunt enabled on ${riskHuntModel.target.model} (high-risk diff): ${hunts.map((hunt) => hunt.tag).join(', ')}`,
    );
  } else if (input.highRiskDiff && input.routing.riskHuntEnabled && !riskHuntModel) {
    input.skippedLenses.push('risk-hunt (DeepSeek Flash unavailable)');
  }
  const sweepSource = input.plan.repoSweep
    ? (input.context?.others ?? []).slice(input.plan.retrievalTopK)
    : [];
  if (sweepSource.length > 0) {
    const sweepModel =
      input.catalog.resolvePublicDiscoveryStage(input.plan.modelTier, 0, {
        agenticLuna: input.useCodexCli,
      }) ?? modelForPass(input.config, input.plan, 0, input.useCodexCli, input.routing);
    const budget = input.policy.maxOtherChars - 2_000;
    let batch: Array<{ path: string; content: string }> = [];
    let used = 0;
    const pushBatch = () => {
      if (batch.length === 0) return;
      const files = batch;
      calls.push({
        label: `sweep (${files.length}f)`,
        kind: 'sweep',
        mode: input.useCodexCli && sweepModel.tier === 'openai' ? 'agentic' : 'api',
        ctx: { ...baseCtx, related: [], dependents: [], others: files },
        target: sweepModel.target,
        tier: sweepModel.tier,
        sample: 0,
      });
      batch = [];
      used = 0;
    };
    for (const file of sweepSource) {
      const content =
        file.content.length > input.policy.sweepFileChars
          ? `${file.content.slice(0, input.policy.sweepFileChars)}\n… (truncated)`
          : file.content;
      if (used + content.length > budget && batch.length > 0) pushBatch();
      batch.push({ path: file.path, content });
      used += content.length;
    }
    pushBatch();
  }
  return {
    calls: boundHighTierDiscoveryWorkloads(calls, input.filesForLlm),
    discoveryPasses: discoveryAngles.length,
  };
}
