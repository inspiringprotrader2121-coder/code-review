import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createAppDatabase } from './database.js';
import { createLocalTestStoreRuntimeOptions } from './runtime-options.js';

test('injected production durability rejects checkout-local database paths', () => {
  assert.throws(
    () =>
      createAppDatabase(
        createLocalTestStoreRuntimeOptions({
          databasePath: path.join(process.cwd(), '.data', 'production.db'),
          checkoutRoot: process.cwd(),
          requireDurableStorage: true,
          workerIdBase: 'production-worker',
        }),
      ),
    /outside the checkout/,
  );
});

test('injected default plan is used for newly created tenants', () => {
  const database = createAppDatabase(createLocalTestStoreRuntimeOptions({ defaultPlan: 'verify' }));
  try {
    const tenant = database.createTenant('injected-plan');
    assert.equal(database.getTenantPlan(tenant.id), 'verify');
  } finally {
    database.close();
  }
});

test('createAppDatabase returns independent uncached instances', () => {
  const options = createLocalTestStoreRuntimeOptions();
  const first = createAppDatabase(options);
  const second = createAppDatabase(options);
  try {
    assert.notEqual(first, second);
    first.createTenant('first-only');
    assert.equal(second.getTenantBySlug('first-only'), null);
  } finally {
    first.close();
    second.close();
  }
});

test('store production sources do not read the process environment singleton', () => {
  const forbiddenEnvironmentRead = ['process', 'env'].join('.');
  const sourceFiles = [
    new URL('./database.ts', import.meta.url),
    new URL('./runtime-options.ts', import.meta.url),
  ];
  const repositoriesDirectory = new URL('./repositories/', import.meta.url);
  for (const entry of fs.readdirSync(repositoriesDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      sourceFiles.push(new URL(entry.name, repositoriesDirectory));
    }
  }
  for (const sourceFile of sourceFiles) {
    assert.equal(
      fs.readFileSync(sourceFile, 'utf8').includes(forbiddenEnvironmentRead),
      false,
      sourceFile.pathname,
    );
  }
});
