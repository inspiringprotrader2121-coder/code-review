### CI / CD workflow files

CI runs with credentials and write access, so these are a security surface.

- **Untrusted-code execution** — `pull_request_target` (or an equivalent
  privileged trigger) combined with a checkout of the PR's head runs attacker
  code with write permissions and secret access. Flag unless the workflow
  clearly avoids executing the checked-out code.
- **Expression injection** — attacker-controllable values (`github.event.*`
  title/body/branch names) interpolated directly into a `run:` block execute as
  shell. They must be passed via `env:` and referenced as variables.
- **Excessive permissions** — missing or overly-broad `permissions` (especially
  `write-all`). Each job should declare least privilege.
- **Secret exposure** — secrets echoed, printed, written to logs/artifacts, or
  passed to steps that do not need them.
- **Unpinned third-party actions** — a mutable tag (`@v1`, `@main`) on a
  third-party action can be re-pointed at malicious code; prefer a full commit
  SHA. First-party (`actions/*`) on a major tag is acceptable.
- **Correctness** — `needs:` referencing a job that does not exist, `if:`
  conditions that never fire, misspelled action inputs (silently ignored),
  missing `fetch-depth: 0` where git history is required.
- **Reliability** — no `timeout-minutes` (a hung job holds a runner
  indefinitely), no `concurrency` control on push/PR triggers, `|| true`
  swallowing a failure that should fail the build.
