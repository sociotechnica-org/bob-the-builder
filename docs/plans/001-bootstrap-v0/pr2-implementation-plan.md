# PR2 Detailed Implementation Plan

Status: Ready  
Date: 2026-02-10  
Parent Plan: `docs/plans/001-bootstrap-v0/001-bootstrap-v0.md`  
Previous Slice: `docs/plans/001-bootstrap-v0/pr1-implementation-plan.md`

## 1. PR2 Objective

Deliver the first data-backed control plane slice:

1. Add D1 schema and migrations for `repos`, `runs`, `station_executions`, and `artifacts`.
2. Implement repo/run API endpoints in `apps/control-worker`.
3. Publish queue messages from run creation so PR3 can consume and orchestrate workflows.
4. Preserve PR1 auth behavior (`/v1/*` bearer-only, `/healthz` public).

## 2. PR2 Scope

### In Scope

1. D1 binding + SQL migrations wired into control worker.
2. Queue binding + producer publish on run creation.
3. API endpoints:
   - `POST /v1/repos`
   - `GET /v1/repos`
   - `POST /v1/runs`
   - `GET /v1/runs`
   - `GET /v1/runs/:id`
4. Validation and error handling for request payloads and route params.
5. Unit/integration tests for D1-backed behavior and queue producer calls.
6. Local dev docs for applying migrations and running with D1 + Queue bindings.

### Out of Scope

1. Queue consumer behavior (PR3).
2. Workflow orchestration/station execution logic (PR3+).
3. Modal/GitHub adapter execution (PR4/PR5).
4. Web dashboard data integration (PR6).
5. `POST /v1/runs/:id/cancel` (deferred to PR3).

## 3. Cloudflare Decisions for PR2

1. Use D1 as source of truth for run/repo metadata.
2. Use Cloudflare Queue producer only in control worker; consumer remains PR3.
3. Keep runtime contracts explicit in `Env`:
   - `DB: D1Database`
   - `RUN_QUEUE: Queue<RunQueueMessage>`
   - `BOB_PASSWORD: string`
4. Keep API auth bearer-only for `/v1/*` routes.
5. Keep schema SQL-first and checked in via Wrangler migrations.

## 4. Data Model and Migration Plan

## 4.1 Migration Files

1. Add migration directory under `apps/control-worker/migrations/`.
2. Add initial migration `0001_init.sql` with all baseline tables/indexes.
3. Do not seed repos in migration files for PR2; create repos manually through `POST /v1/repos`.

## 4.2 Table Contracts

1. `repos`
   - `id` text primary key
   - `owner`, `name`, `default_branch`, `config_path`
   - `enabled` as integer boolean (`0|1`)
   - `created_at`, `updated_at`
   - unique `(owner, name)`
2. `runs`
   - `id` text primary key
   - `repo_id` FK -> `repos.id`
   - `issue_number`, `goal`, `status`, `current_station`, `requestor`
   - `base_branch`, `work_branch`, `pr_mode`, `pr_url`
   - `created_at`, `started_at`, `finished_at`
3. `station_executions`
   - `id` text primary key
   - `run_id` FK -> `runs.id`
   - `station`, `status`, `started_at`, `finished_at`, `duration_ms`, `summary`
4. `artifacts`
   - `id` text primary key
   - `run_id` FK -> `runs.id`
   - `type`, `storage`, `payload`, `created_at`
5. `run_idempotency_keys`
   - `key` text primary key
   - `request_hash`, `run_id`, `status`, `created_at`, `updated_at`
   - enables safe request retries for `POST /v1/runs`

## 4.3 SQL Constraints and Indexes

1. CHECK constraints for enum-like columns:
   - `runs.status`
   - `runs.pr_mode`
   - `station_executions.station`
   - `station_executions.status`
   - `artifacts.storage`
2. Indexes:
   - `runs(repo_id, created_at desc)`
   - `runs(status, created_at desc)`
   - `station_executions(run_id, station)`
   - `artifacts(run_id, created_at desc)`
3. Use ISO timestamps (`datetime('now')`) consistently.

## 5. API Design for PR2

## 5.1 `POST /v1/repos`

1. Request body:
   - `owner` (required)
   - `name` (required)
   - `defaultBranch` (optional, default `main`)
   - `configPath` (optional, default `.bob/factory.yaml`)
   - `enabled` (optional, default `true`)
2. Validation:
   - non-empty owner/name
   - allow only `sociotechnica-org/lifebuild` in v0
3. Behavior:
   - create only
   - reject duplicate `(owner, name)` with `409 Conflict` (standard POST collection behavior)
4. Response:
   - normalized repo record.

## 5.2 `GET /v1/repos`

1. Returns all repos (or enabled-only filter if query param added now).
2. Response sorted by `owner`, `name`.

