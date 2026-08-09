/** Shared server-rendered page shell for the connect / onboarding flow. */

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;'); // also escape single quotes so the helper is safe in attribute context
}

import { assetHref } from '../assets/index.js';

export interface PageUser {
  login: string;
}

export function pageShell(title: string, body: string, user?: PageUser | null): string {
  const who = user
    ? `<span class="who">Signed in as <strong>${escapeHtml(user.login)}</strong> · <a href="/auth/logout">Sign out</a></span>`
    : '';
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — Orvex Review</title>
<link rel="stylesheet" href="${assetHref('shell.css')}" />
</head>
<body>
  <header class="top"><span class="mark" aria-hidden="true">±</span><span class="brand">Orvex Review</span>${who}</header>
  <main class="card" id="main-content">${body}</main>
</body></html>`;
}

export function onboardingSteps(current: 1 | 2 | 3): string {
  const items = ['1 · Sign in', '2 · Workspace', '3 · Install on GitHub'];
  return `<ol class="steps">${items
    .map((label, i) => {
      const n = i + 1;
      const cls = n < current ? 'done' : n === current ? 'active' : '';
      return `<li class="${cls}">${label}</li>`;
    })
    .join('')}</ol>`;
}
