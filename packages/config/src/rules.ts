import { currentEnvironment } from './runtime.js';

export interface RulesRuntimeConfig {
  readonly semgrepDisabled: boolean;
}

export function loadRulesRuntimeConfig(
  env: NodeJS.ProcessEnv = currentEnvironment(),
): RulesRuntimeConfig {
  return Object.freeze({ semgrepDisabled: env.SEMGREP_DISABLED === '1' });
}
