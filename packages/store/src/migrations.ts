export {
  STORE_MIGRATIONS,
  canonicalExecutableArtifact,
  checksumExecutableMigrationArtifact,
  checksumMigrationArtifact,
  defineExecutableMigration,
  validateMigrationLedger,
  type ExecutableMigrationArtifact,
  type MigrationLedgerRow,
  type StoreMigrationMetadata,
} from './migrations/artifacts.js';
export { runStoreMigrations } from './migrations/ledger.js';
export { BASELINE_SCHEMA_V2 } from './migrations/baseline.js';
export { repairLegacyAttemptLineageReferences } from './migrations/compatibility.js';
export {
  STORE_MIGRATION_STEPS,
  findMigrationStep,
  type ExecutableMigrationStep,
} from './migrations/steps.js';
