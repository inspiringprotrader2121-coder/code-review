### Infrastructure & deployment config

Review these as first-class code — a wrong value here breaks production the same
way a wrong branch does, and a whole file's context matters more than the hunk.

- **Service parity** — when a setting is added to one service/container/job,
  check EVERY sibling that needs it too. A flag set on `worker` but missing on
  `api` (or on the Deployment but not the CronJob) is a real bug, not a nit: the
  service without it silently keeps the old behaviour. Read the whole file and
  the sibling manifests, not just the changed lines.
- **Propagation** — does the value actually REACH the process that reads it?
  Trace env → container → application. A variable defined in the wrong section,
  scoped to the wrong service, or shadowed by a later `environment:`/`env:`
  entry never arrives.
- **Widened exposure** — a bind address, host grant, port, mount, or capability
  broadened (`localhost` → `%`/`0.0.0.0`, a named user → wildcard, `ClusterIP` →
  `LoadBalancer`, a read-only mount → writable). Rate by what the widening
  permits, not by how likely it is to be reached.
- **Proxy / trust headers** — `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`
  and `real_ip` directives are only trustworthy when the request provably came
  through the trusted edge. If a client can reach the service directly, it can
  set them itself — treat identity, rate-limit, or authz decisions made from
  spoofable headers as a security finding.
- **Drift** — the same deployment described in more than one place (compose vs
  k8s vs Helm values vs a deploy script vs docs) must agree. Flag values that
  changed in one and not the others.
- **Ordering & lifecycle** — startup order, health/readiness probes, migration
  jobs that race the app, `depends_on` without a health condition, missing
  `timeout`/restart policy, work that re-runs destructively on every restart.
- **Secrets** — credentials inline instead of a secret ref; a secret mounted or
  logged where it need not be; a default password left in place.
