import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSuperadminPage } from './superadmin-view.js';

test('super-admin view has external assets and polite operator status regions', () => {
  const html = renderSuperadminPage();
  assert.match(html, /href="\/assets\/superadmin\.css"/);
  assert.match(html, /src="\/assets\/superadmin\.js" defer/);
  assert.match(html, /id="status" role="status" aria-live="polite"/);
  assert.match(html, /id="deadLetters" aria-labelledby="deadLettersTitle" aria-live="polite"/);
  assert.doesNotMatch(html, /<style|onclick=|style=/);
});
