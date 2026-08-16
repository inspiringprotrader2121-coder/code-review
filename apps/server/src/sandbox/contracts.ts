import type { CodexContainerRuntime } from '@orvex-review/review';

export interface SandboxRunOptions {
  workdir: string;
  image: string;
  command: string;
  timeoutMs?: number;
  memory?: string;
  cpus?: string;
  readOnlyWorkdir?: boolean;
  signal?: AbortSignal;
  inactivityTimeoutMs?: number;
  profile?: 'runtime-verify' | 'agentic-codex';
  /** Short-lived per-container broker capability; never the upstream API key. */
  brokerToken?: string;
  /** Pre-created, validated host file exposed as the sole writable Codex output. */
  outputFile?: string;
  /** Private input delivered over the container's attached stdin, never argv. */
  stdin?: string;
}

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  inactivityTimedOut?: boolean;
  durationMs: number;
  cancelled?: boolean;
}

export type SandboxRuntimeReadiness =
  | { ready: true; image: string }
  | { ready: false; reason: string };

export interface SandboxRuntimeOptions {
  readonly codeExecutionEnabled: boolean;
  readonly codexContainerEnabled: boolean;
  readonly image?: string;
  readonly codexEgressBrokerImage?: string;
  readonly dockerHost?: string;
  readonly dockerContext?: string;
  readonly maxConcurrentSandboxes: number;
  readonly slotWaitMs: number;
  /** Private service-owned directory for host-wide sandbox slot leases. */
  readonly slotDirectory?: string;
  /** A slot without a live owner may be reclaimed after this bounded grace period. */
  readonly slotStaleMs: number;
  readonly workdirMaxBytes: number;
}

export const DEFAULT_SANDBOX_RUNTIME_OPTIONS: SandboxRuntimeOptions = Object.freeze({
  codeExecutionEnabled: false,
  codexContainerEnabled: false,
  image: undefined,
  codexEgressBrokerImage: undefined,
  dockerHost: undefined,
  dockerContext: undefined,
  maxConcurrentSandboxes: 8,
  slotWaitMs: 600_000,
  slotDirectory: undefined,
  slotStaleMs: 600_000,
  workdirMaxBytes: 1024 * 1024 * 1024,
});

export interface SandboxRuntimeReadinessOptions {
  runtime?: SandboxRuntimeOptions;
  enabled?: boolean;
  image?: string;
  inspectImage?: (image: string, signal?: AbortSignal) => Promise<boolean>;
  inspectRootlessRuntime?: (signal?: AbortSignal) => Promise<boolean>;
  dockerHost?: string;
  inspectDockerSocket?: (socketPath: string) => Promise<boolean>;
  dockerContext?: string;
  signal?: AbortSignal;
}

export interface CodexSandboxRunOptions {
  workdir: string;
  image: string;
  args: readonly string[];
  prompt: string;
  lastMessageFile: string;
  timeoutMs: number;
  inactivityTimeoutMs: number;
  brokerToken?: string;
  signal?: AbortSignal;
}

export interface CodexSandboxRuntimeReadinessOptions extends SandboxRuntimeReadinessOptions {
  inspectCodexBinary?: (image: string, signal?: AbortSignal) => Promise<boolean>;
  inspectEgressBoundary?: (
    network: string,
    brokerName: string,
    brokerImage: string,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  brokerImage?: string;
  inspectBrokerSigningKey?: (file: string) => Promise<boolean>;
}

export interface SandboxStartupPreparation {
  enabled: boolean;
  removedContainers: number;
  image?: string;
}

export interface SandboxDockerCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type SandboxDockerCommandRunner = (
  args: readonly string[],
) => Promise<SandboxDockerCommandResult>;

export interface SandboxStartupPreparationOptions {
  runtime?: SandboxRuntimeOptions;
  enabled?: boolean;
  runDockerCommand?: SandboxDockerCommandRunner;
  checkReadiness?: () => Promise<SandboxRuntimeReadiness>;
  isProcessAlive?: (pid: number) => boolean;
}

export type SandboxSpawn = typeof import('node:child_process').spawn;
export type SandboxCodexRuntime = CodexContainerRuntime;

export const MAX_CAPTURE_BYTES = 64_000;
export const SANDBOX_READINESS_TIMEOUT_MS = 10_000;
export const SANDBOX_DOCKER_COMMAND_TIMEOUT_MS = 10_000;
export const CONTAINER_CLEANUP_TIMEOUT_MS = 10_000;
export const CONTAINER_CLEANUP_RETRY_MS = 50;
/** Host-wide sandbox slot ceiling. Must stay >= production ORVEX_MAX_SANDBOXES. */
export const MAX_HOST_SANDBOX_SLOTS = 10_000;
export const ORVEX_MANAGED_LABEL = 'orvex.managed=true';
export const ORVEX_RUNTIME_LABEL = 'orvex.runtime-verify=true';
export const ORVEX_CODEX_LABEL = 'orvex.agentic-codex=true';
export const ORVEX_OWNER_PID_LABEL = 'orvex.owner-pid';
export const ORVEX_OWNER_TOKEN_LABEL = 'orvex.owner-token';
export const ORVEX_WORKDIR_PREFIX = 'orvex-rverify-';
export const MAX_SANDBOX_COMMAND_BYTES = 32_000;
export const MAX_SANDBOX_OUTPUT_FILE_BYTES = 512 * 1024 * 1024;
export const WORKDIR_QUOTA_POLL_MS = 500;
export const CODEX_EGRESS_NETWORK = 'orvex-agentic-internal';
export const CODEX_EGRESS_BROKER = 'orvex-openai-egress';
export const CODEX_EGRESS_BASE_URL = `http://${CODEX_EGRESS_BROKER}:8080/v1`;
export const CODEX_CONTAINER_BINARY = '/opt/orvex/node_modules/@openai/codex/bin/codex.js';
export const CODEX_CONTAINER_HOME = '/codex-home';
export const DEFAULT_WORKDIR_MAX_BYTES = 1024 * 1024 * 1024;
