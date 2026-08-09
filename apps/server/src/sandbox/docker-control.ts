import { spawn } from 'node:child_process';
import {
  MAX_CAPTURE_BYTES,
  SANDBOX_DOCKER_COMMAND_TIMEOUT_MS,
  type SandboxDockerCommandResult,
  type SandboxSpawn,
} from './contracts.js';

export function runBoundedDockerCommandWithSpawn(
  args: readonly string[],
  spawnImpl: SandboxSpawn,
): Promise<SandboxDockerCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<SandboxSpawn> | undefined;
    let stdout = '';
    let stderr = '';
    const finish = (result: SandboxDockerCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* control command is unavailable */
      }
      finish({ exitCode: null, stdout, stderr, timedOut: true });
    }, SANDBOX_DOCKER_COMMAND_TIMEOUT_MS);
    try {
      child = spawnImpl('docker', [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString('utf8')).slice(0, MAX_CAPTURE_BYTES);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(0, MAX_CAPTURE_BYTES);
      });
      child.once('error', (err) =>
        finish({
          exitCode: null,
          stdout,
          stderr: `${stderr}\n${err.message}`.trim(),
          timedOut: false,
        }),
      );
      child.once('close', (exitCode) => finish({ exitCode, stdout, stderr, timedOut: false }));
    } catch (err) {
      finish({
        exitCode: null,
        stdout,
        stderr: err instanceof Error ? err.message : 'failed to launch docker',
        timedOut: false,
      });
    }
  });
}

export function runBoundedDockerCommand(
  args: readonly string[],
): Promise<SandboxDockerCommandResult> {
  return runBoundedDockerCommandWithSpawn(args, spawn);
}

export function waitForDockerCommand(spawnImpl: SandboxSpawn, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    let command: ReturnType<SandboxSpawn> | undefined;
    const timer = setTimeout(() => {
      try {
        command?.kill('SIGKILL');
      } catch {
        /* bounded cleanup attempt failed */
      }
      finish();
    }, 10_000);
    try {
      command = spawnImpl('docker', args, { stdio: 'ignore' });
      command.once('error', finish);
      command.once('close', finish);
    } catch {
      finish();
    }
  });
}