## 5.3 `POST /v1/runs`

1. Request body:
   - `repo: { owner, name }`
   - `issue: { number }`
   - `requestor`
   - `prMode` (`draft|ready`, default `draft`)
   - optional `goal`
2. Validation:
   - repo exists and is enabled
   - issue number positive integer
   - requestor present
   - `prMode` valid
   - `Idempotency-Key` header required
3. Behavior:
   - create run row in status `queued`
   - set `base_branch` from repo default branch
   - publish queue message with run id + metadata
   - dedupe retries by idempotency key + request hash
4. Response:
   - `202 Accepted` with run record and enqueue metadata.

## 5.4 `GET /v1/runs`

1. List recent runs with optional query filters:
   - `status`
   - `repo`
   - `limit` (bounded)
2. Return lightweight list fields for dashboard/API clients.

## 5.5 `GET /v1/runs/:id`

1. Return run details with repo summary.
2. Optionally include station/artifact counts for quick status views.

## 6. Queue Producer Contract

1. Define `RunQueueMessage` in `packages/core` for reuse by producer/consumer:
   - `runId`
   - `repoId`
   - `issueNumber`
   - `requestedAt`
   - `prMode`
2. Use JSON payload in queue message body.
3. Publish after successful run insert.
4. On publish failure:
   - update run status to `failed` with queue-failure summary metadata
   - return `503` with run id and retry guidance
   - log structured error with run id for operational debugging.

## 7. Code Organization Changes

## 7.1 `apps/control-worker/src/index.ts`

1. Split route handlers into focused functions:
   - repo handlers
   - run handlers
   - shared response helpers
2. Keep auth check once at `/v1/*` boundary.
3. Keep route fallback behavior explicit (`404` JSON).

## 7.2 Optional Internal Modules

If complexity rises, introduce:

1. `apps/control-worker/src/db.ts` for SQL statements.
2. `apps/control-worker/src/validation.ts` for payload validation.
3. `apps/control-worker/src/queue.ts` for message construction/publish.

Keep this minimal and avoid over-abstraction.

## 8. Configuration and Infra Updates

1. Update `apps/control-worker/wrangler.jsonc`:
   - add `d1_databases` binding for `DB`
   - add `queues.producers` binding for `RUN_QUEUE`
2. Update `infra/wrangler/README.md`:
   - create/apply D1 migrations locally
   - local queue/dev guidance
3. Add any required `.dev.vars` documentation (no secrets committed).

## 9. Test Strategy

## 9.1 Unit Tests

1. Validate payload parsing and response codes for invalid requests.
2. Validate repo/run mapping and serialization logic.
3. Validate queue message shape.

## 9.2 Worker Route Tests

1. Extend `apps/control-worker/test/index.test.ts` to cover:
   - repo creation and listing
   - run creation (authorized)
   - run fetch/list
   - bearer-only auth guard remains enforced

## 9.3 Integration Smoke

1. Keep existing smoke for `/healthz` + `/v1/ping`.
2. Add smoke coverage for new repo/run API paths:
   - `POST /v1/repos`
   - `GET /v1/repos`
   - `POST /v1/runs`
   - `GET /v1/runs`
   - `GET /v1/runs/:id`
3. Keep CI smoke deterministic and fast.

## 10. Verification Commands

Run before merge:

1. `pnpm format:check`
2. `pnpm lint-all`
3. `pnpm test`
4. `pnpm smoke:control-worker`

Manual API checks (with auth):

1. Create/list repo.
2. Create run and confirm `queued` row exists in D1.
3. Confirm queue publish happened (via queue logs/local consumer stub evidence).

## 11. PR2 Acceptance Criteria

1. D1 schema exists, migrates locally, and enforces core constraints.
2. Repo and run APIs are functional with validated inputs.
3. Run creation publishes queue message with stable contract.
4. `/v1/*` routes remain bearer-token protected; no cookie fallback.
5. CI remains green for lint, unit tests, and smoke integration.
6. Docs clearly describe local setup and API usage.

## 12. Risks and Mitigations

1. Risk: queue publish succeeds/fails separately from DB writes.
   Mitigation: deterministic logging + explicit error behavior + documented recovery.
   Common failure modes: missing queue binding, permission/config errors, transient Cloudflare queue API/runtime errors.
2. Risk: API validation drift between producer and future consumer.
   Mitigation: centralize `RunQueueMessage` type in `packages/core`.
3. Risk: schema churn in PR3 due to missing fields.
   Mitigation: keep PR2 schema aligned to architecture doc and avoid speculative columns.

## 13. Handoff to PR3

After PR2 merge, PR3 should directly add:

1. Queue consumer reads `RunQueueMessage` and starts workflow instances.
2. Station execution records are created/updated as workflow proceeds.
3. Run status transitions are persisted from `queued` to terminal states.
