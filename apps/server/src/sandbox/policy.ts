import {
  CODEX_EGRESS_BASE_URL,
  CODEX_EGRESS_NETWORK,
  DEFAULT_SANDBOX_RUNTIME_OPTIONS,
  MAX_SANDBOX_COMMAND_BYTES,
  MAX_SANDBOX_OUTPUT_FILE_BYTES,
  ORVEX_CODEX_LABEL,
  ORVEX_MANAGED_LABEL,
  ORVEX_RUNTIME_LABEL,
  type SandboxRunOptions,
  type SandboxRuntimeOptions,
} from './contracts.js';
import { assertSafeSandboxWorkdir, workdirMaxBytes } from './filesystem.js';
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
): string[] {
  const { workdir, diskBytes } = assertSafeSandboxRunOptions(opts, runtime);
  const mount = `type=bind,src=${workdir},dst=/work,bind-propagation=rprivate${opts.readOnlyWorkdir ? ',readonly' : ''}`;
  const agenticCodex = opts.profile === 'agentic-codex';
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
    '--network',
    agenticCodex ? CODEX_EGRESS_NETWORK : 'none',
    '--ipc',
    'none',
    '--init',
    '--memory',
    opts.memory ?? '2g',
    '--memory-swap',
    opts.memory ?? '2g',
    '--cpus',
    opts.cpus ?? '2',
    '--pids-limit',
    '512',
    '--ulimit',
    'nofile=256:256',
    '--ulimit',
    'nproc=512:512',
    '--ulimit',
    'core=0:0',
    '--ulimit',
    `fsize=${sandboxFileSizeLimitBlocks(diskBytes)}:${sandboxFileSizeLimitBlocks(diskBytes)}`,
    '--read-only',
    '--tmpfs',
    '/tmp:size=512m,noexec,nosuid,nodev',
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
    if (!isBrokerCapabilityToken(opts.brokerToken)) {
      throw new Error('agentic Codex sandbox requires a valid per-container broker capability');
    }
    args.push(
      '--label',
      ORVEX_CODEX_LABEL,
      '--env',
      `OPENAI_BASE_URL=${CODEX_EGRESS_BASE_URL}`,
      '--env',
      `OPENAI_API_KEY=${opts.brokerToken}`,
      '--env',
      'CODEX_HOME=/work/.orvex-agentic/codex-home',
      '--env',
      'NO_PROXY=*',
    );
  }
  args.push(opts.image, 'sh', '-c', opts.command);
  return args;
}
