import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReviewBody, formatInlineFinding, type InlineFindingRender } from './format.js';
import type { ReviewFinding } from './finding.js';

const meta = {
  owner: 'acme',
  repo: 'web',
  pr: 42,
  headSha: 'abcdef1234567',
};

const finding = (over: Partial<ReviewFinding>): ReviewFinding => ({
  file: 'src/a.ts',
  line: 12,
  severity: 'P2',
  category: 'correctness',
  message: 'msg',
  confidence: 0.8,
  ruleId: 'llm.general',
  ...over,
});

const render = (
  over: Partial<InlineFindingRender['finding']> = {},
  top: Partial<InlineFindingRender> = {},
): InlineFindingRender => ({
  finding: {
    severity: 'P2',
    ruleId: 'llm.general',
    message: 'Null deref when user is missing',
    fingerprint: 'v2-aaaabbbbccccdddd',
    file: 'src/a.ts',
    line: 12,
    ...over,
  },
  trigger: '@orvex',
  canAutofix: true,
  ...top,
});

test('inline finding renders a collapsed AI-agent prompt naming the file and line', () => {
  const out = formatInlineFinding(render());
  assert.match(out, /🤖 Prompt for AI agents/);
  assert.match(out, /Fix this issue in `src\/a\.ts` around line 12/);
  // quad-backtick fence so the prompt can safely contain its own ``` blocks
  assert.match(out, /````/);
});

test('AI-agent prompt falls back to a location-agnostic phrase when file is absent', () => {
  const out = formatInlineFinding(render({ file: undefined, line: undefined }));
  assert.match(out, /the code at the line this comment is on/);
});

test('fix-all box renders for paid plans with actionable findings and names the command', () => {
  const body = formatReviewBody([finding({ severity: 'P1' })], [], {
    ...meta,
    trigger: '@orvex',
    canAutofix: true,
  });
  assert.match(body, /Fix all of these with Orvex/);
  assert.match(body, /`@orvex fix all`/);
  assert.match(body, /re-verified before it's fixed/);
});

test('fix-all box is hidden for free plans (canAutofix false)', () => {
  const body = formatReviewBody([finding({ severity: 'P1' })], [], {
    ...meta,
    trigger: '@orvex',
    canAutofix: false,
  });
  assert.doesNotMatch(body, /Fix all of these with Orvex/);
});

test('fix-all box is hidden when there are no actionable findings', () => {
  const body = formatReviewBody([], [], { ...meta, trigger: '@orvex', canAutofix: true }, [
    finding({ severity: 'P3' }),
  ]);
  assert.doesNotMatch(body, /Fix all of these with Orvex/);
});

test('a skipped pass never reads as a clean bill of health', () => {
  const meta = {
    owner: 'o',
    repo: 'r',
    pr: 1,
    headSha: 'abcdef1234567890',
    stats: { newCount: 0, fixedCount: 0, openCount: 0 },
    skippedLenses: ['pass 3/3 (perf/completeness/api)'],
  };
  const body = formatReviewBody([], [], meta);
  assert.match(body, /did not complete/, 'must disclose the skipped pass');
  assert.doesNotMatch(
    body,
    /it looks good to merge/,
    'a pass that never ran cannot vouch for what it would have found',
  );
  assert.match(body, /NOT a full sign-off/i);
});

test('a fully-completed clean review still reads as clean', () => {
  const body = formatReviewBody([], [], {
    owner: 'o',
    repo: 'r',
    pr: 1,
    headSha: 'abcdef1234567890',
    stats: { newCount: 0, fixedCount: 0, openCount: 0 },
  });
  assert.match(body, /it looks good to merge/);
  assert.doesNotMatch(body, /did not complete/);
});

test('manual-review candidates remain visible without becoming inline findings or auto-fix work', () => {
  const body = formatReviewBody([], [], {
    ...meta,
    trigger: '@orvex',
    canAutofix: true,
    reviewOnly: [
      {
        finding: finding({ severity: 'P2', message: 'Possible auth bypass' }),
        reason: 'Verifier did not confirm it: not enough evidence in the diff',
      },
    ],
  });
  assert.match(body, /No confirmed issues to post inline/);
  assert.match(body, /finding for manual review/);
  assert.match(body, /Possible auth bypass/);
  assert.match(body, /not enough evidence in the diff/);
  assert.doesNotMatch(body, /Fix all of these with Orvex/);
  assert.doesNotMatch(body, /it looks good to merge/);
});

test('summary body ends with a compact commands footer', () => {
  const body = formatReviewBody([], [], { ...meta, trigger: '@orvex' });
  assert.match(body, /@orvex help/);
  assert.match(body, /@orvex rate limit/);
  assert.match(body, /@orvex review/);
});

test('untrusted summaries and finding text cannot escape markdown sections', () => {
  const body = formatReviewBody(
    [
      finding({
        message: '<details><summary>hide the finding</summary>```',
        suggestion: '<details>bad```',
      }),
    ],
    [],
    { ...meta, summary: 'summary```<details><summary>bad', trigger: '@orvex', canAutofix: true },
  );
  assert.doesNotMatch(body, /summary```/);
  assert.doesNotMatch(body, /<details><summary>hide/);
  assert.ok((body.match(/<details/g) ?? []).length <= (body.match(/<\/details>/g) ?? []).length);
});

test('apply checkbox remains outside an attacker-opened code fence', () => {
  const body = formatInlineFinding(render({ suggestion: 'suggestion\n````' }));
  const checkbox = body.indexOf('orvex:apply:');
  assert.ok(checkbox >= 0);
  assert.equal((body.slice(0, checkbox).match(/```/g) ?? []).length % 2, 0);
});
