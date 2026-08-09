export interface StoreRuntimeOptions {
  readonly databasePath: string;
  /** Exact worker owner id, primarily for deterministic tests. */
  readonly workerId?: string;
  /** Stable process/slot name; a boot-unique suffix is added by AppDatabase. */
  readonly workerIdBase: string;
  readonly checkoutRoot: string;
  readonly requireDurableStorage: boolean;
  readonly defaultPlan: string;
}

export const LOCAL_TEST_STORE_RUNTIME_DEFAULTS: StoreRuntimeOptions = Object.freeze({
  databasePath: ':memory:',
  workerIdBase: 'local-test',
  checkoutRoot: '/',
  requireDurableStorage: false,
  defaultPlan: 'free',
});

export function createLocalTestStoreRuntimeOptions(
  overrides: Partial<StoreRuntimeOptions> = {},
): StoreRuntimeOptions {
  return normalizeStoreRuntimeOptions({ ...LOCAL_TEST_STORE_RUNTIME_DEFAULTS, ...overrides });
}

export function normalizeStoreRuntimeOptions(options: StoreRuntimeOptions): StoreRuntimeOptions {
  const databasePath = options.databasePath.trim();
  const workerId = options.workerId?.trim();
  const workerIdBase = options.workerIdBase.trim();
  const checkoutRoot = options.checkoutRoot.trim();
  const defaultPlan = options.defaultPlan.trim();
  if (!databasePath) throw new Error('store databasePath cannot be blank');
  if (!workerId && !workerIdBase) throw new Error('store workerId or workerIdBase is required');
  if (!checkoutRoot) throw new Error('store checkoutRoot cannot be blank');
  if (!defaultPlan) throw new Error('store defaultPlan cannot be blank');
  if (typeof options.requireDurableStorage !== 'boolean') {
    throw new Error('store requireDurableStorage must be explicit');
  }
  return Object.freeze({
    databasePath,
    ...(workerId ? { workerId } : {}),
    workerIdBase,
    checkoutRoot,
    requireDurableStorage: options.requireDurableStorage,
    defaultPlan,
  });
}
