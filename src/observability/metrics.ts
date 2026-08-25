/**
 * Lightweight Prometheus registry without external dependencies.
 * Counters: requests_total, upstream_errors_total
 * Gauges: credentials_total, pool_state
 * Histogram: request_duration_seconds
 */

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5] as const;

// ---- internal state ----

type RequestsKey = string; // route\x00method\x00status
const requestsTotal = new Map<RequestsKey, number>();
const upstreamErrorsTotal = new Map<string, number>();
let credentialsTotal = 0;
const poolState = new Map<string, number>();

let histBucketCounts: number[] = new Array(BUCKETS.length).fill(0);
let histCount = 0;
let histSum = 0;

// ---- helpers ----

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function requestsKey(route: string, method: string, status: string): RequestsKey {
  return `${route}\x00${method}\x00${status}`;
}

// ---- public inc/observe ----

export function incRequestsTotal(
  labels: { route: string; method: string; status: string | number },
  value = 1,
): void {
  const route = labels.route;
  const method = labels.method;
  const status = String(labels.status);
  const k = requestsKey(route, method, status);
  requestsTotal.set(k, (requestsTotal.get(k) ?? 0) + value);
}

export function incUpstreamErrorsTotal(code: string | number, value = 1): void {
  const k = String(code);
  upstreamErrorsTotal.set(k, (upstreamErrorsTotal.get(k) ?? 0) + value);
}

export function setCredentialsTotal(value: number): void {
  credentialsTotal = value;
}

export function incCredentialsTotal(value = 1): void {
  credentialsTotal += value;
}

export function setPoolState(state: string, value: number): void {
  poolState.set(state, value);
}

export function setPoolStates(map: Record<string, number>): void {
  for (const [k, v] of Object.entries(map)) {
    poolState.set(k, v);
  }
}

export function observeRequestDuration(seconds: number): void {
  histCount += 1;
  histSum += seconds;
  for (let i = 0; i < BUCKETS.length; i++) {
    if (seconds <= BUCKETS[i]!) {
      // cumulative: increment this bucket and all larger are logically inclusive,
      // but we store per-bucket cumulative directly, so we need to increment each bucket where le >= value.
      // Easiest: increment every bucket where value <= bucket threshold.
      histBucketCounts[i]! += 1;
    }
  }
  // +Inf bucket is histCount and rendered separately, no storage needed
}

// Backward/name compat
export const observeDuration = observeRequestDuration;

// ---- reset for tests ----

export function reset(): void {
  requestsTotal.clear();
  upstreamErrorsTotal.clear();
  credentialsTotal = 0;
  poolState.clear();
  histBucketCounts = new Array(BUCKETS.length).fill(0);
  histCount = 0;
  histSum = 0;
}

export const resetMetrics = reset;

// ---- exposition ----

export function renderMetrics(): string {
  const lines: string[] = [];

  // requests_total
  lines.push("# HELP codebuffy_requests_total Total HTTP requests");
  lines.push("# TYPE codebuffy_requests_total counter");
  const reqEntries = [...requestsTotal.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [k, v] of reqEntries) {
    const [route, method, status] = k.split("\x00") as [string, string, string];
    lines.push(
      `codebuffy_requests_total{route="${escapeLabelValue(route)}",method="${escapeLabelValue(method)}",status="${escapeLabelValue(status)}"} ${v}`,
    );
  }

  // upstream_errors_total
  lines.push("# HELP codebuffy_upstream_errors_total Total upstream errors by code");
  lines.push("# TYPE codebuffy_upstream_errors_total counter");
  const upEntries = [...upstreamErrorsTotal.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [code, v] of upEntries) {
    lines.push(`codebuffy_upstream_errors_total{code="${escapeLabelValue(code)}"} ${v}`);
  }

  // credentials_total
  lines.push("# HELP codebuffy_credentials_total Total credentials in pool");
  lines.push("# TYPE codebuffy_credentials_total gauge");
  lines.push(`codebuffy_credentials_total ${credentialsTotal}`);

  // pool_state
  lines.push("# HELP codebuffy_pool_state Number of credentials by pool state");
  lines.push("# TYPE codebuffy_pool_state gauge");
  const poolEntries = [...poolState.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [state, v] of poolEntries) {
    lines.push(`codebuffy_pool_state{state="${escapeLabelValue(state)}"} ${v}`);
  }

  // histogram
  lines.push("# HELP codebuffy_request_duration_seconds HTTP request duration in seconds");
  lines.push("# TYPE codebuffy_request_duration_seconds histogram");
  for (let i = 0; i < BUCKETS.length; i++) {
    const le = String(BUCKETS[i]!);
    const count = histBucketCounts[i]!;
    // For proper cumulative semantics, bucket counts we stored are already cumulative for each threshold
    // but our incremental loop increments each bucket where value <= bucket.
    // That yields correct cumulative counts because each observation increments all buckets with le >= value.
    // However our storage currently increments each qualifying bucket, which is cumulative.
    // Need to verify: example buckets [0.05,0.1], observation 0.03 => increments both 0.05 and 0.1 (correct).
    // Observation 0.07 => increments only 0.1. So 0.05 stays 1, 0.1 becomes 2.
    lines.push(`codebuffy_request_duration_seconds_bucket{le="${le}"} ${count}`);
  }
  lines.push(`codebuffy_request_duration_seconds_bucket{le="+Inf"} ${histCount}`);
  lines.push(`codebuffy_request_duration_seconds_sum ${histSum}`);
  lines.push(`codebuffy_request_duration_seconds_count ${histCount}`);

  return lines.join("\n") + "\n";
}
