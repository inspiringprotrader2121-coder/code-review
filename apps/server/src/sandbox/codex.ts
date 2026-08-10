import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CodexContainerResult, CodexContainerRuntime } from '@orvex-review/review';
import {
  CODEX_CONTAINER_BINARY,
  DEFAULT_SANDBOX_RUNTIME_OPTIONS,
  type CodexSandboxRunOptions,
  type SandboxResult,
  type SandboxRunOptions,
  type SandboxRuntimeOptions,
  type SandboxSpawn,
} from './contracts.js';
import { runInSandbox, runInSandboxWithSpawnForTest } from './execution.js';
import {
  assertCodexOutputPath,
  assertPrivateAgentDirectory,
  readSandboxOutput,
  removePrivateSandboxFile,
} from './filesystem.js';
import { checkCodexSandboxRuntimeReadiness } from './readiness.js';
import { createBrokerCapabilityToken } from './broker-capability.js';

function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('container argument contains a NUL byte');
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

function codexContainerCommand(args: readonly string[], promptInContainer: string): string {
  if (args[0] !== 'exec' || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('internal Codex runner refused malformed CLI arguments');
  }
  return `exec node ${shellQuote(CODEX_CONTAINER_BINARY)} ${args.map(shellQuote).join(' ')} < ${shellQuote(promptInContainer)}`;
}

async function runCodexInSandboxInternal(
  opts: CodexSandboxRunOptions,
  run: (options: SandboxRunOptions) => Promise<SandboxResult>,
): Promise<CodexContainerResult> {
  const { workdir, output } = assertCodexOutputPath(opts.workdir, opts.lastMessageFile);
  const agentDir = assertPrivateAgentDirectory(workdir);
  const promptName = `prompt-${randomUUID()}.txt`;
  const hostPrompt = path.join(agentDir, promptName);
  const containerPrompt = `/work/.orvex-agentic/${promptName}`;
  try {
    fs.writeFileSync(hostPrompt, opts.prompt, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(output, '', { mode: 0o600, flag: 'wx' });
    const result = await run({
      workdir,
      image: opts.image,
      command: codexContainerCommand(opts.args, containerPrompt),
      timeoutMs: opts.timeoutMs,
      inactivityTimeoutMs: opts.inactivityTimeoutMs,
      readOnlyWorkdir: true,
      profile: 'agentic-codex',
      brokerToken: opts.brokerToken,
      outputFile: output,
      signal: opts.signal,
    });
    return { ...result, lastMessage: readSandboxOutput(workdir, output) };
  } finally {
    removePrivateSandboxFile(workdir, hostPrompt);
    removePrivateSandboxFile(workdir, output);
  }
}

export function runCodexInSandbox(opts: CodexSandboxRunOptions, runtime: SandboxRuntimeOptions) {
  return runCodexInSandboxInternal(opts, (sandboxOptions) => runInSandbox(sandboxOptions, runtime));
}

export function runCodexInSandboxWithSpawnForTest(
  opts: CodexSandboxRunOptions,
  spawnImpl: SandboxSpawn,
  runtime: SandboxRuntimeOptions = DEFAULT_SANDBOX_RUNTIME_OPTIONS,
) {
  return runCodexInSandboxInternal(opts, (sandboxOptions) =>
    runInSandboxWithSpawnForTest(sandboxOptions, spawnImpl, runtime),
  );
}

/** The only Codex execution path: every call repeats the readiness gate. */
export function createCodexContainerRuntime(runtime: SandboxRuntimeOptions): CodexContainerRuntime {
  return {
    async assertReady(signal?: AbortSignal): Promise<void> {
      const readiness = await checkCodexSandboxRuntimeReadiness({ runtime, signal });
      if (!readiness.ready)
        throw new Error(`internal Codex sandbox unavailable: ${readiness.reason}`);
    },
    async run(request) {
      const readiness = await checkCodexSandboxRuntimeReadiness({
        runtime,
        signal: request.signal,
      });
      if (!readiness.ready)
        throw new Error(`internal Codex sandbox unavailable: ${readiness.reason}`);
      return runCodexInSandbox(
        {
          workdir: request.workdir,
          image: readiness.image,
          args: request.args,
          prompt: request.prompt,
          lastMessageFile: request.lastMessageFile,
          timeoutMs: request.hardTimeoutMs,
          inactivityTimeoutMs: request.inactivityTimeoutMs,
          brokerToken: createBrokerCapabilityToken(request.hardTimeoutMs),
          signal: request.signal,
        },
        runtime,
      );
    },
  };
}
