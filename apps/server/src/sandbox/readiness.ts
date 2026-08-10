import { spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  CODEX_CONTAINER_BINARY,
  CODEX_EGRESS_BROKER,
  CODEX_EGRESS_NETWORK,
  DEFAULT_SANDBOX_RUNTIME_OPTIONS,
  MAX_CAPTURE_BYTES,
  SANDBOX_READINESS_TIMEOUT_MS,
  type CodexSandboxRuntimeReadinessOptions,
  type SandboxRuntimeReadiness,
  type SandboxRuntimeReadinessOptions,
  type SandboxSpawn,
} from './contracts.js';
import { runBoundedDockerCommand } from './docker-control.js';
import { isDigestPinnedSandboxImage } from './policy.js';
import { brokerSigningKeyPath } from './broker-capability.js';

function inspectSandboxImageWithSpawn(
  image: string,
  signal: AbortSignal | undefined,
  spawnImpl: SandboxSpawn,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<SandboxSpawn> | undefined;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(ready);
    };
    const onAbort = () => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* no child to kill */
      }
      finish(false);
    };
    const timer = setTimeout(onAbort, SANDBOX_READINESS_TIMEOUT_MS);
    try {
      child = spawnImpl('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
        stdio: 'ignore',
      });
      child.once('error', () => finish(false));
      child.once('close', (code) => finish(code === 0));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    } catch {
      finish(false);
    }
  });
}

function inspectRootlessRuntimeWithSpawn(
  signal: AbortSignal | undefined,
  spawnImpl: SandboxSpawn,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<SandboxSpawn> | undefined;
    let stdout = '';
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(ready);
    };
    const onAbort = () => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* no child to kill */
      }
      finish(false);
    };
    const timer = setTimeout(onAbort, SANDBOX_READINESS_TIMEOUT_MS);
    try {
      child = spawnImpl(
        'docker',
        ['info', '--format', '{{range .SecurityOptions}}{{println .}}{{end}}'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString('utf8')).slice(0, MAX_CAPTURE_BYTES);
      });
      child.once('error', () => finish(false));
      child.once('close', (code) =>
        finish(
          code === 0 && stdout.split(/\r?\n/).some((line) => /(?:^|=)rootless$/.test(line.trim())),
        ),
      );
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    } catch {
      finish(false);
    }
  });
}

function inspectRootlessDockerSocket(socketPath: string): Promise<boolean> {
  return Promise.resolve().then(() => {
    try {
      const socket = fs.lstatSync(socketPath);
      const uid = process.getuid?.();
      return (
        uid !== undefined && socket.isSocket() && socket.uid === uid && (socket.mode & 0o007) === 0
      );
    } catch {
      return false;
    }
  });
}

export async function checkSandboxRuntimeReadiness(
  opts: SandboxRuntimeReadinessOptions = {},
): Promise<SandboxRuntimeReadiness> {
  const runtime = opts.runtime ?? DEFAULT_SANDBOX_RUNTIME_OPTIONS;
  const enabled = opts.enabled ?? runtime.codeExecutionEnabled;
  if (!enabled) return { ready: false, reason: 'code execution is disabled' };
  if (opts.signal?.aborted) return { ready: false, reason: 'runtime verification cancelled' };
  const uid = process.getuid?.();
  if (uid === undefined)
    return { ready: false, reason: 'rootless Docker requires a POSIX service-account uid' };
  const expectedDockerHost = `unix:///run/user/${uid}/docker.sock`;
  if (opts.dockerContext ?? runtime.dockerContext) {
    return {
      ready: false,
      reason: 'DOCKER_CONTEXT must be unset so Docker cannot select a non-local daemon',
    };
  }
  if ((opts.dockerHost ?? runtime.dockerHost) !== expectedDockerHost) {
    return {
      ready: false,
      reason: `DOCKER_HOST must select the service account rootless socket ${expectedDockerHost}`,
    };
  }
  const image = opts.image ?? runtime.image;
  if (!isDigestPinnedSandboxImage(image)) {
    return {
      ready: false,
      reason:
        'ORVEX_SANDBOX_IMAGE must be a registry digest or immutable local image ID (sha256:<64-hex>)',
    };
  }
  if (
    !(await (opts.inspectDockerSocket ?? inspectRootlessDockerSocket)(
      `/run/user/${uid}/docker.sock`,
    ))
  ) {
    return {
      ready: false,
      reason: 'rootless Docker socket is not a private local service-account socket',
    };
  }
  const inspectRootlessRuntime =
    opts.inspectRootlessRuntime ?? ((signal) => inspectRootlessRuntimeWithSpawn(signal, spawn));
  if (!(await inspectRootlessRuntime(opts.signal)))
    return { ready: false, reason: 'selected Docker daemon does not report rootless mode' };
  const inspectImage =
    opts.inspectImage ??
    ((candidate, signal) => inspectSandboxImageWithSpawn(candidate, signal, spawn));
  const available = await inspectImage(image, opts.signal);
  if (opts.signal?.aborted) return { ready: false, reason: 'runtime verification cancelled' };
  return available
    ? { ready: true, image }
    : { ready: false, reason: 'internal sandbox runtime or configured image is unavailable' };
}

