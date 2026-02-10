# PR3 Detailed Implementation Plan

Status: Proposed  
Date: 2026-02-10  
Parent Plan: `docs/plans/001-bootstrap-v0/001-bootstrap-v0.md`  
Previous Slice: `docs/plans/001-bootstrap-v0/pr2-implementation-plan.md`

## 1. PR3 Objective

Deliver the first real asynchronous execution slice after run submission:

1. Consume `RUN_QUEUE` messages in `apps/queue-consumer-worker`.
2. Execute a Workflow skeleton for each run (deterministic station sequence).
3. Persist run and station lifecycle state in D1 so clients can observe progress.
4. Make the system manually testable end-to-end via API without Modal/GitHub yet.

This PR should make a run move from `queued` to a terminal status automatically.

## 2. Why This Slice Now

PR2 completed control-plane + queue producer + idempotent run submission. The biggest missing value is execution. PR3 turns the current control-plane scaffold into a testable system behavior:

`POST /v1/runs` -> queue message consumed -> workflow steps run -> run finishes.

## 3. Scope

### In Scope

1. Queue consumer worker bound to D1 + queue consumer binding.
2. Workflow skeleton in queue-consumer worker with station ordering:
   - `intake`
   - `plan`
   - `implement`
   - `verify`
   - `create_pr`
3. Persisted status transitions for:
   - run: `queued -> running -> succeeded|failed`
   - station executions: `pending|running|succeeded|failed|skipped`
4. Idempotent message handling for queue at-least-once delivery.
5. Run detail API improvements in control worker so station state is visible.
6. Integration/smoke tests covering the new execution slice.

### Out of Scope

1. Real Modal VM execution (PR4).
2. Real GitHub branch/PR creation (PR5).
3. Realtime Agent streaming (later PR).
4. Full web dashboard behavior (PR6).
5. Advanced cancellation/retry UX (can be layered after this slice).

## 4. Cloudflare Architecture for PR3

## 4.1 Queue-Driven Workflow Start

1. `apps/control-worker` already publishes `RunQueueMessage`.
2. `apps/queue-consumer-worker` `queue()` handler validates message via `isRunQueueMessage`.
3. Consumer starts/continues workflow execution for `runId`.

## 4.2 Workflow Skeleton

Use Cloudflare Workflows in the queue-consumer app in the most standard shape:

1. Define `RunWorkflow` class in `apps/queue-consumer-worker/src/index.ts` (or split module if file grows).
2. Use deterministic workflow instance id: `run_<id>` (or exactly `runId`) to avoid duplicate starts.
3. Implement one method that runs ordered stations with durable step boundaries.
4. Persist station start/finish and summary text per station.

## 4.3 D1 as Execution Source of Truth

Run and station state is persisted in D1 and is the contract consumed by API/UI.

## 5. Data and State Strategy

## 5.1 Run Claim (Idempotent Queue Handling)

Queue delivery is at-least-once, so consumer must claim work atomically:

1. On message receipt, attempt:
   - `UPDATE runs SET status='running', started_at=?, current_station='intake', failure_reason=NULL WHERE id=? AND status='queued'`
2. If affected rows = 1: consumer owns execution.
3. If affected rows = 0: run is already `running` or terminal; treat as duplicate/no-op and ack.

This avoids duplicate workflow execution from retry storms.

## 5.2 Station Persistence

For each station:

1. Upsert/create station execution record keyed deterministically per run/station.
2. Mark `running` with `started_at`.
3. Execute placeholder station logic.
4. Mark `succeeded` with `finished_at`, `duration_ms`, and `summary`.

On any error:

1. Mark active station `failed`.
2. Mark run `failed`, set `finished_at`, keep `current_station`.
3. Persist `failure_reason` with bounded, operator-friendly message.

## 5.3 Successful Completion

After final station succeeds:

1. Update run:
   - `status='succeeded'`
   - `finished_at=?`
   - `current_station='create_pr'` (or `NULL`; choose one convention and document)
2. Optionally write a small synthetic artifact (inline) proving pipeline completion.

## 6. API Changes in Control Worker (PR3)

Make run execution observability available via existing API surface.

## 6.1 `GET /v1/runs/:id`

Expand response to include:

1. `run` (existing shape)
2. `stations` ordered by canonical station order or started time
3. Optional lightweight `artifacts` metadata list (id/type/createdAt)

