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

const render = (over: Partial<InlineFindingRender['finding']> = {}, top: Partial<InlineFindingRender> = {}): InlineFindingRender => ({
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
  const body = formatReviewBody([finding({ severity: 'P1' })], [], { ...meta, trigger: '@orvex', canAutofix: true });
  assert.match(body, /Fix all of these with Orvex/);
  assert.match(body, /`@orvex fix all`/);
  assert.match(body, /re-verified before it's fixed/);
});

test('fix-all box is hidden for free plans (canAutofix false)', () => {
  const body = formatReviewBody([finding({ severity: 'P1' })], [], { ...meta, trigger: '@orvex', canAutofix: false });
  assert.doesNotMatch(body, /Fix all of these with Orvex/);
});

test('fix-all box is hidden when there are no actionable findings', () => {
  const body = formatReviewBody([], [], { ...meta, trigger: '@orvex', canAutofix: true }, [finding({ severity: 'P3' })]);
  assert.doesNotMatch(body, /Fix all of these with Orvex/);
});
