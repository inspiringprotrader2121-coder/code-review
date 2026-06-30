import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signInstallState, verifyInstallState } from './install-state.js';

describe('install state', () => {
  it('round-trips signed state', () => {
    const state = signInstallState({ tenantSlug: 'acme', ts: Date.now() }, 'test-secret');
    const payload = verifyInstallState(state, 'test-secret');
    assert.equal(payload?.tenantSlug, 'acme');
  });

  it('rejects tampered state', () => {
    const state = signInstallState({ tenantSlug: 'acme', ts: Date.now() }, 'test-secret');
    const bad = `${state}x`;
    assert.equal(verifyInstallState(bad, 'test-secret'), null);
  });
});
