# codebuffy

A production-grade **CodeBuddy-to-API gateway** — exposing Tencent CodeBuddy / WorkBuddy upstream models through standard OpenAI / Anthropic / Responses-compatible endpoints.

Stack: **TypeScript + Bun 1.3 + Hono**.

## Quick start

```bash
bun install          # Bun >= 1.3.14 (see .bun-version)
bun run dev          # http://127.0.0.1:3000
bun test test/       # test suite
docker compose up --build   # containerized
```

## Layout

| Path | Purpose |
|---|---|
| `src/` | Gateway implementation (`src/index.ts` entrypoint, `createApp` factory) |
| `test/` | `bun:test` suites |
| `scripts/` | Operator tooling (e.g. `onboard-account.mjs`) |

Configuration is layered `defaults < config.json < env (CODEBUFFY_*)`; keys: `PORT`, `HOST`, `LOG_LEVEL`, `API_BASE`, `CONSOLE_BASE`.

## Status

M0 skeleton complete and verified (typecheck + lint + tests green; `/healthz`, `/readyz`, JSON error envelope smoke-tested). Next milestone M1: upstream client + credential manager.

> `reference/`, `research/`, and `devdocs/` are private working directories (git-ignored): prior-art clones, the full reverse-engineering study, and development-process docs. They are intentionally not part of this repository.
