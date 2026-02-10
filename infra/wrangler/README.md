# Wrangler Notes

This folder documents shared Wrangler conventions for `bob-the-builder` worker apps.

## PR1 Baseline

All worker configs should use `wrangler.jsonc` with:

- `compatibility_date`: `2025-03-07`
- `compatibility_flags`: `["nodejs_compat"]`
- `observability.enabled`: `true`
- `observability.head_sampling_rate`: `1`

## Local Development

Each worker app can use `.dev.vars` locally. Do not commit secrets.

Expected v0 secret variables:

- `BOB_PASSWORD`
- `GITHUB_TOKEN`
- `MODAL_TOKEN_ID`
- `MODAL_TOKEN_SECRET`
- `CLAUDE_CODE_API_KEY`
