# Normal-user launch inputs

The application and deployment gates cover the technical launch path. These
items still require an operator or business owner to confirm before opening
self-serve signup broadly:

- **Billing:** confirm the live Stripe price IDs, monthly prices, included
  units, overage rates, refund policy, tax handling, and cancellation policy
  match the public pricing page.
- **Pro economics:** the current 10-review/hour ceiling permits up to 7,200
  reviews in a 30-day period. Measure the real p95 provider cost per normal and
  deep review, then approve that exposure or set a monthly spend/capacity
  guard before paid traffic starts. The live database currently shows 149
  completed reviews in the last 30 days at an average recorded cost of about
  `$0.324` and a maximum of about `$1.032`; at the current ceiling that implies
  roughly `$2,335` average-cost exposure per Pro workspace per month.
- **Provider capacity:** confirm rate limits and fallback capacity for every
  configured model provider at the expected launch concurrency. A missing
  required provider now fails closed instead of silently degrading a review.
- **Data processing:** confirm the provider/subprocessor list, data-processing
  terms, retention period, deletion workflow, and applicable jurisdictions with
  counsel. The product accepts deletion and export requests at
  `support@useorvex.com`.
- **Backups:** set `ORVEX_BACKUP_REMOTE` to an off-site destination, restrict
  its access, and complete a restore drill. Local SQLite backups are scheduled
  every six hours by the safe deployment.
- **Operations:** connect an external monitor to `/health` and `/ready`, define
  an on-call owner, and verify the alert path for queue, database, provider,
  billing, and webhook failures.
- **Edge routing:** verify the CDN redirects `www.useorvex.com` to
  `useorvex.com`; the application also enforces this redirect when the request
  reaches the origin.
- **GitHub distribution:** verify the App permissions, subscribed events,
  callback URLs, webhook secret, and Marketplace/listing copy in the live
  GitHub App settings.

Until the unchecked inputs are confirmed, launch to a small invited cohort and
keep the existing rate limits in place.