This gives immediate manual QA visibility without waiting for web app work.

## 6.2 Optional Additions (Only if Needed)

If response size/shape becomes messy, add:

1. `GET /v1/runs/:id/stations`
2. `GET /v1/runs/:id/artifacts`

Default preference: keep PR3 minimal by enriching `GET /v1/runs/:id` first.

## 7. Queue Consumer Worker Deliverables

1. `wrangler.jsonc` updates:
   - D1 binding (`DB`)
   - queue consumer binding for `bob-runs`
   - workflow binding for run workflow class
2. Runtime `Env` typing for queue + DB + workflow binding.
3. Message validation + structured logging:
   - `queue.batch.received`
   - `queue.message.invalid`
   - `run.claimed`
   - `run.claim.duplicate`
   - `station.started`
   - `station.succeeded`
   - `station.failed`
   - `run.succeeded`
   - `run.failed`

## 8. Placeholder Station Behavior (PR3)

To keep this vertical and testable before PR4/PR5:

1. `intake`: record issue metadata placeholder summary.
2. `plan`: record placeholder plan summary.
3. `implement`: simulate execution (short deterministic delay or immediate success).
4. `verify`: simulate verification result.
5. `create_pr`: simulate PR creation result and set placeholder summary.

No external calls in PR3. The point is durable orchestration + persistence.

## 9. Test Plan

## 9.1 Unit Tests (Queue Consumer)

1. Invalid message payload is rejected and logged without state mutation.
2. Claim succeeds only when run is `queued`.
3. Duplicate message on non-`queued` run is no-op.
4. Station transitions are persisted correctly on success.
5. Failure path marks station + run failed.

## 9.2 Integration Tests

1. Add integration tests for queue-consumer worker using D1-backed test doubles.
2. Add/extend control-worker integration tests verifying `GET /v1/runs/:id` includes station timeline.

## 9.3 Smoke Coverage

Add smoke for the new execution path (as requested):

1. `smoke:control-worker` remains.
2. Add `smoke:queue-consumer-worker`.
3. Add one pipeline smoke test that covers:
   - create repo
   - create run
   - wait/poll for terminal status
   - assert station records exist and are terminal

Root script recommendation:

1. `pnpm smoke` runs all smoke suites.

## 10. Manual QA Plan (API-First)

After `pnpm setup` and `pnpm dev`:

1. `POST /v1/repos` for `sociotechnica-org/lifebuild`.
2. `POST /v1/runs` with `Idempotency-Key`.
3. Poll `GET /v1/runs/:id` every 1-2s.
4. Verify progression:
   - initial: `queued`
   - then: `running`
   - terminal: `succeeded` (or `failed` with failure reason)
5. Verify station list contains all 5 stations with terminal statuses.
6. Retry original `POST /v1/runs` with same idempotency key and identical body:
   - no duplicate run
   - no duplicate execution

## 11. Acceptance Criteria

1. Queue messages trigger execution automatically through queue-consumer worker.
2. Each run transitions to terminal status without manual intervention.
3. Station execution rows are persisted and queryable from API.
4. Duplicate queue deliveries do not produce duplicate run execution.
5. Lint/typecheck/tests/smoke are green in CI.
6. Docs updated for local execution and QA commands.

## 12. Risks and Mitigations

1. Risk: queue at-least-once duplicates cause repeated execution.
   Mitigation: atomic `queued -> running` claim and deterministic workflow instance id.
2. Risk: state drift between run row and station rows.
   Mitigation: always update run + station in explicit order with failure-safe writes and logging.
3. Risk: local dev queue/workflow behavior differs from production.
   Mitigation: keep unit/integration deterministic and add one smoke path that exercises the local stack contract.

## 13. Handoff to PR4

PR4 can replace placeholder station internals with real execution while preserving PR3 orchestration contracts:

1. Plug `implement` and `verify` stations into Modal adapter + coderunner adapter.
2. Keep run/station persistence model unchanged.
3. Reuse PR3 smoke harness, extending assertions for real adapter outputs.

## 14. Discussion Questions

1. For run detail response, do you want `stations` embedded in `GET /v1/runs/:id`, or a separate endpoint for cleaner payloads?
2. On success, should `current_station` remain `create_pr` (last executed) or be cleared to `null`?
3. Do you want PR3 to include `POST /v1/runs/:id/cancel`, or keep that for PR4/PR5 after real long-running execution exists?
