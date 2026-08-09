import fs from 'node:fs';
import path from 'node:path';

export interface VerificationCommand {
  readonly name: string;
  readonly command: string;
}

// Package managers and dependency caches must be baked into the reviewed,
// digest-pinned runtime image. Customer lockfiles never receive network egress.
export const TOOLS_PREFIX = '/work/.orvex-tools';
const TOOLS_PATH = [
  'export HOME=/tmp/orvex-home',
  'export NPM_CONFIG_USERCONFIG=/dev/null',
  'export NPM_CONFIG_IGNORE_SCRIPTS=true',
  'export NPM_CONFIG_AUDIT=false',
  'export NPM_CONFIG_FUND=false',
  'export YARN_ENABLE_SCRIPTS=false',
  'export YARN_ENABLE_NETWORK=0',
  `export NPM_CONFIG_PREFIX=${TOOLS_PREFIX}`,
  `export PATH=${TOOLS_PREFIX}/bin:$PATH`,
].join(' && ');

export function detectPackageManager(files: ReadonlyMap<string, string>): {
  pm: string;
  installCmd: string;
} {
  // Lifecycle scripts and network access are always disabled: both would allow
  // a customer-controlled lockfile or package configuration to escape review.
  if (files.has('pnpm-lock.yaml')) {
    return {
      pm: 'pnpm',
      installCmd: `${TOOLS_PATH} && pnpm install --offline --frozen-lockfile --ignore-scripts --config.ignore-scripts=true`,
    };
  }
  if (files.has('yarn.lock')) {
    return {
      pm: 'yarn',
      installCmd: `${TOOLS_PATH} && yarn install --offline --frozen-lockfile --ignore-scripts --ignore-optional`,
    };
  }
  return {
    pm: 'npm',
    installCmd: `${TOOLS_PATH} && npm ci --offline --ignore-scripts --no-audit --no-fund`,
  };
}

export function isSafeSnapshotPath(relativePath: string): boolean {
  if (
    relativePath.length === 0 ||
    relativePath.length > 4_096 ||
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    path.posix.isAbsolute(relativePath)
  )
    return false;
  const normalized = path.posix.normalize(relativePath);
  return (
    normalized === relativePath &&
    normalized !== '.' &&
    !normalized.startsWith('../') &&
    !normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

/** Materialize only a validated flat snapshot into a new 0700 checkout. */
export function materializeSnapshot(
  workdir: string,
  snapshot: ReadonlyMap<string, string>,
  maxSnapshotFiles: number,
): void {
  if (snapshot.size > maxSnapshotFiles) {
    throw new Error(`snapshot exceeds ${maxSnapshotFiles} file safety limit`);
  }
  for (const [relativePath] of snapshot) {
    if (!isSafeSnapshotPath(relativePath)) {
      throw new Error(`snapshot contains an unsafe path: ${JSON.stringify(relativePath)}`);
    }
  }
  for (const [relativePath, content] of snapshot) {
    const destination = path.join(workdir, ...relativePath.split('/'));
    if (!destination.startsWith(`${workdir}${path.sep}`)) {
      throw new Error(
        `snapshot path escaped the sandbox checkout: ${JSON.stringify(relativePath)}`,
      );
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, content, { mode: 0o600, flag: 'wx' });
  }
}

/** Verification steps declared by the reviewed project. */
export function detectSteps(pkgJson: string, pm: string): VerificationCommand[] {
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(pkgJson).scripts ?? {}) as Record<string, string>;
  } catch {
    return [];
  }
  const prefix = pm === 'npm' ? '' : `${TOOLS_PATH} && `;
  const run = (script: string) => `${prefix}${pm} run ${script}`;
  const steps: VerificationCommand[] = [];
  if (scripts.typecheck) steps.push({ name: 'typecheck', command: run('typecheck') });
  else if (scripts.build) steps.push({ name: 'build', command: run('build') });
  if (scripts.test) steps.push({ name: 'test', command: run('test') });
  return steps;
}

export function isOfflineCacheMiss(output: string): boolean {
  return /(?:ENOTCACHED|ERR_PNPM_NO_OFFLINE_TARBALL|ERR_PNPM_META_FETCH_FAIL|Can't make a request in offline mode|not found in cache|is not in the cache)/i.test(
    output,
  );
}
