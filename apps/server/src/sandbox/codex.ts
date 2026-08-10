import fs from 'node:fs';
import type { CodexContainerResult, CodexContainerRuntime } from '@orvex-review/review';
import {
  CODEX_CONTAINER_BINARY,
  CODEX_CONTAINER_HOME,
  CODEX_EGRESS_BASE_URL,
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

function codexContainerCommand(args: readonly string[]): string {
  if (args[0] !== 'exec' || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('internal Codex runner refused malformed CLI arguments');
  }
  const brokerProviderArgs = [
    '-c',
    'model_provider="orvex_broker"',
    '-c',
    'model_providers.orvex_broker.name="Orvex broker"',
    '-c',
    `model_providers.orvex_broker.base_url="${CODEX_EGRESS_BASE_URL}"`,
    '-c',
    'model_providers.orvex_broker.env_key="OPENAI_API_KEY"',
    '-c',
    'model_providers.orvex_broker.wire_api="responses"',
    '-c',
    'model_providers.orvex_broker.supports_websockets=false',
    '-c',
    'model_providers.orvex_broker.request_max_retries=1',
    '-c',
    'model_providers.orvex_broker.stream_max_retries=1',
  ];
  const configResetIndex = args.indexOf('--ignore-user-config');
  if (configResetIndex < 0) throw new Error('internal Codex runner requires config isolation');
  const insertAt = configResetIndex + 1;
  const commandArgs = [...args.slice(0, insertAt), ...brokerProviderArgs, ...args.slice(insertAt)];
  return `mkdir -p ${shellQuote(CODEX_CONTAINER_HOME)} && chmod 700 ${shellQuote(CODEX_CONTAINER_HOME)} && exec node ${shellQuote(CODEX_CONTAINER_BINARY)} ${commandArgs.map(shellQuote).join(' ')}`;
}

async function runCodexInSandboxInternal(
  opts: CodexSandboxRunOptions,
  run: (options: SandboxRunOptions) => Promise<SandboxResult>,
): Promise<CodexContainerResult> {
  const { workdir, output } = assertCodexOutputPath(opts.workdir, opts.lastMessageFile);
  assertPrivateAgentDirectory(workdir);
  try {
    fs.writeFileSync(output, '', { mode: 0o600, flag: 'wx' });
    const result = await run({
      workdir,
      image: opts.image,
      command: codexContainerCommand(opts.args),
      timeoutMs: opts.timeoutMs,
      inactivityTimeoutMs: opts.inactivityTimeoutMs,
      readOnlyWorkdir: true,
      profile: 'agentic-codex',
      brokerToken: opts.brokerToken,
      outputFile: output,
      stdin: opts.prompt,
      signal: opts.signal,
    });
    return { ...result, lastMessage: readSandboxOutput(workdir, output) };
  } finally {
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
