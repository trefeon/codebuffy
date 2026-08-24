export interface Credential {
  uid: string;
  label?: string;
  domain: string;
  apiBase: string;
  consoleBase: string;
  enterpriseId?: string;
  nickname?: string;
  auth: {
    accessToken: string;
    refreshToken: string;
    tokenType: string;
    expiresAt: number;
    refreshExpiresAt: number;
    capturedAt: number;
    source: string;
  };
  apiKey?: { name: string; keyId?: string; fullKey: string };
}

/**
 * Returns true when the credential's access token is considered expiring
 * within `skewMs` (defaults to 5 minutes). The comparison is
 * `expiresAt <= now + skewMs`.
 */
export function isExpiring(credential: Credential, skewMs = 5 * 60 * 1000): boolean {
  return credential.auth.expiresAt <= Date.now() + skewMs;
}

/**
 * Normalizes a raw pool/auth-file/DB shape into a canonical `Credential`.
 *
 * Accepts both camelCase and snake_case spellings and both absolute
 * (`expiresAt` / `expires_at` in ms, optionally in seconds epoch) and
 * relative (`expiresIn` / `expires_in` in seconds) expiry encodings.
 *
 * Sources handled:
 *  - `scripts/onboard-account.mjs` pool file `{ account, auth, label, domain, apiBase }`
 *  - Desktop auth file (Tom6814) `{ auth: { accessToken, refreshToken, expiresAt, refreshExpiresAt, expiresIn, refreshExpiresIn }, account: { uid } }`
 *  - Direct DB row / already-normalized `Credential`
 *
 * Throws with a readable message when required fields are missing.
 */
