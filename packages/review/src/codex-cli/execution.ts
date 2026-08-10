import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadReviewRuntimeConfig } from '@orvex-review/config';
import { ReviewCancelledError } from '../llm-client.js';
import type { Clock, CodexContainerRuntime, ProcessSpawner } from '../providers/types.js';
import type { CodexChildListener } from './contracts.js';
import {
  buildCodexExecArgs,
  codexAnnouncedModelFallback,
  extractErrorMessage,
  extractThreadId,
  extractUsages,
  readLastMessage,
} from './protocol.js';
import {
  codexChildEnvironment,
  resolveCodexBinary,
  resolveCodexTimeouts,
  systemClock,
} from './runtime.js';

const MAX_STDOUT_CHARS = 8_000_000;
const MAX_STDERR_CHARS = 256_000;
const MAX_USAGE_TOTALS = 10_000;
const usageTotals = new Map<
  string,
  {
    input: number;
    cachedInput: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
  }
>();
const liveChildren = new Set<number>();
let childListener: CodexChildListener = {};

export function setCodexChildListener(listener: CodexChildListener): void {
  childListener = listener;
}
export function killAllCodexChildren(): number {
  let killed = 0;
  for (const pid of liveChildren) {
    try {
      process.kill(-pid, 'SIGKILL');
      killed++;
    } catch {
      /* exited */
    }
  }
  liveChildren.clear();
  return killed;
}

export type CodexExecutionOptions = {
  model: string;
  reasoningEffort?: string;
  threadId?: string;
  cwd?: string;
  home?: string;
  homeIdx?: number;
  onUsage?: (usage: {
    inputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    outputTokens: number;
    tokenSource?: 'provider' | 'estimate';
    model?: string;
    provider?: string;
    attemptId?: string;
  }) => void;
  binaryPath?: string;
  allowHostTestExecution?: boolean;
  testTimeouts?: { hardMs: number; inactivityMs: number };
  testEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  clock?: Clock;
  spawn?: ProcessSpawner;
  container?: CodexContainerRuntime;
};

export async function executeCodex(
  prompt: string,
  options: CodexExecutionOptions,
): Promise<{ text: string; threadId: string }> {
  if (options.signal?.aborted) throw new ReviewCancelledError('codex-cli review cancelled');
  if (options.container) return executeContainerCodex(prompt, options, options.container);
  if (!options.allowHostTestExecution)
    throw new Error('codex-cli requires the internal credential-isolating container runtime');
  return executeChildCodex(prompt, options);
}

async function executeContainerCodex(
  prompt: string,
  options: CodexExecutionOptions,
  runtime: CodexContainerRuntime,
): Promise<{ text: string; threadId: string }> {
  if (!options.cwd)
    throw new Error('codex-cli requires a private repository checkout for container execution');
  const checkout = path.resolve(options.cwd);
  const outputDir = path.join(checkout, '.orvex-agentic');
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(outputDir, 0o700);
  const outputName = `last-message-${randomUUID()}.txt`;
  const hostLastMessage = path.join(outputDir, outputName);
  const timeouts = options.testTimeouts ?? resolveCodexTimeouts();
  const result = await runtime.run({
    args: buildCodexExecArgs({
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      threadId: options.threadId,
      cwd: '/work',
      lastMessageFile: `/work/.orvex-agentic/${outputName}`,
      outerSandboxed: true,
    }),
    prompt,
    workdir: checkout,
    lastMessageFile: hostLastMessage,
    hardTimeoutMs: timeouts.hardMs,
    inactivityTimeoutMs: timeouts.inactivityMs,
    signal: options.signal,
  });
  if (result.cancelled || options.signal?.aborted)
    throw new ReviewCancelledError('codex-cli review cancelled');
  if (result.timedOut) {
    reportUsageFloor(options);
    if (result.inactivityTimedOut)
      throw new Error(`codex-cli produced no container output for ${timeouts.inactivityMs}ms`);
    throw new Error(`codex-cli container exceeded ${timeouts.hardMs}ms wall-clock cap`);
  }
  if (codexAnnouncedModelFallback(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`codex-cli refused model substitution; required model is ${options.model}`);
  }
  reportUsages(options, extractUsages(result.stdout));
  const text = result.lastMessage.trim();
  if (result.exitCode !== 0 || !text) {
    throw new Error(
      extractErrorMessage(result.stdout, result.stderr) ??
        `codex container exited ${result.exitCode ?? 'unknown'} with no output`,
    );
  }
  return { text, threadId: extractThreadId(result.stdout) };
}

