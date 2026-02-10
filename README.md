# bob-the-builder

`bob-the-builder` is a Cloudflare-first software factory that turns GitHub issues into pull requests.

## Intent

This repository is the standalone platform infrastructure for automated engineering execution across `sociotechnica-org` repos.

v0 is intentionally narrow:

- Auth to GitHub uses a PAT (`GITHUB_TOKEN`)
- Target repo is `sociotechnica-org/lifebuild` only
- Orchestration uses Cloudflare Agents + Workflows + Queues
- Implementation and verification run in Modal VMs
- Storage is SQLite-based (Cloudflare D1 and/or Durable Object SQLite)
- Web UI is Vite + React

## MVP Outcome

The first working version should:

1. Accept a GitHub issue reference.
2. Queue and orchestrate a run.
3. Execute implementation in a Modal VM using Claude Code.
4. Run repository verification commands.
5. Push a branch and open a draft or ready PR.
6. Expose run status, station progress, and logs.

## Planned Structure

```text
bob-the-builder/
  apps/
    control-worker/
    queue-consumer-worker/
    web/
  packages/
    core/
    config/
    adapters-github/
    adapters-modal/
    adapters-coderunner/
    observability/
    security/
  infra/
    wrangler/
  docs/
    plans/
```

## Docs

- Bootstrap plan: `docs/plans/001-bootstrap-v0/001-bootstrap-v0.md`
- PR1 implementation plan: `docs/plans/001-bootstrap-v0/pr1-implementation-plan.md`
- Architecture: `docs/architecture.md`

## PR1 Bootstrap Status

PR1 establishes the base monorepo scaffolding and a minimal Cloudflare worker slice:

- Workspace/tooling baseline (TypeScript, ESLint, Prettier, Vitest, Playwright, PNPM)
- `packages/core` run/station domain contracts
- `packages/security` shared password gate helpers
- `apps/control-worker` with `/healthz` and protected `/v1/ping`
- `apps/queue-consumer-worker` scaffold for future queue orchestration
- `apps/web` Vite + React placeholder app

## Getting Started

```bash
pnpm install
pnpm lint-all
pnpm test
```

Run the control worker locally:

```bash
pnpm --filter @bob/control-worker dev
```

In another shell, probe endpoints:

```bash
curl -i http://127.0.0.1:8787/healthz
curl -i http://127.0.0.1:8787/v1/ping
curl -i -H \"Authorization: Bearer $BOB_PASSWORD\" http://127.0.0.1:8787/v1/ping
```

Run an automated local Vitest integration smoke test for the control worker:

```bash
pnpm smoke:control-worker
```