export function normalizePoolFile(raw: unknown): Credential {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("normalizePoolFile: expected an object");
  }
  const obj = raw as Record<string, unknown>;

  // Locate auth and account sub-objects.
  let authRaw: Record<string, unknown> | undefined;
  if (obj.auth && typeof obj.auth === "object" && !Array.isArray(obj.auth)) {
    authRaw = obj.auth as Record<string, unknown>;
  } else if (obj.token_info && typeof obj.token_info === "object" && !Array.isArray(obj.token_info)) {
    authRaw = obj.token_info as Record<string, unknown>;
  } else if (obj.tokenInfo && typeof obj.tokenInfo === "object" && !Array.isArray(obj.tokenInfo)) {
    authRaw = obj.tokenInfo as Record<string, unknown>;
  }

  // Fallback: top-level looks like auth itself
  if (!authRaw) {
    const hasAuthToken =
      typeof obj.accessToken === "string" ||
      typeof obj.access_token === "string" ||
      typeof obj.refreshToken === "string" ||
      typeof obj.refresh_token === "string";
    if (hasAuthToken) authRaw = obj;
  }
  authRaw = authRaw ?? {};

  let accountRaw: Record<string, unknown> | undefined;
  if (obj.account && typeof obj.account === "object" && !Array.isArray(obj.account)) {
    accountRaw = obj.account as Record<string, unknown>;
  } else if (obj.account_info && typeof obj.account_info === "object" && !Array.isArray(obj.account_info)) {
    accountRaw = obj.account_info as Record<string, unknown>;
  }

  const pick = (...values: unknown[]): unknown => {
    for (const v of values) if (v !== undefined && v !== null && v !== "") return v;
    return undefined;
  };

  const pickString = (...values: unknown[]): string | undefined => {
    const v = pick(...values);
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };

  const uid =
    pickString(
      obj.uid,
      (accountRaw as Record<string, unknown> | undefined)?.uid,
      (accountRaw as Record<string, unknown> | undefined)?.user_id,
      (accountRaw as Record<string, unknown> | undefined)?.userId,
      (obj as Record<string, unknown>).userId,
      (obj as Record<string, unknown>).user_id,
      (accountRaw as Record<string, unknown> | undefined)?.sub,
      (obj as Record<string, unknown>).sub,
      authRaw.uid,
      authRaw.user_id,
      authRaw.userId,
    ) ?? undefined;

  const label = pickString(obj.label, accountRaw?.label, authRaw.label) ?? undefined;

  const domain = pickString(obj.domain, authRaw.domain, accountRaw?.domain) ?? "www.codebuddy.cn";

  const apiBase =
    pickString(obj.apiBase, (obj as Record<string, unknown>).api_base, authRaw.apiBase, authRaw.api_base) ??
    "https://copilot.tencent.com";

  let consoleBase = pickString(
    obj.consoleBase,
    (obj as Record<string, unknown>).console_base,
    authRaw.consoleBase,
    authRaw.console_base,
  );
  if (!consoleBase) {
    if (typeof domain === "string" && domain.startsWith("http://") ) consoleBase = domain;
    else if (typeof domain === "string" && domain.startsWith("https://")) consoleBase = domain;
    else consoleBase = `https://${domain}`;
    if (!consoleBase || consoleBase === "https://") consoleBase = "https://www.codebuddy.cn";
  }

  const enterpriseId =
    pickString(
      obj.enterpriseId,
      (obj as Record<string, unknown>).enterprise_id,
      accountRaw?.enterpriseId,
      accountRaw?.enterprise_id,
      (accountRaw as Record<string, unknown> | undefined)?.enterpriseID,
      accountRaw?.tenantId,
      accountRaw?.tenant_id,
      (obj as Record<string, unknown>).tenantId,
      authRaw.enterpriseId,
      authRaw.enterprise_id,
    ) ?? undefined;

  const nickname =
    pickString(obj.nickname, accountRaw?.nickname, accountRaw?.name, accountRaw?.uin, authRaw.nickname) ??
    undefined;

  const accessToken = pickString(authRaw.accessToken, authRaw.access_token, obj.accessToken, obj.access_token);
  const refreshToken = pickString(authRaw.refreshToken, authRaw.refresh_token, obj.refreshToken, obj.refresh_token);
  const tokenType = pickString(authRaw.tokenType, authRaw.token_type, obj.tokenType, (obj as Record<string, unknown>).token_type) ?? "Bearer";

  // Expiry normalization helpers
  const parseAbsoluteMs = (value: unknown): number | undefined => {
    if (value === undefined || value === null || value === "") return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return undefined;
    if (n >= 1e11) return n; // ms epoch (e.g. 1.75e12)
    if (n >= 1e9) return n * 1000; // seconds epoch (e.g. 1.75e9)
    // Small value in absolute field — treat as relative seconds offset (legacy / mis-placed)
    return Date.now() + n * 1000;
  };

  const parseRelativeMs = (value: unknown): number | undefined => {
    if (value === undefined || value === null || value === "") return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return undefined;
    if (n >= 1e11) return n;
    if (n >= 1e9) return n * 1000;
    return Date.now() + n * 1000;
  };

  let expiresAt: number | undefined = parseAbsoluteMs(
    pick(authRaw.expiresAt, authRaw.expires_at, (obj as Record<string, unknown>).expiresAt, (obj as Record<string, unknown>).expires_at),
  );
  if (expiresAt === undefined) {
    const rel = pick(
      authRaw.expiresIn,
      authRaw.expires_in,
      (authRaw as Record<string, unknown>).expires_in_seconds,
      (obj as Record<string, unknown>).expiresIn,
      (obj as Record<string, unknown>).expires_in,
    );
    expiresAt = parseRelativeMs(rel);
  }
  expiresAt = expiresAt ?? 0;

  let refreshExpiresAt: number | undefined = parseAbsoluteMs(
    pick(
      authRaw.refreshExpiresAt,
      authRaw.refresh_expires_at,
      (authRaw as Record<string, unknown>).refreshExpires_at,
      (obj as Record<string, unknown>).refreshExpiresAt,
      (obj as Record<string, unknown>).refresh_expires_at,
      (obj as Record<string, unknown>).refreshExpires_at,
    ),
  );
  if (refreshExpiresAt === undefined) {
    const rel = pick(
      authRaw.refreshExpiresIn,
      authRaw.refresh_expires_in,
      (authRaw as Record<string, unknown>).refreshExpiresIn,
      (obj as Record<string, unknown>).refreshExpiresIn,
      (obj as Record<string, unknown>).refresh_expires_in,
    );
    refreshExpiresAt = parseRelativeMs(rel);
  }
  refreshExpiresAt = refreshExpiresAt ?? 0;

  let capturedAt: number | undefined = parseAbsoluteMs(
    pick(authRaw.capturedAt, authRaw.captured_at, (obj as Record<string, unknown>).capturedAt, (obj as Record<string, unknown>).captured_at),
  );
  if (capturedAt === undefined || capturedAt === 0) capturedAt = Date.now();

  const source =
    pickString(authRaw.source, (obj as Record<string, unknown>).source, authRaw.src, (obj as Record<string, unknown>).src) ??
    (authRaw.accessToken || authRaw.access_token ? "auth-file:unknown" : "device-flow");

  // apiKey — only present on onboard pool files and direct Credential rows
  let apiKey: Credential["apiKey"] | undefined;
  const apiKeyCandidate = (pick(
    obj.apiKey,
    (obj as Record<string, unknown>).api_key,
    authRaw.apiKey,
    authRaw.api_key,
  ) as unknown) as Record<string, unknown> | string | undefined;

  if (apiKeyCandidate && typeof apiKeyCandidate === "object" && !Array.isArray(apiKeyCandidate)) {
    const rawKey = apiKeyCandidate as Record<string, unknown>;
    const name = pickString(rawKey.name, rawKey.key_name, rawKey.keyName) ?? "default";
    const keyId = pickString(rawKey.keyId, rawKey.key_id, rawKey.id) ?? undefined;
    const fullKey = pickString(
      rawKey.fullKey,
      rawKey.full_key,
      rawKey.key,
      rawKey.apiKey,
      rawKey.api_key,
      rawKey.secret,
      rawKey.secretKey,
      rawKey.secret_key,
    );
    if (fullKey) {
      apiKey = { name, ...(keyId ? { keyId } : {}), fullKey };
    }
  } else if (typeof apiKeyCandidate === "string" && apiKeyCandidate.length > 0) {
    apiKey = { name: "default", fullKey: apiKeyCandidate };
  }

  if (!uid) throw new Error("normalizePoolFile: missing required field uid");
  if (!accessToken) throw new Error("normalizePoolFile: missing required field accessToken");
  if (!refreshToken) throw new Error("normalizePoolFile: missing required field refreshToken");

  const credential: Credential = {
    uid,
    ...(label ? { label } : {}),
    domain,
    apiBase,
    consoleBase,
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(nickname ? { nickname } : {}),
    auth: {
      accessToken,
      refreshToken,
      tokenType,
      expiresAt,
      refreshExpiresAt,
      capturedAt,
      source,
    },
    ...(apiKey ? { apiKey } : {}),
  };

  return credential;
}
