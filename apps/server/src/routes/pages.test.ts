import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeHtml, pageShell } from './pages.js';

test('page shell uses landmarks, external CSS, and escapes account data in text and attributes', () => {
  const html = pageShell('Connect <workspace>', '<h1>Connect</h1>', { login: 'team-"<script>' });

  assert.match(html, /<header class="top">/);
  assert.match(html, /<main class="card" id="main-content">/);
  assert.match(html, /href="\/assets\/shell\.css"/);
  assert.match(html, /team-&quot;&lt;script&gt;/);
  assert.doesNotMatch(html, /<style|<script(?=[\s>])|\s+on[a-z]+\s*=/i);
});

test('escapeHtml is safe for text and quoted attribute contexts', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});
