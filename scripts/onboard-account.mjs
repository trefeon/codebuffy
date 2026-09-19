#!/usr/bin/env node
/**
 * onboard-account.mjs — enroll one CodeBuddy/WorkBuddy account into the gateway credential pool.
 *
 * Legal posture (research/08-account-onboarding-guide.md §1): registration is human-per-account;
 * this tool only automates OFFICIAL flows — the CLI plugin device-flow login, console validation,
 * console API-key management — and writes one pool file per account. No registration automation,
 * no SMS rental, no fingerprint spoofing.
 *
 * Zero dependencies; requires Node >= 22 (global fetch).
 * Endpoint/header/payload sources: research/02-auth-and-token-lifecycle.md §3.2, §5, §7.
 *
 * Usage:
 *   node scripts/onboard-account.mjs [options]
 * Options:
 *   --label <name>          friendly label stored in the pool file (default: "acc")
 *   --provision-key         also create a 365-day console API key (ck_) for this account
 *   --from-auth-file <path> skip login; import tokens from a desktop app auth file
 *   --pool-file <path>      operate on an existing pool file instead of logging in
 *   --verify                after enrollment, probe GET /v3/config and report health
 *   --api-base <url>        backend API plane   (default: https://copilot.tencent.com)
 *   --console-base <url>    web console host    (default: https://www.codebuddy.cn)
 *   --out-dir <dir>         pool directory      (default: data/pool)
 *
 * Restore an encrypted export bundle (POST /admin/credentials/export):
 *   node scripts/onboard-account.mjs import <bundle.json> [--out-dir <dir>]
 * Key comes from CODEBUFFY_ENCRYPTION_KEY (same formats as the gateway).
 */

import { spawn } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---- config ----------------------------------------------------------------

const API_BASE = opt("api-base") ?? "https://copilot.tencent.com";
const CONSOLE_BASE = opt("console-base") ?? "https://www.codebuddy.cn";
const OUT_DIR = opt("out-dir") ?? path.join("data", "pool");
const LABEL = opt("label") ?? "acc";
const PROVISION_KEY = flag("provision-key");
const VERIFY = flag("verify");
const AUTH_FILE = opt("from-auth-file");
const POOL_FILE = opt("pool-file");

const UA = `CLI/${process.env.CODEBUFFY_UPSTREAM_CLI_VERSION ?? "2.108.1"} CodeBuddy/${process.env.CODEBUFFY_UPSTREAM_CLIENT_VERSION ?? "2.108.1"}`; // client fingerprint (config keys: upstreamCliVersion/upstreamClientVersion)
const POLL_INTERVAL_MS = 2_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

