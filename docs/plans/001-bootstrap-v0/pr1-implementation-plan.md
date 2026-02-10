# PR1 Detailed Implementation Plan

Status: Ready  
Date: 2026-02-10  
Parent Plan: `docs/plans/001-bootstrap-v0/001-bootstrap-v0.md`

## 1. PR1 Objective

Deliver the first mergeable vertical slice that establishes:

1. Monorepo and tooling foundations.
2. Shared domain/security packages.
3. Minimal Cloudflare control worker with health and password-gated route.
4. Baseline docs and scripts that unblock PR2 (D1 + queue producer).

## 2. PR1 Scope

### In Scope

1. Workspace scaffolding for `apps/*`, `packages/*`, `infra/*`.
2. TypeScript + ESLint + Prettier + Vitest + Playwright baseline.
3. `packages/core` domain contracts for run/station lifecycle.
4. `packages/security` password middleware/helpers for Worker APIs.
5. `apps/control-worker` with:
   - `GET /healthz` (public)
   - one protected route skeleton under `/v1/*`
6. Wrangler config baseline for Cloudflare Workers.
7. Basic tests for core and security packages.

### Out of Scope

1. D1 schema and CRUD endpoints (`repos`, `runs`) beyond stubs.
2. Queue producer/consumer behavior.
3. Workflow orchestration logic.
4. Modal and GitHub adapter implementation.
5. Full web dashboard implementation.

## 3. Cloudflare-First Decisions for PR1

1. Worker runtime uses ES modules and TypeScript.
2. `wrangler.jsonc` is used (not TOML).
3. Worker config defaults:
   - `compatibility_date: "2025-03-07"`
   - `compatibility_flags: ["nodejs_compat"]`
   - `observability.enabled: true`
   - `observability.head_sampling_rate: 1`
4. Keep bindings minimal in PR1; only add what code currently uses.
5. Security middleware runs in worker request path and is reused across future worker apps.

## 4. Deliverables

1. Root workspace/tooling files:
   - `package.json`
   - `pnpm-workspace.yaml`
   - `tsconfig.base.json`
   - `.editorconfig`
   - `.gitignore` (if needed updates)
   - `eslint.config.*`
   - `.prettierrc*`
2. Application scaffolds:
   - `apps/control-worker`
   - `apps/queue-consumer-worker` (stub only)
   - `apps/web` (placeholder scaffold only)
3. Shared packages:
   - `packages/core`
   - `packages/security`
4. Infra:
   - `infra/wrangler/` docs or environment notes for local/prod Wrangler usage.
5. Tests:
   - unit tests for core status machine/constants
   - unit tests for security auth parsing and gate behavior
6. Documentation updates:
   - README setup and command section
   - architecture references updated if contracts change

## 5. Detailed Work Breakdown

## 5.1 Repository Scaffolding

1. Create workspace directories and package manifests.
2. Add root scripts:
   - `lint`
   - `typecheck`
   - `test`
   - `test:e2e` (placeholder command)
3. Ensure scripts can target all workspaces consistently via PNPM filters.

## 5.2 Tooling Baseline

1. TypeScript project references or shared base config.
2. ESLint config for TS and Worker contexts.
3. Prettier config and ignore rules.
4. Vitest setup for packages.
5. Playwright bootstrap (minimal config, no heavy tests yet).

## 5.3 `packages/core`

1. Define canonical domain types:
   - `RunStatus`
   - `StationName`
   - `StationExecutionStatus`
   - `PrMode`
2. Export run/station transition helpers with strict typing.
3. Add tests for valid/invalid transitions and status guards.

## 5.4 `packages/security`

1. Implement password verification utilities:
   - parse `Authorization: Bearer <password>`
   - optional signed-cookie check helper for web usage
2. Provide framework-agnostic worker middleware helper:
   - `requirePassword(request, env)` style contract
3. Return standardized unauthorized responses.
4. Add unit tests for:
   - missing token
   - wrong token
   - correct token
   - malformed auth header

## 5.5 `apps/control-worker`

1. Build minimal worker entrypoint.
2. Expose:
   - `GET /healthz` (no auth)
   - `GET /v1/ping` (auth required) for middleware proof
3. Use `packages/security` for auth gate.
4. Add basic request logging contract (simple structured logs).
5. Add local dev script using Wrangler.

## 5.6 `apps/queue-consumer-worker` (Scaffold)

1. Add worker entrypoint with noop queue handler and health route.
2. Add Wrangler config stub without unused bindings.
3. Keep package ready for PR3 queue consumer logic.

## 5.7 `apps/web` (Placeholder)

1. Create minimal Vite + React shell with placeholder page.
2. Document that dashboard implementation is PR6 scope.

## 5.8 Infra and Config Hygiene

1. Add per-worker `wrangler.jsonc` files with PR1-safe defaults.
2. Document expected env vars and local `.dev.vars` usage (without secrets).
3. Ensure no credentials are committed.

## 6. Expected File Layout After PR1

```text
bob-the-builder/
  apps/
    control-worker/
      src/
      wrangler.jsonc
      package.json
    queue-consumer-worker/
      src/
      wrangler.jsonc
      package.json
    web/
      src/
      package.json
  packages/
    core/
      src/
      test/
      package.json
    security/
      src/
      test/
      package.json
  infra/
    wrangler/
      README.md
  docs/
    plans/
      001-bootstrap-v0/
        001-bootstrap-v0.md
        pr1-implementation-plan.md
```

## 7. Verification Plan (PR1)

Run and pass:

1. `pnpm install`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm --filter @bob/control-worker dev` starts and serves `/healthz`.

Manual checks:

1. `GET /healthz` returns success without auth.
2. `GET /v1/ping` returns `401` without auth.
3. `GET /v1/ping` returns success with `Authorization: Bearer <BOB_PASSWORD>`.

## 8. PR1 Acceptance Criteria

1. Monorepo skeleton exists and installs via PNPM.
2. Core and security packages compile and have passing unit tests.
3. Control worker routes and password gate behavior work locally.
4. Wrangler configs follow Cloudflare baseline defaults.
5. No production-only bindings are declared prematurely.
6. Docs reflect actual scaffold and commands.

## 9. Risks and Mitigations

1. Risk: over-building infrastructure before first vertical slice.  
   Mitigation: keep PR1 to minimal health + auth + contracts.
2. Risk: future worker package drift in tooling.  
   Mitigation: centralize shared TS/ESLint/Prettier config.
3. Risk: unclear auth contract for API vs web.  
   Mitigation: document bearer behavior now and cookie path as planned extension.

## 10. Handoff to PR2

After PR1 merge, PR2 should directly add:

1. D1 migrations/tables for `repos`, `runs`, `station_executions`, `artifacts`.
2. Real `POST /v1/repos` and `POST /v1/runs`.
3. Queue producer wiring from control worker.
