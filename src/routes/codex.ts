import { Hono } from "hono";
import type { Config } from "../config";
import type { Logger } from "../logger";
import type { Pool } from "../pool/types";
import type { UpstreamClient } from "../upstream/client";
import type { Credential } from "../credentials/types";
import { mountResponsesRoutes } from "./responses";
import { mountOpenAIRoutes } from "./openai";

export interface CodexDeps {
 config: Config;
 logger: Logger;
 pool: Pool;
 upstream: UpstreamClient;
 /** Live-token recovery — forwarded to the reused route mounts. */
 refresh?: { refreshNow(uid: string): Promise<Credential> };
}

/**
 * Codex CLI wire protocol: the Responses API under a path prefix.
 *
 * Evidence (see commit message for full citations):
 * - 9router `next.config.mjs`: `source: "/codex/:path*"` rewrites to
 *   `destination: "/api/v1/responses"` — every /codex/* hit lands on the
 *   Responses handler regardless of subpath.
 * - 9router codex-settings route writes `wire_api = "responses"` with
 *   `base_url = <endpoint>/v1` into `~/.codex/config.toml`, and its
 *   CodexExecutor is documented as "handles OpenAI Codex API
 *   (Responses API format)".
 *
 * So this module adds NO new parser/emitter — it reuses the existing
 * responses + models handlers verbatim. The existing mounts register
 * absolute `/v1/*` paths, so they are mounted on a private inner Hono
 * (no global middleware => no double auth/metrics) and the two Codex
 * entrypoints re-dispatch with only the pathname rewritten; method,
 * headers (incl. Authorization and any Codex UA), query, body, and the
 * abort signal pass through untouched.
 */
export function mountCodexRoutes(app: Hono, deps: CodexDeps): void {
 const inner = new Hono();
 mountResponsesRoutes(inner, deps);
 // Only GET /v1/models[/:id] is reachable from the aliases below; the
 // co-mounted POST /v1/chat/completions stays unreachable on `inner`.
 mountOpenAIRoutes(inner, deps);

 app.post("/codex/responses", (c) => inner.request(rewritePath(c.req.raw, "/v1/responses")));
 app.get("/codex/models", (c) => inner.request(rewritePath(c.req.raw, "/v1/models")));
}

function rewritePath(req: Request, pathname: string): Request {
 const url = new URL(req.url);
 url.pathname = pathname;
 const init: RequestInit & { duplex?: "half" } = {
  method: req.method,
  headers: req.headers,
  signal: req.signal,
 };
 if (req.body !== null) {
  init.body = req.body;
  init.duplex = "half";
 }
 return new Request(url.toString(), init);
}
