import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadProcessRole,
  processRoleRunsHttp,
  processRoleRunsScheduler,
  processRoleRunsWorkers,
} from './topology.js';

test('process roles default to the compatible all-in-one topology and parse case-insensitively', () => {
  assert.equal(loadProcessRole(undefined), 'all');
  assert.equal(loadProcessRole(' API '), 'api');
  assert.equal(loadProcessRole('worker'), 'worker');
  assert.equal(loadProcessRole('SCHEDULER'), 'scheduler');
  assert.throws(() => loadProcessRole('web'), /ORVEX_PROCESS_ROLE/);
});

test('process role responsibilities remain disjoint outside the compatibility role', () => {
  assert.equal(processRoleRunsHttp('all'), true);
  assert.equal(processRoleRunsWorkers('all'), true);
  assert.equal(processRoleRunsScheduler('all'), true);
  assert.equal(processRoleRunsHttp('api'), true);
  assert.equal(processRoleRunsWorkers('api'), false);
  assert.equal(processRoleRunsScheduler('api'), false);
  assert.equal(processRoleRunsHttp('worker'), false);
  assert.equal(processRoleRunsWorkers('worker'), true);
  assert.equal(processRoleRunsScheduler('worker'), false);
  assert.equal(processRoleRunsHttp('scheduler'), false);
  assert.equal(processRoleRunsWorkers('scheduler'), false);
  assert.equal(processRoleRunsScheduler('scheduler'), true);
});
