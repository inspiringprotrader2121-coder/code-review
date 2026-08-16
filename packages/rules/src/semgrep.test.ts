import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSemgrepJson } from './semgrep.js';

test('parseSemgrepJson reads native --json results (not SARIF locations)', () => {
  const findings = parseSemgrepJson(
    JSON.stringify({
      results: [
        {
          check_id: 'javascript.lang.security.audit.xss.react-dangerouslysetinnerhtml',
          path: 'apps/web/src/App.tsx',
          start: { line: 42 },
          extra: {
            severity: 'ERROR',
            message: 'Detected dangerous HTML injection',
          },
        },
        {
          check_id: 'generic.secrets.security.detected-generic-api-key',
          path: 'config.ts',
          start: { line: 7 },
          extra: { severity: 'WARNING', message: 'Possible API key' },
        },
      ],
    }),
  );

  assert.equal(findings.length, 2);
  assert.equal(findings[0].file, 'apps/web/src/App.tsx');
  assert.equal(findings[0].line, 42);
  assert.equal(findings[0].severity, 'P1');
  assert.match(findings[0].ruleId, /semgrep\.javascript\.lang\.security/);
  assert.equal(findings[1].severity, 'P2');
  assert.equal(findings[1].message, 'Possible API key');
});

test('parseSemgrepJson ignores SARIF-shaped entries that lack path/start', () => {
  const findings = parseSemgrepJson(
    JSON.stringify({
      results: [
        {
          ruleId: 'x',
          level: 'error',
          message: { text: 'SARIF shape' },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: 'a.ts' },
                region: { startLine: 1 },
              },
            },
          ],
        },
      ],
    }),
  );
  assert.equal(findings.length, 0);
});
