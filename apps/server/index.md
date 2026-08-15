# Orvex — AI code review for GitHub pull requests

Orvex is a GitHub App that reviews pull requests when they open. Deterministic checks run first, then two or four AI passes by track, then a verifier re-checks each finding against source before posting. Free: 10 lifetime reviews, no card. Paid plans are per workspace, $29–$99/month, not per seat.

Canonical site: https://useorvex.com/
GitHub App: https://github.com/apps/orvex-review
Compare: https://useorvex.com/compare.md
Support: support@useorvex.com

## What a review does

Every completed review follows the same route:

1. Deterministic rules run first (config-as-code in `.orvex-review.yml`).
2. Two or four focused AI review passes run, depending on the review track. They inspect correctness, security, reliability, performance, and contract edges, then merge and deduplicate findings.
3. A strict verifier re-checks candidate findings against changed source and relevant context before Orvex posts them.

Orvex reads the changed files plus selected imports, dependents, and other relevant repository files. If GitHub omits a patch or configured file limits leave gaps, the review reports that limitation instead of implying full coverage.

Findings are tracked across pushes. Already-reported issues are suppressed. When a later change removes the anchored issue, Orvex can mark it fixed. The default is eight inline comments; additional findings stay in the summary.

Reviews are suggestions, not guarantees. Your CI and human reviewers gate merges — not Orvex.

## How to install Orvex

1. Create a free account at https://useorvex.com/auth/register (10 lifetime reviews, no card).
2. Continue to GitHub and install the Orvex Review GitHub App.
3. Select the repositories Orvex may review. It does not see repos you do not select.
4. Open or push to a pull request. Orvex reviews it automatically.

Installs are scoped: `pull_requests` read/write and `contents` read/write. No GitHub password or personal token is pasted into Orvex.

## GitHub commands

Comment these on a pull request. `@orvex help` posts the full list. `@orvex rate limit` shows remaining quota without starting a review.

- `@orvex review` — re-run the review on the current PR head
- `@orvex deep` — extra analysis on this PR (paid plans; two review units)
- `@orvex fix` / `@orvex fix all` / `@orvex fix this` — apply verified fixes
- `@orvex explain` — deeper explanation of a finding
- `@orvex ignore` — suppress a finding on the repo
- `@orvex rate limit` — remaining hourly / monthly quota

A completed standard review uses one unit. An on-demand deep review uses two. Skipped reviews and fix or explanation commands do not consume units. Failed reviews still count toward free-trial, hourly, and monthly caps.

## Pricing (USD, per workspace)

| Plan        | Price     | Allowance                                                                            |
| ----------- | --------- | ------------------------------------------------------------------------------------ |
| Free        | $0        | 10 lifetime reviews, 2/hour, no card                                                 |
| Starter     | $29/month | 100 included at 5/hour, then prepaid overage at $0.50/review                         |
| Pro         | $69/month | 500/month hard total at 10/hour                                                      |
| Verify Lite | $49/month | 50 included at 5/hour, then prepaid overage at $0.75/review, advanced review track   |
| Verify      | $99/month | 120 included at 10/hour, then prepaid overage at $1.50/review, advanced review track |

Every plan includes deterministic checks, two or four focused review passes by track, strict verification, finding memory, and autofix. Paid plans also include on-demand deep review (`@orvex deep`). Plans otherwise differ by review track, allowance, hourly capacity, queue priority, and support.

Only a workspace owner can start or change billing. Cancellation: email support@useorvex.com from the account address and include the workspace name. It takes effect at the end of the current paid period.

## What Orvex is not

- Not priced per developer seat.
- Not a merge requirement or a substitute for tests and human review.
- Public plans do not include a sold nightly whole-repo scan product.

## Policies

- [Compare](https://useorvex.com/compare.md)
- [Terms](https://useorvex.com/terms.md)
- [Privacy](https://useorvex.com/privacy.md)
- [Refunds](https://useorvex.com/refunds.md)
- [Agent index](https://useorvex.com/llms.txt)
