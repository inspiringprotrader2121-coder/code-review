import { createAppDatabase, type AppDatabase } from '@orvex-review/store';
import type { GitHubAppConfig } from '@orvex-review/github';
import { githubAppConfig, loadServerConfig, type ServerConfig } from './config.js';

/** Explicit test-only bootstrap. Production code must receive ServerConfig from index.ts. */
export function testServerConfig(overrides: NodeJS.ProcessEnv = {}): ServerConfig {
  return loadServerConfig({
    ...process.env,
    NODE_ENV: 'test',
    ORVEX_ENV: 'test',
    PLATFORM_SECRET: 'test-platform-secret-that-is-never-used-in-production',
    ...overrides,
  });
}

export function testRouteDependencies(overrides: NodeJS.ProcessEnv = {}): {
  db: AppDatabase;
  config: ServerConfig;
  githubConfig: GitHubAppConfig | undefined;
} {
  const config = testServerConfig(overrides);
  return {
    db: createAppDatabase(config.store),
    config,
    githubConfig: githubAppConfig(config),
  };
}

export function testAppDatabase(overrides: NodeJS.ProcessEnv = {}): AppDatabase {
  return createAppDatabase(testServerConfig(overrides).store);
}
