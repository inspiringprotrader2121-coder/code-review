import assert from 'node:assert/strict';
import test from 'node:test';
import { dashboardBootstrapAttributes } from './dashboard-view.js';

test('dashboard bootstrap view is typed data, not executable script interpolation', () => {
  const attributes = dashboardBootstrapAttributes({
    workspaceSlug: 'team-"<script>',
    showLlmCost: false,
  });
  assert.match(attributes, /data-workspace-slug="team-&quot;&lt;script&gt;"/);
  assert.match(attributes, /data-show-llm-cost="false"/);
  assert.doesNotMatch(attributes, /<script|javascript:/i);
});