async function executeChildCodex(
  prompt: string,
  options: CodexExecutionOptions,
): Promise<{ text: string; threadId: string }> {
  const clock = options.clock ?? systemClock;
  const spawner = options.spawn ?? { spawn };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-codex-'));
  const lastMessageFile = path.join(tempDir, 'last-message.txt');
  const args = buildCodexExecArgs({
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    threadId: options.threadId,
    cwd: options.cwd ?? tempDir,
    lastMessageFile,
  });
  return new Promise((resolve, reject) => {
    const child = spawner.spawn(options.binaryPath ?? resolveCodexBinary(), args, {
      env: options.testEnv ?? codexChildEnvironment(options.home, options.homeIdx),
      cwd: tempDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const { hardMs, inactivityMs } = options.testTimeouts ?? resolveCodexTimeouts();
    let settled = false;
    let cleaned = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let floorReported = false;
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: string, max: number) =>
      current.length >= max ? current : (current + chunk).slice(0, max);
    const killGroup = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* exited */
        }
      }
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (child.pid !== undefined) {
        liveChildren.delete(child.pid);
        try {
          childListener.onExit?.(child.pid);
        } catch (error) {
          console.warn('[codex-cli] child exit listener failed:', (error as Error).message);
        }
      }
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clock.clearTimeout(hardTimer);
      if (inactivityTimer) clock.clearTimeout(inactivityTimer);
      options.signal?.removeEventListener('abort', onAbort);
      action();
    };
    const rejectTimeout = (message: string) => {
      killGroup();
      finish(() => {
        if (!floorReported) {
          floorReported = true;
          reportUsageFloor(options);
        }
        cleanup();
        reject(new Error(message));
      });
    };
    const rejectFallback = () => {
      killGroup();
      finish(() => {
        cleanup();
        reject(
          new Error(`codex-cli refused model substitution; required model is ${options.model}`),
        );
      });
    };
    const armInactivity = () => {
      if (settled) return;
      if (inactivityTimer) clock.clearTimeout(inactivityTimer);
      inactivityTimer = clock.setTimeout(
        () => rejectTimeout(`codex-cli produced no output for ${inactivityMs}ms`),
        inactivityMs,
      );
    };
    const onAbort = () => {
      killGroup();
      finish(() => {
        cleanup();
        reject(new ReviewCancelledError('codex-cli review cancelled'));
      });
    };
    hardTimer = clock.setTimeout(
      () => rejectTimeout(`codex-cli exceeded ${hardMs}ms wall-clock cap`),
      hardMs,
    );
    armInactivity();
    if (child.pid !== undefined) {
      liveChildren.add(child.pid);
      try {
        childListener.onSpawn?.(child.pid);
      } catch (error) {
        console.warn('[codex-cli] child spawn listener failed:', (error as Error).message);
      }
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) return onAbort();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      armInactivity();
      stdout = append(stdout, chunk, MAX_STDOUT_CHARS);
      if (codexAnnouncedModelFallback(stdout)) rejectFallback();
    });
    child.stderr.on('data', (chunk) => {
      armInactivity();
      stderr = append(stderr, chunk, MAX_STDERR_CHARS);
      if (codexAnnouncedModelFallback(stderr)) rejectFallback();
    });
    child.stdin.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE')
        console.warn('[codex-cli] stdin error:', error.message);
    });
    child.stdin.end(prompt);
    child.on('error', (error) =>
      finish(() => {
        cleanup();
        reject(error);
      }),
    );
    child.on('close', (code) => {
      if (settled) return;
      try {
        const threadId = extractThreadId(stdout);
        const text = readLastMessage(lastMessageFile);
        reportUsages(options, extractUsages(stdout), threadId, tempDir);
        cleanup();
        if (!text)
          return finish(() =>
            reject(
              new Error(
                extractErrorMessage(stdout, stderr) ??
                  `codex exited ${code ?? 'unknown'} with no output`,
              ),
            ),
          );
        finish(() => resolve({ text, threadId }));
      } catch (error) {
        finish(() => {
          cleanup();
          reject(error);
        });
      }
    });
  });
}

function reportUsageFloor(options: CodexExecutionOptions): void {
  const runtime = loadReviewRuntimeConfig();
  options.onUsage?.({
    inputTokens: runtime.codexUsageFloorInput,
    cachedInputTokens: 0,
    outputTokens: runtime.codexUsageFloorOutput,
    tokenSource: 'estimate',
    model: options.model,
    provider: 'codex-cli',
  });
}

