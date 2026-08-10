import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SANDBOX_RUNTIME_OPTIONS,
  DEFAULT_WORKDIR_MAX_BYTES,
  MAX_CAPTURE_BYTES,
  ORVEX_WORKDIR_PREFIX,
  type SandboxRuntimeOptions,
} from './contracts.js';

export { DEFAULT_WORKDIR_MAX_BYTES };

export function workdirMaxBytes(
  runtime: SandboxRuntimeOptions = DEFAULT_SANDBOX_RUNTIME_OPTIONS,
): number {
  return runtime.workdirMaxBytes;
}

export function assertSafeSandboxWorkdir(workdir: string): string {
  if (!path.isAbsolute(workdir)) throw new Error('sandbox workdir must be an absolute path');
  const pattern = new RegExp(`^${ORVEX_WORKDIR_PREFIX}[A-Za-z0-9_-]+$`);
  if (!pattern.test(path.basename(workdir))) {
    throw new Error('sandbox workdir is not an Orvex runtime verification checkout');
  }
  const root = fs.realpathSync(os.tmpdir());
  const rootStats = fs.statSync(root);
  if (
    !rootStats.isDirectory() ||
    ((rootStats.mode & 0o022) !== 0 && (rootStats.mode & 0o1000) === 0)
  ) {
    throw new Error('sandbox temporary root is not a safe service-owned or sticky directory');
  }
  const entry = fs.lstatSync(workdir);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('sandbox workdir must be a real directory, not a symlink');
  }
  if ((entry.mode & 0o077) !== 0) {
    throw new Error('sandbox workdir must not be group- or world-accessible');
  }
  const canonical = fs.realpathSync(workdir);
  const relative = path.relative(root, canonical);
  if (
    relative === '' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    path.dirname(relative) !== '.' ||
    !pattern.test(relative)
  ) {
    throw new Error('sandbox workdir escapes the approved runtime checkout directory');
  }
  return canonical;
}

export function measureWorkdirBytes(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(full);
        else if (entry.isFile()) total += fs.statSync(full).size;
      } catch {
        /* A concurrent cleanup or permission change cannot inflate quota. */
      }
    }
  }
  return total;
}

export function assertWorkdirWithinQuota(workdir: string, maxBytes = workdirMaxBytes()): number {
  const used = measureWorkdirBytes(workdir);
  if (used > maxBytes) {
    throw new Error(`sandbox workdir exceeds ${maxBytes}-byte disk quota (used ${used} bytes)`);
  }
  return used;
}

export function assertCodexOutputPath(
  workdir: string,
  lastMessageFile: string,
): { workdir: string; output: string } {
  const safeWorkdir = assertSafeSandboxWorkdir(workdir);
  const relative = path.relative(path.resolve(workdir), path.resolve(lastMessageFile));
  if (!/^\.orvex-agentic[\\/]last-message-[a-f0-9-]+\.txt$/.test(relative)) {
    throw new Error('Codex output path must be a generated file inside the private checkout');
  }
  return { workdir: safeWorkdir, output: path.join(safeWorkdir, relative) };
}

export function assertPrivateAgentDirectory(workdir: string): string {
  const safeWorkdir = assertSafeSandboxWorkdir(workdir);
  const agentDir = path.join(safeWorkdir, '.orvex-agentic');
  try {
    const entry = fs.lstatSync(agentDir);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Codex private directory must be a real directory');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    fs.mkdirSync(agentDir, { mode: 0o700 });
  }
  fs.chmodSync(agentDir, 0o700);
  if (fs.realpathSync(agentDir) !== agentDir) {
    throw new Error('Codex private directory escapes the sandbox checkout');
  }
  return agentDir;
}

function hasSafePrivateParent(workdir: string, file: string): boolean {
  try {
    const safeWorkdir = assertSafeSandboxWorkdir(workdir);
    const expectedParent = path.join(safeWorkdir, '.orvex-agentic');
    if (path.dirname(file) !== expectedParent) return false;
    const parent = fs.lstatSync(expectedParent);
    return (
      parent.isDirectory() &&
      !parent.isSymbolicLink() &&
      fs.realpathSync(expectedParent) === expectedParent
    );
  } catch {
    return false;
  }
}

export function readSandboxOutput(workdir: string, file: string): string {
  try {
    if (!hasSafePrivateParent(workdir, file)) return '';
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CAPTURE_BYTES) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function removePrivateSandboxFile(workdir: string, file: string): void {
  if (!hasSafePrivateParent(workdir, file)) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* The outer checkout cleanup remains authoritative. */
  }
}
