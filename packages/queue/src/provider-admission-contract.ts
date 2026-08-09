import assert from 'node:assert/strict';
import type { ProviderAdmission } from './provider-admission.js';

/** Black-box contract shared by memory and Redis provider admission adapters. */
export async function assertProviderAdmissionContract(admission: ProviderAdmission): Promise<void> {
  assert.equal(await admission.getProviderCooldownMs('Luna'), 0);
  await admission.setProviderCooldown('Luna', 250);
  assert.ok(
    (await admission.getProviderCooldownMs('luna')) > 0,
    'cooldown is normalized and visible',
  );

  const first = await admission.acquireProviderLease('deepseek', 1);
  let secondAcquired = false;
  const waiting = admission.acquireProviderLease('deepseek', 1).then((token) => {
    secondAcquired = true;
    return token;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondAcquired, false, 'provider cap blocks a second caller');
  await admission.releaseProviderLease('deepseek', first);
  const second = await waiting;
  await admission.releaseProviderLease('deepseek', second);

  const held = await admission.acquireProviderLease('minimax', 1);
  const controller = new AbortController();
  const cancelled = admission.acquireProviderLease('minimax', 1, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, /cancelled while waiting for provider lease/);
  await admission.releaseProviderLease('minimax', held);
}
