import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrvexFindingTables } from './orvex-table.js';

test('parses only confirmed Orvex finding tables, not manual-review candidates', () => {
  const body = [
    '## Orvex Review',
    '',
    '| Severity | File | Message |',
    '| --- | --- | --- |',
    '| P2 | `src/auth.ts:12` | Missing authorization \\| breaks tenant isolation |',
    '',
    '<details><summary>🔎 1 finding for manual review</summary>',
    '',
    '| Severity | File | Candidate | Why manual review |',
    '| --- | --- | --- | --- |',
    '| P1 | `src/admin.ts:20` | Possible bypass | Verifier did not confirm it |',
    '',
    '</details>',
  ].join('\n');

  assert.deepEqual(parseOrvexFindingTables(body), [
    {
      severity: 'P2',
      path: 'src/auth.ts',
      line: 12,
      message: 'Missing authorization | breaks tenant isolation',
    },
  ]);
});

test('parses folded and prior finding tables with normalized info severity', () => {
  const body = [
    '| Severity | File | Message |',
    '| --- | --- | --- |',
    '| info | `docs/readme.md` | Spelling note |',
    '',
    '| Severity | File | Message |',
    '| --- | --- | --- |',
    '| P1 | `src/server.ts` | Existing crash |',
  ].join('\n');

  assert.deepEqual(parseOrvexFindingTables(body), [
    { severity: 'info', path: 'docs/readme.md', line: null, message: 'Spelling note' },
    { severity: 'P1', path: 'src/server.ts', line: null, message: 'Existing crash' },
  ]);
});

test('strict benchmark parsing fails closed on malformed confirmed-table rows', () => {
  const body = [
    '| Severity | File | Message |',
    '| --- | --- | --- |',
    '| P2 | `src/server.ts:8` | complete row |',
    '| P1 | no code ticks | malformed row |',
  ].join('\n');
  assert.throws(() => parseOrvexFindingTables(body, { strict: true }), /did not parse/);
});
