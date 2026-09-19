# codebuffy

A production-grade **CodeBuddy-to-API gateway** — exposing Tencent CodeBuddy / WorkBuddy upstream models through standard OpenAI / Anthropic / Responses-compatible endpoints.

Stack: **TypeScript + Bun 1.3 + Hono**. Version **0.1.0**.

## Quick start

```bash
bun install          # Bun >= 1.3.14 (see .bun-version)
bun run dev          # http://127.0.0.1:3000
bun run test         # scoped suite via scripts/run-tests.mjs (never bare `bun test`: repo-wide discovery sweeps vendored reference/ suites)
docker compose up --build   # containerized
```

## Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | Entrypoint: config → logger → store → pool → upstream → scheduler → app → `Bun.serve` → shutdown hooks |
| `src/app.ts` | `createApp(deps)` Hono factory; metrics, health, admin plane + static UI, `/v1/*` dialects |
| `src/config.ts` | Layered zod-validated config (defaults < config.json < `CODEBUFFY_*` env, 21 keys) |
| `src/adapters/` | Dialects, IR-mediated: `openai-chat/`, `anthropic/`, `responses/` (parser/emitter) |
| `src/routes/` | `openai.ts`, `anthropic.ts`, `responses.ts`, `codex.ts` (Responses alias), `metrics.ts` |
| `src/ir/` | Canonical IR (`types.ts`, `ensure-leading-system.ts`) |
| `src/pool/` | Selection + hardening (`round-robin.ts`, `state.ts`, `affinity.ts`, `breaker.ts`, `types.ts`) |
| `src/upstream/` | CodeBuddy client (`client.ts`, `headers.ts`, `errors.ts`, `types.ts`, `sanitize.ts`, `chunk-sanitize.ts`, `usage-quota.ts`) |
| `src/credentials/` | Store + refresh + login + export (`store.ts`, `crypto.ts`, `refresh.ts`, `device-flow.ts`, `file-importer.ts`, `watcher.ts`, `export.ts`, `types.ts`) |
| `src/models/` | Model catalog (`catalog.ts` + `catalog.generated.json`, cn/intl sites) |
| `src/admin/` | Admin API (`routes.ts`, `auth.ts`) + static UI (`ui/index.html`, `ui/app.js`, `ui/style.css`, `ui/pages/*.js`) |
| `src/checkin/` | Opt-in daily credit claim (`scheduler.ts`, `client.ts`, `types.ts`) |
| `src/observability/` | Prometheus (`metrics.ts`, `middleware.ts`), request usage log (`usage.ts`), OTel spans (`tracing.ts`, no-op without endpoint) |
| `src/middleware/` | `downstream-auth.ts`, `admin-auth.ts` |
| `src/logger.ts`, `src/shutdown.ts` | pino factory with secret redaction; SIGINT/SIGTERM handling |
| `test/` | `bun:test` suites — 640 tests across 32 files (run via `bun run test`) |
| `scripts/` | Operator tooling (`onboard-account.mjs`, `run-tests.mjs`) |

Configuration is layered `defaults < config.json < env (CODEBUFFY_*)`; 21 keys (`src/config.ts:79-101`): `CODEBUFFY_PORT`, `CODEBUFFY_HOST`, `CODEBUFFY_LOG_LEVEL`, `CODEBUFFY_API_BASE`, `CODEBUFFY_CONSOLE_BASE`, `CODEBUFFY_DB_PATH`, `CODEBUFFY_UPSTREAM_TIMEOUT_MS`, `CODEBUFFY_API_KEYS`, `CODEBUFFY_POOL_COOLDOWN_MS`, `CODEBUFFY_BREAKER_THRESHOLD`, `CODEBUFFY_BREAKER_RESET_MS`, `CODEBUFFY_CACHE_AFFINITY_TTL_MS`, `CODEBUFFY_METRICS_ENABLED`, `CODEBUFFY_ADMIN_ENABLED`, `CODEBUFFY_ADMIN_KEYS`, `CODEBUFFY_CHECKIN_ENABLED`, `CODEBUFFY_CHECKIN_JITTER_MS`, `CODEBUFFY_ENCRYPTION_KEY`, `CODEBUFFY_UPSTREAM_CLI_VERSION`, `CODEBUFFY_UPSTREAM_CLIENT_VERSION`, `CODEBUFFY_INTL_PLATFORM`.

## Status

M5-core + post-core complete and verified (typecheck + lint + `bun run test` green: 640 tests / 32 files). Shipped: OpenAI Chat, Anthropic Messages, and Responses dialects; hardened pool (state machine, cache affinity, circuit breaker); encrypted SQLite credential store (AES-256-GCM); device-flow login (`POST /admin/credentials/device-flow/start|poll`) + encrypted export (`POST /admin/credentials/export`, onboard `import`); Codex alias (`POST /codex/responses`, `GET /codex/models`); admin API + static UI (`GET /admin/`, usage/quota pages); Prometheus `/metrics` + deep `/readyz`; opt-in daily check-in (`CODEBUFFY_CHECKIN_ENABLED`, default off). Remaining: WebAuthn/passkey real impl (endpoint is a 501 stub).

> `reference/`, `research/`, and `devdocs/` are private working directories (git-ignored): prior-art clones, the full reverse-engineering study, and development-process docs. They are intentionally not part of this repository.
