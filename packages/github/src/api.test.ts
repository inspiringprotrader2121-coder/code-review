import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipPr } from './api.js';
import type { PullRequestMeta } from './types.js';

function pr(overrides: Partial<PullRequestMeta> = {}): PullRequestMeta {
  return {
    number: 1,
    title: 't',
    headSha: 'sha',
    baseSha: 'base',
    draft: false,
    authorLogin: 'alice',
    htmlUrl: 'https://github.com/x/y/pull/1',
    state: 'open',
    ...overrides,
  };
}

test('a closed PR is skipped — the real incident: backlog jobs burning a full deep review on a PR closed before it ran', () => {
  assert.equal(
    shouldSkipPr(pr({ state: 'closed' }), { botLogin: 'orvex-review[bot]' }),
    'PR is closed',
  );
});

test('a merged PR (GitHub reports state=closed for merged PRs too) is skipped the same way', () => {
  // GitHub's REST API has no separate "merged" state — merged PRs are state='closed'
  // with merged_at set; PullRequestMeta only tracks `state`, so this is covered
  // by the same check.
  assert.equal(
    shouldSkipPr(pr({ state: 'closed' }), { botLogin: 'orvex-review[bot]' }),
    'PR is closed',
  );
});

test('an open PR is never skipped for being closed', () => {
  assert.equal(shouldSkipPr(pr({ state: 'open' }), { botLogin: 'orvex-review[bot]' }), null);
});

test('closed-state check runs BEFORE draft/dependabot/self-authored checks (cheapest, most disqualifying first)', () => {
  const closedDraft = pr({ state: 'closed', draft: true });
  assert.equal(shouldSkipPr(closedDraft, { botLogin: 'orvex-review[bot]' }), 'PR is closed');
});

test('existing skip reasons (draft, dependabot, self-authored) still work on an open PR', () => {
  assert.equal(shouldSkipPr(pr({ draft: true }), { botLogin: 'orvex-review[bot]' }), 'draft PR');
  assert.equal(
    shouldSkipPr(pr({ authorLogin: 'dependabot[bot]' }), { botLogin: 'orvex-review[bot]' }),
    'dependabot PR',
  );
  assert.equal(
    shouldSkipPr(pr({ authorLogin: 'orvex-review[bot]' }), { botLogin: 'orvex-review[bot]' }),
    'self-authored PR',
  );
});

test('a genuinely clean open PR is never skipped', () => {
  assert.equal(shouldSkipPr(pr(), { botLogin: 'orvex-review[bot]' }), null);
});
