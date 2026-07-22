# Orvex — shared brand facts (use REAL content, never lorem)

**Product:** Orvex Review — a GitHub App that automatically reviews pull requests.
**Brand mark:** `±` (a plus-minus glyph — reads as "diff"). Wordmark: "Orvex".
**Slogan (headline, use verbatim):** Catch bugs before production.

## What it actually does (true claims — safe to use)
- Installs as a GitHub App (scoped: pull_requests read/write, contents read). No passwords pasted.
- **Deterministic rules run first** (before any LLM token is spent) — cheap, exact checks.
- **Then a multi-model AI ensemble reviews** — up to THREE independent models on one PR
  (different models catch different bugs; the merged result is the differentiator).
- **Runs your code, doesn't just read the diff** — the runtime-proof moat (sandbox execution).
- **Never repeats a finding** — push three times, get zero repeated nits. Replies "Fixed"
  when you actually fix it. Roughly 8 comments max — signal, not noise.
- **`@orvex deep`** — an on-demand deeper pass for critical PRs.
- Your repo sets the rules (`.orvex-review.yml`), config-as-code.

## Proof (REAL, from our competitive scoreboard — safe to feature)
- On real PRs, benchmarked head-to-head against other review bots, Orvex led on catch rate:
  **Orvex 43%** · Codex 29% · CodeRabbit 28% · Qodo 22% (defect-cluster catch rate across
  80 real PRs). Frame as: "caught more real bugs than any single competitor," and
  "caught bugs the others missed."
- Honest nuance (do NOT overclaim precision): the story is COVERAGE — more models, more
  passes, more real bugs surfaced. Lead with catch rate and unique catches.

## Pricing (current, real)
- Starter — $29/mo · 100 reviews · then $0.50/review · 2 AI models
- Pro Unlimited — $69/mo · unlimited reviews · 2 AI models
- Verify Lite — $49/mo · 50 reviews · then $0.75 · 3 AI models (premium track, budget entry)
- Verify — $99/mo · 120 reviews · then $0.75 · 3 AI models + runs your code
- Enterprise — custom · SSO/SAML, bring-your-own-LLM key, SLA
- Every account starts with 10 free reviews — no card required.
- Priced per workspace, not per seat.

## Voice
Plain-spoken, confident, developer-to-developer. Specific beats clever. No hype words
("revolutionary", "game-changing"). State outcomes. The buyer's fear is a bug reaching prod.

## Hard technical constraints (Artifact CSP — self-contained ONLY)
- ONE self-contained .html file. Inline ALL CSS and JS. NO external requests of any kind
  (no font CDNs, no external images, no scripts). Use system font stacks (they're CSP-safe:
  ui-monospace/SF Mono for mono, system-ui/-apple-system for sans) — do NOT link webfonts.
- All visuals must be CSS / inline SVG / Canvas — no <img> to external URLs. A data-URI SVG is ok.
- Write the FULL page body directly (the harness wraps <!doctype><head><body>). Do not add
  <html>/<head>/<body> tags. A minimal CSS reset is already applied.
- **Design BOTH themes** via CSS custom properties: define tokens on :root, redefine under
  `@media (prefers-color-scheme: dark)`, AND under `:root[data-theme="dark"]` /
  `:root[data-theme="light"]` (the viewer's toggle stamps data-theme and must win).
- Responsive: relative units, flex/grid, wide content scrolls in its own overflow-x container,
  the page body never scrolls sideways. Respect `prefers-reduced-motion`.
- Accessible: visible keyboard focus, real contrast in both themes, semantic headings.
