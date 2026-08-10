import {
  CODEX_EGRESS_BASE_URL,
  CODEX_EGRESS_NETWORK,
  CODEX_CONTAINER_HOME,
  DEFAULT_SANDBOX_RUNTIME_OPTIONS,
  MAX_SANDBOX_COMMAND_BYTES,
  MAX_SANDBOX_OUTPUT_FILE_BYTES,
  ORVEX_CODEX_LABEL,
  ORVEX_MANAGED_LABEL,
  ORVEX_OWNER_PID_LABEL,
  ORVEX_OWNER_TOKEN_LABEL,
  ORVEX_RUNTIME_LABEL,
  type SandboxRunOptions,
  type SandboxRuntimeOptions,
} from './contracts.js';
import fs from 'node:fs';
import { assertCodexOutputPath, assertSafeSandboxWorkdir, workdirMaxBytes } from './filesystem.js';
import { isBrokerCapabilityToken } from './broker-capability.js';

export function isDigestPinnedSandboxImage(image: string | undefined): image is string {
  return Boolean(
    image && (/^[^@\s]+@sha256:[a-f0-9]{64}$/i.test(image) || /^sha256:[a-f0-9]{64}$/i.test(image)),
  );
}

function sandboxFileSizeLimitBlocks(workdirBytes: number): number {
  return Math.max(
    1,
    Math.min(Math.floor(workdirBytes / 512), Math.floor(MAX_SANDBOX_OUTPUT_FILE_BYTES / 512)),
  );
}

function assertSafeSandboxRunOptions(
  opts: SandboxRunOptions,
  runtime: SandboxRuntimeOptions,
): { workdir: string; diskBytes: number } {
  if (!isDigestPinnedSandboxImage(opts.image))
    throw new Error('sandbox image must be digest-pinned');
  if (
    typeof opts.command !== 'string' ||
    opts.command.length === 0 ||
    opts.command.length > MAX_SANDBOX_COMMAND_BYTES ||
    opts.command.includes('\0')
  ) {
    throw new Error('sandbox command is empty, malformed, or exceeds the safety limit');
  }
  return { workdir: assertSafeSandboxWorkdir(opts.workdir), diskBytes: workdirMaxBytes(runtime) };
}

export function buildSandboxDockerArgs(
  opts: SandboxRunOptions,
  name: string,
  runtime: SandboxRuntimeOptions = DEFAULT_SANDBOX_RUNTIME_OPTIONS,
  ownerToken = 'unleased-test-owner',
): string[] {
  const { workdir, diskBytes } = assertSafeSandboxRunOptions(opts, runtime);
  const agenticCodex = opts.profile === 'agentic-codex';
  if (opts.stdin !== undefined && !agenticCodex) {
    throw new Error('sandbox stdin is restricted to agentic Codex');
  }
  if (agenticCodex && !isBrokerCapabilityToken(opts.brokerToken)) {
    throw new Error('agentic Codex sandbox requires a valid per-container broker capability');
  }
  if (agenticCodex && (typeof opts.stdin !== 'string' || opts.stdin.length === 0)) {
    throw new Error('agentic Codex sandbox requires a private stdin prompt');
  }
  const workdirReadOnly = agenticCodex || opts.readOnlyWorkdir;
  const mount = `type=bind,src=${workdir},dst=/work,bind-propagation=rprivate${workdirReadOnly ? ',readonly' : ''}`;
  let outputMount: string | undefined;
  if (agenticCodex) {
    if (!opts.outputFile) throw new Error('agentic Codex sandbox requires a dedicated output file');
    const { output } = assertCodexOutputPath(workdir, opts.outputFile);
    const stat = fs.lstatSync(output);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error('agentic Codex output must be a private regular file');
    }
    outputMount = `type=bind,src=${output},dst=${opts.outputFile.replace(workdir, '/work')},bind-propagation=rprivate`;
  } else if (opts.outputFile) {
    throw new Error('dedicated output mounts are restricted to agentic Codex');
  }
  const args = [
    'run',
    '--rm',
    '--pull',
    'never',
    '--name',
    name,
    '--label',
    ORVEX_MANAGED_LABEL,
    '--label',
    ORVEX_RUNTIME_LABEL,
    '--label',
    `${ORVEX_OWNER_PID_LABEL}=${process.pid}`,
    '--label',
    `${ORVEX_OWNER_TOKEN_LABEL}=${ownerToken}`,
    '--network',
    agenticCodex ? CODEX_EGRESS_NETWORK : 'none',
    '--ipc',
    'none',
    '--init',
    '--memory',
    opts.memory ?? '1g',
    '--memory-swap',
    opts.memory ?? '1g',
    '--cpus',
    opts.cpus ?? '0.75',
    '--pids-limit',
    '256',
    '--ulimit',
    'nofile=256:256',
    '--ulimit',
    'nproc=256:256',
    '--ulimit',
    'core=0:0',
    '--ulimit',
    `fsize=${sandboxFileSizeLimitBlocks(diskBytes)}:${sandboxFileSizeLimitBlocks(diskBytes)}`,
    '--read-only',
    '--tmpfs',
    '/tmp:size=256m,noexec,nosuid,nodev',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '-u',
    '0:0',
    '--mount',
    mount,
    '-w',
    '/work',
  ];
  if (agenticCodex) {
    args.push(
      '--interactive',
      '--tmpfs',
      `${CODEX_CONTAINER_HOME}:size=16m,noexec,nosuid,nodev,mode=0700`,
      '--label',
      ORVEX_CODEX_LABEL,
      '--env',
      `OPENAI_BASE_URL=${CODEX_EGRESS_BASE_URL}`,
      '--env',
      `OPENAI_API_KEY=${opts.brokerToken}`,
      '--env',
      `CODEX_HOME=${CODEX_CONTAINER_HOME}`,
      '--env',
      'NO_PROXY=*',
    );
    args.push('--mount', outputMount!);
  }
  args.push(opts.image, 'sh', '-c', opts.command);
  return args;
}
