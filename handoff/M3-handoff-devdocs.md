# M3 Handoff — devdocs/ drift (git-ignored, local-only)

`devdocs/` is `.gitignore:/devdocs/` (private, user decision 2026-08-25) so `main @ 2427616` does not carry these fixes. This workstation (D:/github_repo/codebuffy) has the corrected files. Next clone will revert to stale M1 view unless you apply this artifact.

## How to apply
```bash
# from repo root
mkdir -p devdocs
# overwrite both files with snapshots below, or apply the patches
cat handoff/M3-handoff-devdocs.md  # this file contains snapshots
# alternatively:
git show HEAD:devdocs/architecture.md 2>/dev/null || echo "(not tracked)"
# just copy sections below into devdocs/architecture.md and devdocs/dev-runbook.md
```

## Snapshot: devdocs/architecture.md (M0–M3)
> Full current file (10933 bytes, heading ## M0–M3 — what exists today). Copy verbatim to devdocs/architecture.md

```markdown
# Architecture

## M0–M3 — what exists today

```
codebuffy/
├── src/
│   ├── index.ts            # entrypoint: config -> logger -> SqliteCredentialStore(bun:sqlite WAL) + importPoolDir -> RefreshService -> RoundRobinPool -> UpstreamClient (fingerprint headers) -> app -> Bun.serve -> shutdown hooks
│   ├── app.ts              # createApp(deps) Hono factory; /healthz, /readyz, error envelope; mounts OpenAI + Anthropic routes behind downstreamAuth when pool+upstream present
│   ├── config.ts           # layered zod-validated config (defaults < config.json < CODEBUFFY_* env)
│   │                       # now also: dbPath, upstreamTimeoutMs, downstreamApiKeys
│   ├── logger.ts           # pino factory with secret redaction paths
│   ├── shutdown.ts         # SIGINT/SIGTERM -> server.stop(true), 10s force-exit, idempotent
│   ├── ir/                 # ← M2
│   │   └── types.ts        # IRMessage/IRRequest, ParseError, parseIRRequest, toUpstreamRequest (PASSTHROUGH_KEYS)
│   ├── pool/               # ← M2/M3
│   │   ├── round-robin.ts  # RoundRobinPool single-flight refresh via RefreshService.ensureFresh
│   │   └── types.ts        # Pool interface (pick, size)
│   ├── middleware/         # ← M2
│   │   └── downstream-auth.ts # downstreamAuth gate: timingSafeEqual, open mode when no keys
│   ├── adapters/
│   │   ├── openai-chat/    # ← M2
│   │   │   ├── parser.ts   # parseOpenAIChatRequest (validation, content array join, tool_calls)
│   │   │   ├── emitter.ts  # OpenAI SSE formatting
│   │   │   └── aggregator.ts # aggregateStream (non-streaming via streaming)
│   │   └── anthropic/      # ← M3
│   │       ├── parser.ts   # parseAnthropicRequest (system→IR, tool_result/tool_use, thinking/redacted dropped, stop_sequences, tool_choice any→required, images dropped)
│   │       └── emitter.ts  # buildAnthropicResponse + anthropicSSEFromUpstream (message_start/content_block_*/message_delta/message_stop)
│   ├── routes/             # ← M2/M3
│   │   ├── openai.ts       # mountOpenAIRoutes: POST /v1/chat/completions (stream vs aggregate), GET /v1/models + /v1/models/:id
│   │   └── anthropic.ts    # mountAnthropicRoutes: POST /v1/messages (stream SSE vs aggregate), POST /v1/messages/count_tokens (naive estimate)
│   ├── upstream/           # ← M1
│   │   ├── types.ts        # UpstreamChatRequest, UpstreamChunk, PASSTHROUGH_KEYS
│   │   ├── errors.ts       # UpstreamError, RETRYABLE_CODES, isRetryable
│   │   ├── headers.ts      # buildUpstreamHeaders (fingerprint canon)
│   │   └── client.ts       # UpstreamClient.streamChat + fetchModels, SSE parser, abort/timeout, cancellation propagation
│   └── credentials/        # ← M1
│       ├── types.ts        # Credential, isExpiring, normalizePoolFile
│       ├── store.ts        # SqliteCredentialStore (bun:sqlite, WAL, expires_at index)
│       ├── file-importer.ts# importPoolDir(poolDir) -> imported/skipped
│       ├── refresh.ts      # RefreshService (single-flight Map, skew 5m, fallback, bound-uid check)
│       └── watcher.ts      # watchAuthFile polling helper
├── test/                   # bun:test suites — 212 tests across 11 files
│   ├── config.test.ts
│   ├── health.test.ts
│   ├── credentials.test.ts
│   ├── upstream.test.ts
│   ├── refresh.test.ts
│   ├── ir.test.ts
│   ├── openai-chat.test.ts
│   ├── pool.test.ts
│   ├── anthropic-parser.test.ts
│   ├── routes-openai.test.ts
│   └── routes-anthropic.test.ts
├── scripts/                # operator tooling (onboard-account.mjs)
├── Dockerfile              # single-stage oven/bun:1.3-alpine, non-root, HEALTHCHECK /healthz
├── compose.yaml            # gateway service, 3000:3000, ./data volume
└── .github/workflows/ci.yml
```

### Request flow (M3)

```
client ──HTTP──> Bun.serve(fetch: app.fetch)
                     │
                     ├─ GET /healthz → { status, uptimeSeconds, version }
                     ├─ GET /readyz  → { status, checks { config, pool, upstream } }
                     │                  # config true if validated at startup
                     │                  # pool true if pool.size() > 0
                     │                  # upstream true if UpstreamClient present
                     ├─ /v1/* ── downstreamAuth ──────────────────────────────┐
                     │         (only when pool+upstream present;              │
                     │          timingSafeEqual; open mode when no keys)      │
                     │         ├─ POST /v1/chat/completions ─┬─ stream:true  → pool.pick → upstream.streamChat(req, cred, signal) → SSE (openai emitter)
                     │         │                              └─ stream:false → pool.pick → upstream.streamChat(req, cred, signal) → aggregateStream → JSON
                     │         ├─ GET  /v1/models (+ /v1/models/:id) → pool.pick → upstream.fetchModels(cred) → normalized { data:[{id,object,created,owned_by}] }
                     │         ├─ POST /v1/messages ─┬─ stream:true  → pool.pick → upstream.streamChat(req, cred, signal) → anthropicSSEFromUpstream (message_start/content_block_start/content_block_delta/content_block_stop/message_delta/message_stop)
                     │         │                      └─ stream:false → pool.pick → upstream.streamChat(req, cred, signal) → aggregateStream → buildAnthropicResponse → JSON
                     │         └─ POST /v1/messages/count_tokens → naive token estimate (no upstream call; sums text lengths)
                     ├─ other route  → 404 { error:{ code:"NOT_FOUND" } }
                     └─ throw        → onError → log full, respond 500 {error:{code:"INTERNAL"}}
```

`AbortSignal` for `upstream.streamChat` is extracted from the raw Hono request (`(c.req as unknown as {raw?:Request}).raw?.signal ?? (c.req as unknown as {signal?:AbortSignal}).signal`) for end-to-end cancellation client→upstream.

Exit path: `SIGINT/SIGTERM` → `registerShutdown` (`src/shutdown.ts`) → `server.stop(true)` → exit 0; timeout forces exit 1.

### M2–M3 — what shipped since M1

**M2 — IR + OpenAI Chat end-to-end:**
- `ir/types.ts`: canonical `IRMessage`/`IRRequest`, `ParseError`, `parseIRRequest`/`toUpstreamRequest` (content array join, `tool_calls` passthrough, `PASSTHROUGH_KEYS` filtering).
- `adapters/openai-chat/parser.ts`: strict validation, content array normalization, `tool_calls` support.
- `adapters/openai-chat/aggregator.ts`: `aggregateStream` for non-streaming via streaming chunks.
- `adapters/openai-chat/emitter.ts`: OpenAI SSE formatting.
- `routes/openai.ts`: `POST /v1/chat/completions` (stream vs aggregate via `upstream.streamChat` with `AbortSignal`), `GET /v1/models` + `/v1/models/:id` (via `upstream.fetchModels`).
- `middleware/downstream-auth.ts`: downstream API-key gate with `timingSafeEqual`; open mode when `downstreamApiKeys` is empty.
- `pool/round-robin.ts`: `RoundRobinPool` active pool — round-robin `pick()` with single-flight `RefreshService.ensureFresh` per credential.
- Wiring: `src/index.ts` now constructs `SqliteCredentialStore(bun:sqlite WAL)` → `importPoolDir("data/pool")` → `RefreshService` → `RoundRobinPool` → `UpstreamClient` (config fingerprint headers); `src/app.ts` mounts `/v1/*` behind `downstreamAuth` when `pool+upstream` present.

**M3 — Anthropic Messages spec-exact:**
- `adapters/anthropic/parser.ts`: `parseAnthropicRequest` spec-exact — `system` string/array → IR system message, `tool_result`/`tool_use` blocks, `thinking`/`redacted_thinking` handling, `stop_sequences` → `stop`, `tool_choice` `any`→`required` mapping, image blocks dropped gracefully.
- `adapters/anthropic/emitter.ts`: SSE `message_start`/`content_block_start`/`content_block_delta`/`content_block_stop`/`message_delta`/`message_stop` via `anthropicSSEFromUpstream`; non-stream `buildAnthropicResponse` (aggregated content + tool_calls → Anthropic content blocks, usage mapping).
- `routes/anthropic.ts`: `POST /v1/messages` (stream SSE vs aggregate), `POST /v1/messages/count_tokens` (naive estimate, no upstream call), `AbortSignal` propagation matching OpenAI route.
- Pool wiring remains `RoundRobinPool` — per-request `pool.pick()` → `upstream.streamChat` with cancellation. Full state machine / cooldown / circuit breaker deferred to M5.

Upstream + credentials are now fully wired via `src/index.ts` (`SqliteCredentialStore` + `file-importer` + `RefreshService` + `RoundRobinPool` + `UpstreamClient`) awaiting pool pick per request — no remaining "not yet wired" gap from M1.

## Target architecture — remaining FUTURE

Distilled from `../research/07-gaps-and-blueprint.md` §5. Remaining milestones build these:


| Module | Responsibility | Milestone | Status |
|---|---|---|---|
| `upstream/` | single CodeBuddy client; streaming-only; config-driven fingerprint headers; cancellation propagation | M1 | ✅ Done |
| `credentials/` | auth-file watcher + device-flow login + single-flight refresh + CAS persist; SQLite store | M1 | ✅ Done |
| `ir/` | canonical intermediate representation for conversations/tools/usage — all conversions pass through it | M2 | ✅ Done M2 |
| `adapters/openai-chat` | inbound OpenAI Chat parse → IR; IR → SSE emit; non-streaming via aggregation | M2 | ✅ Done M2 |
| `adapters/anthropic` | inbound Anthropic Messages parse → IR; IR → Anthropic SSE / JSON emit | M3 | ✅ Done M3 |
| `adapters/responses` | Responses API dialect (future) | M4 | 🔜 Future |
| `pool/` | active pool (RoundRobinPool + single-flight refresh) — full state machine (active/cooldown/banned/quota), cache-affinity selection, retry ladder + circuit breaker deferred | M2/M3 (active) + M5 (full) | ✅ Done M2/M3 (partial) — state machine/cooldown/circuit breaker → M5 |
| `admin/` | authenticated admin API/UI (passkeys); never default passwords; binds loopback by default | M5 | 🔜 Future |
| `checkin/` | opt-in daily credit claim per account via direct billing API | M5 | 🔜 Future |
| `observability/` | OTel traces, Prometheus `/metrics`, deep `/readyz` | M5 | 🔜 Future |

Hard rules carried from the gap analysis: providers self-register (no switch-based wiring); conversion always IR-mediated (no pairwise converters); end-to-end cancellation client→upstream; no moderation-bypass steganography.
```

## Snapshot: devdocs/dev-runbook.md (env table)
> Copy this section into devdocs/dev-runbook.md ## Environment variables

```markdown
## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `CODEBUFFY_PORT` | `3000` | listen port |
| `CODEBUFFY_HOST` | `127.0.0.1` | bind address (use `0.0.0.0` only inside containers) |
| `CODEBUFFY_LOG_LEVEL` | `info` | fatal·error·warn·info·debug·trace·silent |
| `CODEBUFFY_API_BASE` | `https://copilot.tencent.com` | upstream API plane |
| `CODEBUFFY_CONSOLE_BASE` | `https://www.codebuddy.cn` | web console host |
| `CODEBUFFY_DB_PATH` | `data/codebuffy.db` | SQLite store path (WAL, expires_at index) — via config.dbPath |
| `CODEBUFFY_UPSTREAM_TIMEOUT_MS` | `30000` | upstream fetch timeout ms (1000–120000) — via config.upstreamTimeoutMs |
| `CODEBUFFY_API_KEYS` | *(empty — open mode)* | downstream auth allowlist, comma-split, each ≥8 chars (string\|array) — via config.downstreamApiKeys; when empty any client allowed, otherwise `Authorization: Bearer <key>` with timingSafeEqual |

Optional `config.json` at repo root holds the same keys; precedence `defaults < config.json < env` (ADR [0003](decisions/0003-config-layering.md)). `config.json` is git-ignored — never commit machine-specific or sensitive values.
```

## Verification (M3 @ 2427616)
- `bun run typecheck` → 0
- `bunx eslint .` → 0 (after fixing `consistent-type-imports` inline + `_cred` unused)
- `bun test test/` → 212 pass (up from 131)
- smoke `Bun.serve` mock: `/healthz` 200, `/readyz` {config,pool,upstream true}, `POST /v1/chat/completions` ns+stream, `POST /v1/messages` ns+stream all 200 (captured 2026-08-25)
- G5: `src/routes/openai.ts:111` + `anthropic.ts:127` pass `AbortSignal` to `upstream.streamChat`; pool retry/breaker deferred to M5 (intentional)
- `data/` gitignored, no secrets in tree
```