async function inspectCodexEgressBoundary(
  network: string,
  brokerName: string,
  brokerImage: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  const networkResult = await runBoundedDockerCommand([
    'network',
    'inspect',
    '--format',
    '{{.Internal}} {{range .Containers}}{{.Name}} {{end}}',
    network,
  ]);
  if (networkResult.exitCode !== 0 || networkResult.timedOut) return false;
  const networkParts = networkResult.stdout.trim().split(/\s+/);
  if (networkParts[0] !== 'true' || !networkParts.slice(1).includes(brokerName)) return false;
  const brokerResult = await runBoundedDockerCommand([
    'inspect',
    '--format',
    '{{.Config.Image}} {{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}',
    brokerName,
  ]);
  if (brokerResult.exitCode !== 0 || brokerResult.timedOut) return false;
  const brokerParts = brokerResult.stdout.trim().split(/\s+/);
  return brokerParts[0] === brokerImage && brokerParts.slice(1).includes(network);
}

async function inspectCodexBinary(image: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  const result = await runBoundedDockerCommand([
    'run',
    '--rm',
    '--pull',
    'never',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--entrypoint',
    '/usr/bin/test',
    image,
    '-r',
    CODEX_CONTAINER_BINARY,
  ]);
  return result.exitCode === 0 && !result.timedOut && !signal?.aborted;
}

function inspectBrokerSigningKey(file: string): Promise<boolean> {
  return Promise.resolve().then(() => {
    try {
      const stat = fs.lstatSync(file);
      const uid = process.getuid?.();
      return Boolean(
        uid !== undefined &&
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.uid === uid &&
          (stat.mode & 0o077) === 0 &&
          stat.size >= 32 &&
          stat.size <= 1_024,
      );
    } catch {
      return false;
    }
  });
}

export async function checkCodexSandboxRuntimeReadiness(
  opts: CodexSandboxRuntimeReadinessOptions = {},
): Promise<SandboxRuntimeReadiness> {
  const configured = opts.runtime ?? DEFAULT_SANDBOX_RUNTIME_OPTIONS;
  if (!(opts.enabled ?? configured.codexContainerEnabled)) {
    return { ready: false, reason: 'credential-isolated Codex container runtime is disabled' };
  }
  const runtime = await checkSandboxRuntimeReadiness({ ...opts, enabled: true });
  if (!runtime.ready) return runtime;
  const inspectBinary = opts.inspectCodexBinary ?? inspectCodexBinary;
  if (!(await inspectBinary(runtime.image, opts.signal))) {
    return {
      ready: false,
      reason: 'internal Codex sandbox image is missing the pinned Codex CLI binary',
    };
  }
  const brokerImage = opts.brokerImage ?? configured.codexEgressBrokerImage;
  if (!isDigestPinnedSandboxImage(brokerImage)) {
    return {
      ready: false,
      reason:
        'ORVEX_CODEX_EGRESS_BROKER_IMAGE must pin the internal OpenAI egress broker by digest',
    };
  }
  const signingKey = brokerSigningKeyPath();
  if (!(await (opts.inspectBrokerSigningKey ?? inspectBrokerSigningKey)(signingKey))) {
    return {
      ready: false,
      reason: 'internal Codex broker capability signing key is unavailable or not private',
    };
  }
  const inspect = opts.inspectEgressBoundary ?? inspectCodexEgressBoundary;
  if (!(await inspect(CODEX_EGRESS_NETWORK, CODEX_EGRESS_BROKER, brokerImage, opts.signal))) {
    return {
      ready: false,
      reason:
        'internal Codex egress broker is not a pinned container on the required internal-only network',
    };
  }
  return runtime;
}
