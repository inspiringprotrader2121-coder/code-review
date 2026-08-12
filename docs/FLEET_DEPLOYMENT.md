# Fleet Deployment

## Role Boundary

The server now has an explicit `ORVEX_PROCESS_ROLE` boundary:

| Role        | Responsibility                                                                  | HTTP listener |
| ----------- | ------------------------------------------------------------------------------- | ------------- |
| `all`       | Compatibility mode: API, workers, recovery, and scheduler in one process.       | yes           |
| `api`       | Dashboard, auth, billing, webhooks, and public routes.                          | yes           |
| `worker`    | Review execution, sandbox startup, and abandoned-checkout cleanup.              | no            |
| `scheduler` | Stale-run cleanup, queue orphan recovery, retention pruning, and nightly scans. | no            |

`all` is the default, so the existing guarded single-process deployment remains
compatible. Dedicated production `worker` and `scheduler` roles require a
stable `ORVEX_WORKER_ID`; never let a PID become the fleet identity.

The server package exposes `start:api`, `start:worker`, and `start:scheduler`
commands. Set `ORVEX_WORKER_ID` in the protected service environment before
starting a dedicated worker or scheduler.

## Same-host PM2 multi-app profile

`ecosystem.config.cjs` defines a same-host role split that keeps SQLite on one
machine while isolating HTTP from review work:

| PM2 app                  | Role        | Notes                                                                |
| ------------------------ | ----------- | -------------------------------------------------------------------- |
| `velatrix-api`           | `api`       | Port 8788; webhooks and dashboard stay responsive under review load. |
| `velatrix-scheduler`     | `scheduler` | Stable `ORVEX_WORKER_ID=scheduler-01`; registers fleet capacity.     |
| `velatrix-worker-01..13` | `worker`    | Stable `ORVEX_WORKER_ID=review-worker-NN`; **8** reviews each.       |

Fleet provider ceilings remain Redis-owned (`ORVEX_FLEET_PROVIDER_CONCURRENCY_*`
= 100/128/100, epoch `review-scale-v2`). Per-worker
`ORVEX_MAX_CONCURRENT_REVIEWS=8` is a local slot count only.
`ORVEX_FLEET_TENANT_CONCURRENCY=40` caps one tenant's concurrent claims for
fairness. Worker `kill_timeout` stays above `ORVEX_SHUTDOWN_DRAIN_MS`.

Workers also gate dequeue on host memory/disk headroom
(`ORVEX_HOST_MIN_AVAILABLE_MEMORY_BYTES` / `ORVEX_HOST_MIN_AVAILABLE_DISK_BYTES`)
so a saturated host does not claim more archive/sandbox work.

**Deploy:** `scripts/deploy-safe.sh --restart` startOrRestarts the full multi-app
ecosystem (api + scheduler + workers), stops every Orvex PM2 process before
file apply, deletes the legacy `velatrix-review` process on cutover, and refuses
to clear drain until api/scheduler plus at least one worker are online.

## Fleet Provider Capacity

`ORVEX_PROVIDER_CONCURRENCY_LUNA`, `_DEEPSEEK`, and `_MINIMAX` are **local**
worker ceilings. They protect one worker's CPU, sockets, and sandbox slots.
`ORVEX_FLEET_PROVIDER_CONCURRENCY_LUNA`, `_DEEPSEEK`, and `_MINIMAX` are the
whole-fleet ceilings. They default to the local values for the compatible
single-host deployment, but they must be set deliberately for a worker fleet.
`ORVEX_FLEET_TENANT_CONCURRENCY` is the matching whole-fleet review-claim
ceiling for one tenant. It defaults to the compatible worker limit; set it
below total fleet worker capacity when several tenants share the fleet.

The scheduler registers the global values in Redis under
`ORVEX_FLEET_CAPACITY_EPOCH`. Workers verify the same values before accepting
reviews, and every provider lease checks them atomically. That prevents a new
worker with a different environment from increasing paid-provider concurrency
by accident.

The Redis queue also holds one expiring, token-fenced review claim per active
tenant slot. A tenant at its ceiling is skipped while an eligible tenant can
start, and the slot is released by completion, failure, orphan recovery, or a
lease expiry. This is admission fairness, not a promise of a fixed completion
time: plan priority still applies among tenants that have capacity.

Deploy the scheduler before worker replicas. To change a global capacity:

1. Drain the fleet and wait for active work to finish.
2. Set the new global values on the scheduler and every worker.
3. Bump `ORVEX_FLEET_CAPACITY_EPOCH` consistently on every role.
4. Start the scheduler, verify it initializes the new plan, then start workers.

