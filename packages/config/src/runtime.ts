/**
 * The only production boundary that reads process.env. Callers receive a fresh,
 * immutable snapshot so a request cannot observe a half-mutated environment.
 * Tests may pass their own ProcessEnv to any loader instead.
 */
export function currentEnvironment(): Readonly<NodeJS.ProcessEnv> {
  return Object.freeze({ ...process.env });
}
