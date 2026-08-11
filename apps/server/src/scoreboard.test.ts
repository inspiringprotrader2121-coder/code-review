import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildScoreboard } from './scoreboard.js';

test('scoreboard recognizes named unanchored Orvex severities', async () => {
  const listPulls = () => undefined;
  const listReviewComments = () => undefined;
  const listIssueComments = () => undefined;
  const issueComments = [
    ['Critical', 10],
    ['High', 20],
    ['Medium', 30],
    ['Low', 40],
  ].map(([severity, line]) => ({
    user: { login: 'orvex-review[bot]' },
    body: `**${severity}** · \`src/worker.ts:${line}\` · \`llm.correctness\``,
  }));
  const octokit = {
    rest: {
      pulls: { list: listPulls, listReviewComments },
      issues: { listComments: listIssueComments },
    },
    paginate: async (endpoint: unknown) => {
      if (endpoint === listPulls)
        return [{ number: 9, title: 'Named severities', state: 'open', merged_at: null }];
      if (endpoint === listReviewComments) return [];
      if (endpoint === listIssueComments) return issueComments;
      return [];
    },
  } as never;

  const scoreboard = await buildScoreboard(octokit, 'acme', 'api', 10);

  assert.equal(scoreboard.bots.orvex?.findings, 4);
  assert.deepEqual(
    scoreboard.clusters.orvexUnique.map((finding) => finding.severity),
    ['P1', 'P2', 'P3', 'info'],
  );
});