function flag(name) { return process.argv.includes(`--${name}`); }
function opt(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ---- tiny http helpers ------------------------------------------------------

async function api(pathname, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: { "content-type": "application/json", "user-agent": UA, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: res.status, json, text };
}

/** Business envelope: { code: 0, data: … }. Non-zero codes are upstream errors. */
function unwrap(res, what) {
  if (res.json && typeof res.json.code === "number" && res.json.code !== 0) {
    fail(`${what}: business error code=${res.json.code} msg=${res.json.msg ?? "?"}`);
  }
  if (!res.json || res.json.data === undefined) {
    fail(`${what}: unexpected response (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
  }
  return res.json.data;
}

function bearerHeaders(at) {
  // Header catalog per doc 02 §4 / wb_genkey buildBearerHeaders (doc 02 §7).
  return {
    authorization: `Bearer ${at}`,
    "x-product": "SaaS",
    "x-client-platform": "web",
    "x-domain": new URL(CONSOLE_BASE).hostname,
  };
}

// ---- auth-file import (doc 02 §3.1) ----------------------------------------

const AUTH_FILE_CANDIDATES = [
  process.env.APPDATA && path.join(process.env.APPDATA, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"),
  process.env.HOME && path.join(process.env.HOME, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"),
].filter(Boolean);

function importAuthFile(explicitPath) {
  const p = explicitPath ?? AUTH_FILE_CANDIDATES.find((c) => fs.existsSync(c));
  if (!p) fail("no auth file found; pass --from-auth-file <path>");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const auth = raw.auth ?? raw.token_info ?? {};
  const account = raw.account ?? {};
  // camelCase and snake_case variants both occur (Tom6814 extract_token_from_auth_file).
  const at = auth.accessToken ?? auth.access_token;
  const rt = auth.refreshToken ?? auth.refresh_token;
  if (!at || !rt) fail(`auth file ${p} lacks accessToken/refreshToken`);
  const expMs = Number(auth.expiresAt ?? auth.expires_at ?? 0) || relToMs(auth.expiresIn);
  const rExpMs = Number(auth.refreshExpiresAt ?? auth.refresh_expires_at ?? 0) || relToMs(auth.refreshExpiresIn);
  return {
    accessToken: at, refreshToken: rt, tokenType: auth.tokenType ?? "Bearer",
    domain: auth.domain ?? new URL(CONSOLE_BASE).hostname,
    expiresAt: expMs, refreshExpiresAt: rExpMs,
    uid: account.uid ?? account.user_id, nickname: account.nickname,
    enterpriseId: account.enterpriseId ?? account.tenantId,
    source: `auth-file:${p}`,
  };
}

/** Responses carry absolute ms epoch or relative seconds — accept either (<1e11 ⇒ seconds). */
function relToMs(v) {
  const n = Number(v);
  if (!n) return 0;
  return n < 1e11 ? Date.now() + n * 1000 : n;
}

// ---- device flow login (doc 02 §3.2, from dsh codebuddy-auth.js) ------------

const ANON_HEADERS = {
  "x-no-authorization": "true", "x-no-user-id": "true",
  "x-no-enterprise-id": "true", "x-no-department-info": "true",
};

async function deviceFlowLogin() {
  say("requesting device-flow state…");
  const started = unwrap(
    await api("/v2/plugin/auth/state?platform=CLI", { method: "POST", headers: ANON_HEADERS, body: {} }),
    "auth/state");
  if (!started?.state || !started?.authUrl) fail(`auth/state missing fields: ${JSON.stringify(started).slice(0, 200)}`);
  say(`opening browser for login (state=${started.state.slice(0, 8)}…): ${started.authUrl}`);
  openBrowser(started.authUrl);

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const poll = await api(`/v2/plugin/auth/token?state=${encodeURIComponent(started.state)}`, { headers: ANON_HEADERS });
    if (poll.json?.code === 0 && poll.json.data) {
      const d = poll.json.data;
      return {
        accessToken: d.accessToken, refreshToken: d.refreshToken, tokenType: d.tokenType ?? "Bearer",
        domain: d.domain ?? new URL(CONSOLE_BASE).hostname,
        expiresAt: relToMs(d.expiresAt ?? d.expiresIn), refreshExpiresAt: relToMs(d.refreshExpiresAt ?? d.refreshExpiresIn),
        source: "device-flow",
      };
    }
  }
  fail("login timed out after 10 minutes");
}

async function resolveAccount(session) {
  // GET /v2/plugin/login/account?state=… needs the just-minted AT (doc 02 §3.2 step 4).
  // The state is gone by now in our simplified flow; fall back to console validation below.
  const who = await api("/console/accounts", { headers: bearerHeaders(session.accessToken) });
  if (who.status !== 200 || !who.json) {
    fail(`console validation failed (HTTP ${who.status}); login may not have bound an account`);
  }
  const scan = JSON.stringify(who.json);
  const uid = session.uid ?? matchKey(who.json, ["uid", "userId", "sub"]) ?? null;
  const enterpriseId = matchKey(who.json, ["enterpriseId", "tenantId"]);
  say(uid ? `bound account uid=${uid}` : "warning: could not locate uid in /console/accounts response");
  if (!uid) say(`raw response head: ${scan.slice(0, 300)}`);
  return { uid, enterpriseId, nickname: matchKey(who.json, ["nickname", "name"]) };
}

function matchKey(obj, keys, depth = 0) {
  if (depth > 4 || !obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = Object.entries(obj).find(([nk]) => nk.toLowerCase() === k.toLowerCase())?.[1];
    if (typeof v === "string" && v) return v;
  }
  for (const v of Object.values(obj)) {
    const hit = matchKey(v, keys, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

// ---- console API key provisioning (doc 02 §7, wb_genkey.js) -----------------

async function provisionConsoleKey(session, uid) {
  say("creating console API key (365 days)…");
  const created = unwrap(
    await api("/console/api/client/v1/api-keys", {
      method: "POST",
      headers: { ...bearerHeaders(session.accessToken), ...(uid ? { "x-user-id": uid } : {}) },
      body: {
        name: `codebuffy-${LABEL}-${Date.now().toString(36)}`,
        expire_in_days: 365,
        user_enterprise_id: session.enterpriseId ?? "personal-edition-user-id",
      },
    }),
    "api-keys create");
  const keyId = matchKey(created, ["keyId", "id"]);
  // Full value is returned exactly once; probe the known field spellings.
  let fullKey;
  for (const f of ["api_key", "apiKey", "secret_key", "secretKey", "secret", "key"]) {
    const v = created?.[f] ?? created?.data?.[f];
    if (typeof v === "string" && v.length > 8) { fullKey = v; break; }
  }
  if (!fullKey) fail(`could not locate full key in create response: ${JSON.stringify(created).slice(0, 300)}`);
  banner(`FULL KEY (shown once — store it now): ${fullKey}`);
  return { name: `codebuffy-${LABEL}`, keyId, fullKey };
}

// ---- verify (health probe; business-code taxonomy per doc 01 §2) -------------

async function verify(session) {
  say("verifying via GET /v3/config…");
  const headers = { ...bearerHeaders(session.accessToken) };
  if (session.apiKeyFull) headers["x-api-key"] = session.apiKeyFull;
  const cfg = await api("/v3/config", { headers });
  if (cfg.status === 200 && cfg.json) {
    const models = matchCount(cfg.json);
    say(`OK — models visible: ${models}`);
    return true;
  }
  const code = cfg.json?.code;
  const meaning =
    code === 11140 ? "ACCOUNT BANNED" :
    code === 14018 ? "quota exhausted" :
    code ? `business error ${code}` : `HTTP ${cfg.status}`;
  say(`NOT OK — ${meaning}`);
  return false;
}

function matchCount(json) {
  const arr = Array.isArray(json?.data) ? json.data : json?.data?.models ?? json?.models;
  return Array.isArray(arr) ? arr.length : "unknown";
}

// ---- pool persistence (atomic write; 0600 where honored) ---------------------

function writePoolFile(session, accountInfo, overrides = {}) {
  if (!accountInfo.uid) fail("cannot write pool file without a resolved uid");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const record = {
    version: 1,
    label: overrides.label ?? LABEL,
    domain: overrides.domain ?? new URL(CONSOLE_BASE).hostname,
    apiBase: overrides.apiBase ?? API_BASE,
    account: { uid: accountInfo.uid, enterpriseId: accountInfo.enterpriseId, nickname: accountInfo.nickname },
    auth: {
      accessToken: session.accessToken, refreshToken: session.refreshToken,
      tokenType: session.tokenType, domain: session.domain,
      expiresAt: session.expiresAt, refreshExpiresAt: session.refreshExpiresAt,
      capturedAt: Date.now(), source: session.source,
    },
    ...(session.apiKey ? { apiKey: session.apiKey } : {}),
  };
  const file = path.join(OUT_DIR, `${record.account.uid}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file); // atomic on same volume
  try { fs.chmodSync(file, 0o600); } catch { /* Windows: ACLs differ; dir is git-ignored */ }
  say(`pool file written: ${file} (fingerprint sha256:${createHash("sha256").update(record.account.uid).digest("hex").slice(0, 12)})`);
  return file;
}

// ---- cli plumbing --------------------------------------------------------------

function openBrowser(url) {
  const cmd = process.platform === "win32"
    ? spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" })
    : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" });
  cmd.unref();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(...a);
const banner = (msg) => console.log("\n".padEnd(60, "=") + `\n${msg}\n` + "".padEnd(60, "=") + "\n");
function fail(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }

async function main() {
  say(`codebuffy account onboarding — label="${LABEL}" api=${API_BASE}`);

  let session;
  let existingFile = null;
  if (POOL_FILE) {
    const rec = JSON.parse(fs.readFileSync(POOL_FILE, "utf8"));
    session = rec.auth;
    session.source = session.source ?? "pool-file";
    existingFile = POOL_FILE;
    say(`loaded existing pool file: ${POOL_FILE}`);
  } else if (AUTH_FILE || AUTH_FILE_CANDIDATES.some((c) => c && fs.existsSync(c)) && flag("prefer-auth-file")) {
    session = importAuthFile(AUTH_FILE);
    say(`imported credentials from auth file (${session.source})`);
  } else if (AUTH_FILE) {
    session = importAuthFile(AUTH_FILE);
    say(`imported credentials from auth file (${session.source})`);
  } else {
    session = await deviceFlowLogin();
  }

  say(`access token: ${mask(session.accessToken)} expiresAt=${session.expiresAt ? new Date(session.expiresAt).toISOString() : "unknown"}`);

  const accountInfo = session.uid
    ? { uid: session.uid, enterpriseId: session.enterpriseId, nickname: session.nickname }
    : await resolveAccount(session);

  if (PROVISION_KEY) session.apiKey = await provisionConsoleKey(session, accountInfo.uid);

  if (!existingFile) existingFile = writePoolFile(session, accountInfo);

  let healthy = null;
  if (VERIFY) healthy = await verify({ ...session, apiKeyFull: session.apiKey?.fullKey });

  banner([
    `DONE — label "${LABEL}"`,
    `pool file : ${existingFile}`,
    `api key   : ${session.apiKey ? `${mask(session.apiKey.fullKey)} (${session.apiKey.name})` : "not provisioned"}`,
    `verify    : ${healthy === null ? "skipped (--verify to run)" : healthy ? "HEALTHY" : "UNHEALTHY"}`,
  ].join("\n"));
}

// ---- bundle import (cred-backup export bundles) -------------------------------
// `import <bundle.json>` restores a version-1 export bundle into pool-dir files
// in the normalizePoolFile shape. Packets are AES-256-GCM; the key comes from
// CODEBUFFY_ENCRYPTION_KEY (hex 64 / base64 44 / raw 32-byte, same as the gateway).
// Fail-closed: version mismatch, undecryptable packet, or missing token fields
// abort with a non-zero exit — no partial/plaintext writes.

function parseEncryptionKey(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === "") return null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    try {
      const buf = Buffer.from(normalized, "base64");
      if (buf.length === 32) return buf;
    } catch {
      // fall through to the raw-string check below
    }
  }
  const buf = Buffer.from(trimmed, "utf8");
  if (buf.length === 32) return buf;
  fail("invalid CODEBUFFY_ENCRYPTION_KEY: expected 32 bytes as base64, hex, or a 32-byte string");
}

function decryptPacket(uid, packet, key) {
  const tagB64 = packet.tag ?? packet.authTag;
  if (typeof packet.iv !== "string" || typeof tagB64 !== "string" || typeof packet.ciphertext !== "string") {
    fail(`bundle entry "${uid}" has an invalid packet (need base64 iv/tag/ciphertext)`);
  }
  const iv = Buffer.from(packet.iv, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(packet.ciphertext, "base64");
  if (iv.length !== 12) fail(`bundle entry "${uid}" has an invalid iv (expected 12 bytes)`);
  if (tag.length !== 16) fail(`bundle entry "${uid}" has an invalid auth tag (expected 16 bytes)`);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    fail(`cannot decrypt bundle entry "${uid}" — wrong CODEBUFFY_ENCRYPTION_KEY?`);
  }
}

async function importBundle(bundlePath) {
  if (!bundlePath) fail("usage: onboard-account.mjs import <bundle.json> [--out-dir <dir>]");
  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  } catch (e) {
    fail(`cannot read bundle ${bundlePath}: ${e.message}`);
  }
  if (!bundle || typeof bundle !== "object" || bundle.version !== 1) {
    fail(`unsupported bundle version ${bundle?.version ?? "(missing)"}: expected version 1`);
  }
  if (!Array.isArray(bundle.credentials)) fail("invalid bundle: missing credentials array");
  const key = parseEncryptionKey(process.env.CODEBUFFY_ENCRYPTION_KEY);
  if (!key) fail("CODEBUFFY_ENCRYPTION_KEY is required to import an encrypted bundle");
  let imported = 0;
  for (const entry of bundle.credentials) {
    const uid = entry?.uid;
    if (typeof uid !== "string" || uid === "") fail("invalid bundle: entry without uid");
    if (!entry.packet || typeof entry.packet !== "object") fail(`bundle entry "${uid}" is missing its packet`);
    const plain = decryptPacket(uid, entry.packet, key);
    let cred;
    try {
      cred = JSON.parse(plain);
    } catch {
      fail(`bundle entry "${uid}" decrypted to invalid JSON`);
    }
    if (typeof cred?.auth?.accessToken !== "string" || cred.auth.accessToken === "") {
      fail(`bundle entry "${uid}": missing required field accessToken`);
    }
    if (typeof cred?.auth?.refreshToken !== "string" || cred.auth.refreshToken === "") {
      fail(`bundle entry "${uid}": missing required field refreshToken`);
    }
    writePoolFile(
      { ...cred.auth, ...(cred.apiKey ? { apiKey: cred.apiKey } : {}) },
      { uid, enterpriseId: cred.enterpriseId, nickname: cred.nickname },
      { label: entry.label, domain: entry.domain, apiBase: entry.apiBase },
    );
    imported++;
  }
  say(`imported ${imported} credential(s) to ${OUT_DIR}`);
}

function mask(secret) {
  return secret ? `${secret.slice(0, 12)}…(${secret.length} chars)` : "(none)";
}

if (process.argv[2] === "import") {
  importBundle(process.argv[3]).catch((e) => fail(e.stack ?? String(e)));
} else {
  main().catch((e) => fail(e.stack ?? String(e)));
}
