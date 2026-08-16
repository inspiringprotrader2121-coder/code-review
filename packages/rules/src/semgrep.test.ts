import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSemgrepJson, parseSemgrepOutput, semgrepScanArgs } from './semgrep.js';

test('runs Semgrep with its explicit automatic ruleset', () => {
  assert.deepEqual(semgrepScanArgs(['src/a.ts', 'src/b.py']), [
    'scan',
    '--config',
    'auto',
    '--json',
    '--quiet',
    '--',
    'src/a.ts',
    'src/b.py',
  ]);
});

test('parses native Semgrep JSON findings instead of SARIF fields', () => {
  const findings = parseSemgrepJson(
    JSON.stringify({
      results: [
        {
          check_id: 'javascript.lang.security.audit.eval-detected.eval-detected',
          path: 'apps/server/src/example.ts',
          start: { line: 42 },
          extra: { message: 'Detected eval()', severity: 'ERROR' },
        },
        {
          check_id: 'typescript.lang.correctness.no-unused-vars',
          path: 'packages/review/src/example.ts',
          start: { line: 7 },
          extra: { message: 'Unused variable', severity: 'INFO' },
        },
      ],
    }),
  );

  assert.deepEqual(findings, [
    {
      file: 'apps/server/src/example.ts',
      line: 42,
      severity: 'P1',
      category: 'semgrep',
      message: 'Detected eval()',
      confidence: 0.95,
      ruleId: 'semgrep.javascript.lang.security.audit.eval-detected.eval-detected',
    },
    {
      file: 'packages/review/src/example.ts',
      line: 7,
      severity: 'P3',
      category: 'semgrep',
      message: 'Unused variable',
      confidence: 0.95,
      ruleId: 'semgrep.typescript.lang.correctness.no-unused-vars',
    },
  ]);
});

test('maps native Semgrep match severities without downgrading critical or high findings', () => {
  const findings = parseSemgrepJson(
    JSON.stringify({
      results: [
        {
          check_id: 'critical-rule',
          path: 'critical.ts',
          start: { line: 1 },
          extra: { severity: 'CRITICAL' },
        },
        {
          check_id: 'high-rule',
          path: 'high.ts',
          start: { line: 2 },
          extra: { severity: 'HIGH' },
        },
        {
          check_id: 'medium-rule',
          path: 'medium.ts',
          start: { line: 3 },
          extra: { severity: 'MEDIUM' },
        },
        {
          check_id: 'low-rule',
          path: 'low.ts',
          start: { line: 4 },
          extra: { severity: 'LOW' },
        },
      ],
    }),
  );

  assert.deepEqual(
    findings.map(({ file, severity }) => ({ file, severity })),
    [
      { file: 'critical.ts', severity: 'P1' },
      { file: 'high.ts', severity: 'P2' },
      { file: 'medium.ts', severity: 'P3' },
      { file: 'low.ts', severity: 'P3' },
    ],
  );
});

test('malformed Semgrep output is skipped without failing a review', () => {
  assert.deepEqual(parseSemgrepOutput('not JSON'), []);
});
