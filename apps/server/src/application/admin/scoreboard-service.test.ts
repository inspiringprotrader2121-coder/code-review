import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ScoreboardService } from './scoreboard-service.js';

test('scoreboard service returns an empty read model and rejects traversal history names', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-scoreboard-service-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = new ScoreboardService({ listScanTargets: () => [] }, path.join(dir, 'app.db'));
  assert.equal(service.read().kind, 'missing');
  assert.equal(service.readHistory('../outside.json').kind, 'invalid_name');
  assert.equal(service.readHistory('missing.json').kind, 'not_found');
});

test('scoreboard history remains bounded to the application data directory', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orvex-scoreboard-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const history = path.join(dir, 'scoreboard-history');
  const file = '2026-08-09T12-00-00-000Z_hash.json';
  const service = new ScoreboardService({ listScanTargets: () => [] }, path.join(dir, 'app.db'));
  writeFileSync(
    path.join(dir, 'scoreboard.json'),
    JSON.stringify({
      repo: 'repo',
      generatedAt: '',
      prsAnalyzed: 0,
      bots: {},
      clusters: { total: 0, orvexMissed: [], orvexUnique: [] },
      perPr: [],
    }),
  );
  assert.equal(service.read().kind, 'ok');
  assert.deepEqual(service.history(), []);
  void history;
  assert.equal(service.readHistory(file).kind, 'not_found');
});
