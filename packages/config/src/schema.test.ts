import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configurationSchema,
  configurationVariables,
  isConfigurationTemplateName,
  validateConfigurationSchema,
} from './schema.js';

test('configuration schema has complete unique metadata and no secret examples', () => {
  assert.doesNotThrow(() => validateConfigurationSchema());
  assert.ok(configurationVariables.length > 100);
  assert.ok(
    configurationVariables.every((variable) => !variable.secret || variable.example === ''),
  );
  assert.ok(configurationSchema.sections.some((section) => section.name === 'Stripe billing'));
});

test('provider concurrency templates enumerate only supported provider buckets', () => {
  const templates = configurationVariables.filter((variable) => variable.name.includes('<'));
  assert.deepEqual(
    templates.map((variable) => variable.name),
    ['ORVEX_PROVIDER_CONCURRENCY_<PROVIDER>', 'ORVEX_FLEET_PROVIDER_CONCURRENCY_<PROVIDER>'],
  );
  assert.equal(isConfigurationTemplateName('ORVEX_PROVIDER_CONCURRENCY_LUNA'), true);
  assert.equal(isConfigurationTemplateName('ORVEX_PROVIDER_CONCURRENCY_UNKNOWN'), false);
  assert.equal(isConfigurationTemplateName('ORVEX_FLEET_PROVIDER_CONCURRENCY_DEEPSEEK'), true);
  assert.equal(isConfigurationTemplateName('ORVEX_FLEET_PROVIDER_CONCURRENCY_UNKNOWN'), false);
  assert.equal(isConfigurationTemplateName('ORVEX_OTHER_DYNAMIC_VALUE'), false);
});