Do not roll different capacity epochs through live workers. The old and new
registries are intentionally separate, so a mixed fleet can temporarily exceed
the intended provider limit.

## Health Endpoints

| Endpoint         | Use                                                                                | Drain behavior                                                              |
| ---------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `/health`        | Process liveness.                                                                  | Always 200 while the process can answer.                                    |
| `/ready`         | Deployment gate. It checks DB, queue, global in-flight work, and release identity. | Remains 200 while draining so `deploy-safe.sh` can wait for active jobs.    |
| `/traffic-ready` | Load-balancer traffic admission.                                                   | Returns 503 while draining, on dependency failure, or from a non-HTTP role. |

Configure a managed load balancer to probe each API instance directly at
`GET /traffic-ready` and route traffic only after a 200 response. The reference
[Nginx configuration](../infra/load-balancer/nginx-orvex.conf.template) shows
the required forwarding headers and passive upstream failure handling.

Set `ORVEX_TRUSTED_PROXY_IPS` on every API instance to the exact socket IPs of
the controlled proxy or load balancer. Orvex ignores `X-Forwarded-For` and
`X-Real-IP` from any other peer. That preserves per-client authentication and
abuse rate limits instead of treating the proxy as every customer's address.

## Safety Gate: SQLite Is Single-Host

The current durable store is SQLite. Splitting roles on the existing host is
useful for isolation, but SQLite does **not** make a multi-host API or worker
fleet safe. Do not place more than one host behind the load balancer, or start
workers on another machine, while `STORE_PATH` points at SQLite. A network file
share is not an acceptable substitute.

Before a multi-host rollout, all of these gates must be complete:

1. Move durable application state from SQLite to Postgres with a tested,
   reversible import of tenants, identities, sessions, billing, review runs,
   findings, and queue-publication claims.
2. Make every billing charge, review reservation, review publication, and
   session invalidation transactional and safe under concurrent writers.
3. Keep Redis-backed per-tenant admission enabled and load-test it with the
   intended plan priorities. The queue enforces a tenant claim ceiling before
   review execution; any future weighted or reserved-capacity policy must keep
   the same token-fenced completion and recovery semantics.
4. Run a no-provider-cost load test with multiple API and worker processes,
   verifying tenant fairness, no duplicate publication or charging, drain and
   crash recovery, sandbox cleanup, and recovery leadership.
5. Add fleet metrics and alerts for queue depth and age, per-provider slots,
   tenant backlog, worker saturation, provider cooldowns, job lifecycle
   failures, and review latency percentiles.

Until those gates pass, the correct production topology is **one host**. The
same-host PM2 role split (`api` + `scheduler` + workers) is the intended SQLite
shape; do not place workers or API replicas on additional machines. Multi-host
still requires the Postgres and transactional gates above.

## Phase 5 status (Postgres / multi-host)

Not implemented in this scale upgrade. Remaining work to match Greptile/CodeRabbit
replica fleets:

1. Postgres store migration for `packages/store` (tenants, billing, runs, claims).
2. Transactional reservation/publication under concurrent writers.
3. Multi-host deploy + LB on `/traffic-ready`; per-host sandbox slot dirs.
4. Durable stage checkpoints so `ORVEX_MAX_RESUME_AFTER_RESTART` can be > 0 safely.
5. Fleet metrics/alerts listed in the gates above.

Same-host scale (Phases 0–4) is the production path until those land.

## Intended Multi-Host Topology

```text
Internet
  |
Load balancer (GET /traffic-ready per API instance)
  |
API replicas (ORVEX_PROCESS_ROLE=api)
  |                         \
Postgres                    Redis queue and fleet admission
  |                          |
Scheduler (one leader)    Worker replicas (ORVEX_PROCESS_ROLE=worker)
                              |
                         Local isolated sandbox slots
```

Keep the scheduler singleton or use an explicit durable leader lease. Workers
must each own local sandbox capacity; do not share a Docker socket across hosts.
Provider capacity must be set for the entire fleet and then allocated fairly to
workers and tenants, rather than multiplied by the number of replicas.

## Deployment Rules

All source changes still start locally. Use
`scripts/deploy-safe.sh --dry-run`, inspect its list, then use the guarded
restart command. Never raw-sync or edit runtime state, `node_modules`,
`dist`, `.data`, `.env`, database files, or PEM files. The normal release
procedure remains in the [deployment runbook](./DEPLOYMENT_RUNBOOK.md).