function reportUsages(
  options: CodexExecutionOptions,
  usages: readonly {
    input?: number;
    cachedInput?: number;
    cacheWrite?: number;
    output?: number;
    reasoning?: number;
  }[],
  threadId?: string,
  tempDir?: string,
): void {
  if (usages.length === 0) return reportUsageFloor(options);
  for (const usage of usages) reportUsage(options, usage, threadId, tempDir);
}

function reportUsage(
  options: CodexExecutionOptions,
  usage: {
    input?: number;
    cachedInput?: number;
    cacheWrite?: number;
    output?: number;
    reasoning?: number;
  },
  threadId?: string,
  tempDir?: string,
): void {
  if (!tempDir) {
    options.onUsage?.({
      inputTokens: usage.input ?? 0,
      cachedInputTokens: usage.cachedInput ?? 0,
      cacheWriteTokens: usage.cacheWrite ?? 0,
      outputTokens: usage.output ?? 0,
      tokenSource: 'provider',
      model: options.model,
      provider: 'codex-cli',
    });
    return;
  }
  const key = `${options.homeIdx ?? 0}:${options.threadId ?? tempDir ?? threadId ?? 'container'}:${options.model}`;
  const total = {
    input: usage.input ?? 0,
    cachedInput: usage.cachedInput ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    output: usage.output ?? 0,
    reasoning: usage.reasoning ?? 0,
  };
  const previous = usageTotals.get(key);
  const delta = { ...total };
  if (previous && total.input >= previous.input && total.output >= previous.output) {
    delta.input -= previous.input;
    delta.cachedInput =
      total.cachedInput >= previous.cachedInput
        ? total.cachedInput - previous.cachedInput
        : total.cachedInput;
    delta.cacheWrite =
      total.cacheWrite >= previous.cacheWrite
        ? total.cacheWrite - previous.cacheWrite
        : total.cacheWrite;
    delta.output -= previous.output;
    delta.reasoning =
      total.reasoning >= previous.reasoning
        ? total.reasoning - previous.reasoning
        : total.reasoning;
  }
  usageTotals.set(key, total);
  if (!options.threadId && threadId)
    usageTotals.set(`${options.homeIdx ?? 0}:${threadId}:${options.model}`, total);
  while (usageTotals.size > MAX_USAGE_TOTALS) {
    const oldest = usageTotals.keys().next().value;
    if (!oldest) break;
    usageTotals.delete(oldest);
  }
  options.onUsage?.({
    inputTokens: delta.input,
    cachedInputTokens: delta.cachedInput,
    cacheWriteTokens: delta.cacheWrite,
    outputTokens: delta.output,
    tokenSource: 'provider',
    model: options.model,
    provider: 'codex-cli',
  });
}

export function runCodexExecForTest(
  prompt: string,
  opts: {
    binaryPath: string;
    model?: string;
    reasoningEffort?: string;
    signal?: AbortSignal;
    hardMs?: number;
    inactivityMs?: number;
    env?: NodeJS.ProcessEnv;
    onUsage?: CodexExecutionOptions['onUsage'];
  },
): Promise<{ text: string; threadId: string }> {
  return executeCodex(prompt, {
    model: opts.model ?? 'gpt-5.6-luna',
    reasoningEffort: opts.reasoningEffort ?? 'max',
    signal: opts.signal,
    binaryPath: opts.binaryPath,
    allowHostTestExecution: true,
    testTimeouts: { hardMs: opts.hardMs ?? 2_000, inactivityMs: opts.inactivityMs ?? 1_000 },
    testEnv: opts.env,
    onUsage: opts.onUsage,
  });
}

export function runCodexContainerExecForTest(
  prompt: string,
  opts: {
    cwd: string;
    runtime: CodexContainerRuntime;
    model?: string;
    reasoningEffort?: string;
    hardMs?: number;
    inactivityMs?: number;
    signal?: AbortSignal;
    onUsage?: CodexExecutionOptions['onUsage'];
  },
): Promise<{ text: string; threadId: string }> {
  return executeCodex(prompt, {
    model: opts.model ?? 'gpt-5.6-luna',
    reasoningEffort: opts.reasoningEffort ?? 'max',
    cwd: opts.cwd,
    container: opts.runtime,
    signal: opts.signal,
    testTimeouts: { hardMs: opts.hardMs ?? 2_000, inactivityMs: opts.inactivityMs ?? 1_000 },
    onUsage: opts.onUsage,
  });
}
