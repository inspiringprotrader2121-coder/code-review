/** Shared server-rendered page shell for the connect / onboarding flow. */

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;'); // also escape single quotes so the helper is safe in attribute context
}

const SHELL_CSS = `
  :root {
    --page: #f4f4f7; --surface: #ffffff; --ink: #17181f; --ink-2: #55575f;
    --ink-3: #86888f; --border: rgba(23,24,31,.12); --accent: #4f58d6;
    --accent-ink: #3d45b8; --accent-wash: rgba(79,88,214,.09);
    --good: #0b7c2a; --good-wash: rgba(12,163,12,.10);
    --crit: #b32f2f; --crit-wash: rgba(208,59,59,.10);
    --btn-ink: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page: #0e0f14; --surface: #171821; --ink: #f0f0f4; --ink-2: #b4b6c1;
      --ink-3: #797b87; --border: rgba(240,240,244,.12); --accent: #99a2ff;
      --accent-ink: #b1b8ff; --accent-wash: rgba(153,162,255,.11);
      --good: #4fc06a; --good-wash: rgba(12,163,12,.16);
      --crit: #e66767; --crit-wash: rgba(230,103,103,.13);
      --btn-ink: #14151c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--page); color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 15px; line-height: 1.55; min-height: 100vh;
    display: flex; flex-direction: column; align-items: center;
    padding: 0 16px 64px;
  }
  .top {
    width: 100%; max-width: 560px; display: flex; align-items: center;
    gap: 10px; padding: 22px 0 8px;
  }
  .mark {
    width: 28px; height: 28px; border-radius: 8px; background: var(--accent);
    color: var(--btn-ink); font-weight: 700; font-size: 14px;
    display: inline-flex; align-items: center; justify-content: center;
    font-family: ui-monospace, monospace;
  }
  .brand { font-weight: 700; font-size: 16px; }
  .top .who { margin-left: auto; font-size: 12.5px; color: var(--ink-3); }
  .top .who a { color: var(--accent-ink); }
  .card {
    width: 100%; max-width: 560px; background: var(--surface);
    border: 1px solid var(--border); border-radius: 14px;
    padding: 28px; margin-top: 18px;
    box-shadow: 0 1px 2px rgba(0,0,0,.05), 0 8px 28px rgba(0,0,0,.06);
  }
  h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: 0; }
  p.lead { color: var(--ink-2); margin: 0 0 20px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 5px; }
  input {
    width: 100%; font-size: 15px; padding: 9px 12px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--page); color: var(--ink);
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
  .hint { font-size: 12px; color: var(--ink-3); margin: 4px 0 0; }
  button, .btn {
    display: inline-flex; justify-content: center; align-items: center; gap: 8px;
    width: 100%; margin-top: 20px; padding: 11px 16px; font-size: 14.5px;
    font-weight: 650; border: 0; border-radius: 9px; cursor: pointer;
    background: var(--accent); color: var(--btn-ink); text-decoration: none;
  }
  button:hover, .btn:hover { filter: brightness(1.06); }
  .btn.secondary {
    background: transparent; color: var(--ink-2); border: 1px solid var(--border);
  }
  .steps { display: flex; gap: 6px; margin: 0 0 18px; padding: 0; list-style: none; }
  .steps li {
    flex: 1; text-align: center; font-size: 11.5px; font-weight: 650;
    color: var(--ink-3); padding: 6px 4px; border-radius: 7px; background: var(--page);
  }
  .steps li.active { color: var(--accent-ink); background: var(--accent-wash); }
  .steps li.done { color: var(--good); background: var(--good-wash); }
  .ws-list { margin: 18px 0 0; padding: 0; list-style: none; display: grid; gap: 8px; }
  .ws-list li {
    display: flex; align-items: center; gap: 10px; padding: 10px 13px;
    border: 1px solid var(--border); border-radius: 10px; font-size: 13.5px;
  }
  .ws-list .slug { font-family: ui-monospace, monospace; color: var(--ink-3); font-size: 12px; }
  .ws-list .role {
    margin-left: auto; font-size: 11px; font-weight: 700; letter-spacing: .04em;
    text-transform: uppercase; color: var(--accent-ink); background: var(--accent-wash);
    border-radius: 999px; padding: 2px 9px;
  }
  .ws-list a { color: var(--ink); text-decoration: none; font-weight: 600; }
  .ws-list a:hover { color: var(--accent-ink); }
  .kv { margin: 16px 0 0; display: grid; gap: 8px; font-size: 13.5px; }
  .kv div { display: flex; justify-content: space-between; gap: 16px; }
  .kv dt { color: var(--ink-3); }
  .kv dd { margin: 0; font-weight: 600; }
  .kv code { font-family: ui-monospace, monospace; font-size: 12.5px; }
  .banner {
    border-radius: 10px; padding: 12px 14px; font-size: 13.5px; margin-bottom: 16px;
  }
  .banner.error { background: var(--crit-wash); color: var(--crit); }
  .banner.ok { background: var(--good-wash); color: var(--good); }
  .banner.info { background: var(--accent-wash); color: var(--accent-ink); }
  .divider { border: 0; border-top: 1px solid var(--border); margin: 22px 0; }
  h2 { font-size: 14px; margin: 0 0 4px; }
  .muted { color: var(--ink-3); font-size: 12.5px; }
`;

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
<style>${SHELL_CSS}</style>
</head>
<body>
  <div class="top"><span class="mark">±</span><span class="brand">Orvex Review</span>${who}</div>
  <div class="card">${body}</div>
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
