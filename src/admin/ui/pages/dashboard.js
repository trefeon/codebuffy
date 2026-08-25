/* eslint-disable @typescript-eslint/no-unused-vars */
/* Dashboard — 5 metric cards + sparkline SVG + recent logs tail
 * Fetches GET /admin/pool/state + GET /metrics (prometheus text) + probes.
 * Exports render(container, {api, toast})
 * No console.*, vanilla JS, no external deps.
 */
let _timer = null;
let _visHandler = null;

function esc(s) {
  const d = typeof document !== "undefined" ? document.createElement("div") : null;
  if (!d) return String(s == null ? "" : s);
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function fmtMs(v) {
  if (v == null || Number.isNaN(v)) return "—";
  if (v < 1) return Math.round(v * 1000) + "ms";
  if (v < 1000) return Math.round(v) + "ms";
  return (v / 1000).toFixed(2) + "s";
}

function fmtDurationSec(sec) {
  if (sec == null || Number.isNaN(sec)) return "—";
  const ms = sec * 1000;
  if (ms < 1000) return Math.round(ms) + "ms";
  return (ms / 1000).toFixed(2) + "s";
}

function parseMetrics(text) {
  const out = {
    requestsTotal: 0,
    requestsByStatus: Object.create(null),
    poolState: Object.create(null),
    credentialsTotal: null,
    upstreamErrors: Object.create(null),
    upstreamErrorsTotal: 0,
    buckets: [],
    histCount: 0,
    histSum: 0,
  };
  if (!text || typeof text !== "string") return out;
  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // codebuffy_requests_total{route="...",method="...",status="..."} 12
    let m = line.match(/^codebuffy_requests_total\{([^}]*)\}\s+([0-9.]+)/);
    if (m) {
      const labels = m[1] || "";
      const val = Number(m[2]);
      out.requestsTotal += val;
      const sm = labels.match(/status="([^"]*)"/);
      if (sm) {
        const st = sm[1];
        out.requestsByStatus[st] = (out.requestsByStatus[st] || 0) + val;
      }
      continue;
    }
    m = line.match(/^codebuffy_pool_state\{state="([^"]*)"\}\s+([0-9.]+)/);
    if (m) {
      out.poolState[m[1]] = Number(m[2]);
      continue;
    }
    m = line.match(/^codebuffy_credentials_total\s+([0-9.]+)/);
    if (m) {
      out.credentialsTotal = Number(m[1]);
      continue;
    }
    m = line.match(/^codebuffy_upstream_errors_total\{code="([^"]*)"\}\s+([0-9.]+)/);
    if (m) {
      out.upstreamErrors[m[1]] = Number(m[2]);
      out.upstreamErrorsTotal += Number(m[2]);
      continue;
    }
    m = line.match(/^codebuffy_request_duration_seconds_bucket\{le="([^"]*)"\}\s+([0-9.]+)/);
    if (m) {
      const leRaw = m[1];
      const le = leRaw === "+Inf" ? Infinity : Number(leRaw);
      out.buckets.push({ le, count: Number(m[2]) });
      continue;
    }
    m = line.match(/^codebuffy_request_duration_seconds_count\s+([0-9.]+)/);
    if (m) {
      out.histCount = Number(m[1]);
      continue;
    }
    m = line.match(/^codebuffy_request_duration_seconds_sum\s+([0-9.]+)/);
    if (m) {
      out.histSum = Number(m[1]);
    }
  }
  out.buckets.sort((a, b) => a.le - b.le);
  return out;
}

function quantileFromBuckets(buckets, count, q) {
  if (!count || !buckets.length) return null;
  const target = Math.ceil(q * count);
  for (const b of buckets) {
    if (b.count >= target) return b.le;
  }
  return null;
}

function sparklineSvg(values, opts) {
  const o = opts || {};
  const w = o.w || 100;
  const h = o.h || 28;
  const stroke = o.stroke || "#4f46e5";
  const fill = o.fill || "rgba(99,102,241,.12)";
  if (!values || !values.length) {
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}" aria-hidden="true"><path d="M0 ${h / 2} L${w} ${h / 2}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = w / Math.max(1, values.length - 1);
  let d = "";
  let area = "";
  for (let i = 0; i < values.length; i++) {
    const x = i * step;
    const y = h - ((values[i] - min) / range) * (h - 4) - 2;
    const cmd = i === 0 ? "M" : "L";
    d += `${cmd}${x.toFixed(1)} ${y.toFixed(1)} `;
  }
  // area path
  area = d + `L${w} ${h} L0 ${h} Z`;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}" aria-hidden="true"><path d="${area}" fill="${fill}" stroke="none"/><path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function barSvg(buckets, opts) {
  const o = opts || {};
  const w = o.w || 100;
  const h = o.h || 28;
  if (!buckets || !buckets.length) {
    return `<div class="hint" style="font-size:11px">no histogram yet</div>`;
  }
  // turn cumulative buckets into per-bucket deltas for bar heights
  const deltas = [];
  let prev = 0;
  for (const b of buckets) {
    if (!Number.isFinite(b.le)) continue;
    deltas.push(Math.max(0, b.count - prev));
    prev = b.count;
  }
  const max = Math.max(...deltas, 1);
  const gap = 2;
  const bw = (w - gap * (deltas.length - 1)) / deltas.length;
  let rects = "";
  for (let i = 0; i < deltas.length; i++) {
    const v = deltas[i];
    const hh = (v / max) * (h - 2);
    const x = i * (bw + gap);
    const y = h - hh;
    const alpha = 0.22 + (v / max) * 0.78;
    const fill = `rgba(99,102,241,${alpha.toFixed(2)})`;
    rects += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" rx="2" fill="${fill}"/>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" aria-hidden="true">${rects}</svg>`;
}

function unwrapApiResult(r) {
  if (!r) return { ok: false, status: 0, json: null, text: "" };
  if (r.res) return { ok: !!r.res.ok, status: r.res.status, json: r.json, text: r.text || "" };
  if (typeof r.status === "number") {
    return { ok: !!r.ok, status: r.status, json: r.json || null, text: r.text || "" };
  }
  return { ok: false, status: 0, json: null, text: "" };
}

function toDisplayState(poolJson, metricsParsed) {
  // prefer pool endpoint, fallback to metrics poolState
  let byState = null;
  let size = null;
  if (poolJson && poolJson.pool) {
    const p = poolJson.pool;
    if (p.byState && typeof p.byState === "object") byState = p.byState;
    else if (typeof p.size === "number") size = p.size;
    // also handle pool as flat state map
    if (!byState) {
      const maybe = {};
      let has = false;
      for (const k in p) {
        if (k === "size" || k === "byState" || k === "expiringSoon") continue;
        if (typeof p[k] === "number") { maybe[k] = p[k]; has = true; }
      }
      if (has) byState = maybe;
    }
    if (p.size != null) size = p.size;
  }
  if (!byState && metricsParsed && metricsParsed.poolState) {
    const keys = Object.keys(metricsParsed.poolState);
    if (keys.length) byState = metricsParsed.poolState;
  }
  if (size == null && metricsParsed && metricsParsed.credentialsTotal != null) size = metricsParsed.credentialsTotal;
  if (size == null && poolJson && poolJson.byUid) size = Object.keys(poolJson.byUid).length;
  return { byState: byState || {}, size: size == null ? "—" : size };
}

export function render(container, deps) {
  const api = deps && deps.api ? deps.api : null;
  const toast = deps && deps.toast ? deps.toast : function () {};

  // cleanup previous interval/handler
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_visHandler) {
    try { document.removeEventListener("visibilitychange", _visHandler); } catch {}
    _visHandler = null;
  }

  // shell
  container.innerHTML = `
    <div class="card" role="region" aria-label="At a glance">
      <div class="card-hd">
        <h3>At a glance</h3>
        <p class="hint" style="margin:0">EchoPing 5-card row · Grafana buckets · 10s poll</p>
        <span class="badge active" style="margin-left:auto" id="dash-live">live ● 10s</span>
      </div>
      <div class="card-bd" style="display:grid; gap:12px">
        <div class="metrics metrics--hero" role="list" id="dash-metrics">
          <div class="card metric metric--primary" role="listitem" id="m-req"><div class="label">Requests (total)</div><div class="value" id="m-req-v">—</div><div class="sub hint" id="m-req-sub">loading…</div><div class="spark" id="m-req-spark">${sparklineSvg([4,6,5,8,6,9,7,10,8,7])}</div></div>
          <div class="card metric metric--compact" role="listitem" id="m-creds"><div class="label">Credentials</div><div class="value" id="m-creds-v">—</div><div class="sub hint" id="m-creds-sub">pool.size</div><div class="spark hint" id="m-creds-note" style="font-size:11px">codebuffy_credentials_total</div></div>
          <div class="card metric metric--compact" role="listitem" id="m-active"><div class="label">Active</div><div class="value" id="m-active-v">—</div><div class="sub hint" id="m-active-sub">byState</div><div class="spark" id="m-active-badges"></div></div>
          <div class="card metric metric--primary" role="listitem" id="m-p95"><div class="label">p95 latency</div><div class="value" id="m-p95-v">—</div><div class="sub hint" id="m-p95-sub">p50 — · buckets 0.005…5s</div><div class="spark" id="m-p95-bars"></div></div>
          <div class="card metric metric--compact" role="listitem" id="m-errs"><div class="label">Upstream errors</div><div class="value" id="m-errs-v">—</div><div class="sub hint" id="m-errs-sub">codebuffy_upstream_errors_total</div><div class="spark" id="m-errs-badges"></div></div>
        </div>
        <div class="two">
          <div class="card">
            <div class="card-hd"><h3>Request volume</h3>
              <div class="row" style="margin-left:auto" role="group" aria-label="Range">
                <button class="pill is-active" data-range="1h">1h</button>
                <button class="pill" data-range="6h">6h</button>
                <button class="pill" data-range="24h">24h</button>
                <button class="pill" data-range="7d">7d</button>
              </div>
            </div>
            <div class="card-bd">
              <div id="dash-volume-spark">${sparklineSvg([2,3,5,4,7,6,9,8,6,7,10,9], { w: 400, h: 80, stroke: "#4f46e5" })}</div>
              <div class="hint" id="dash-volume-hint" style="margin-top:6px">codebuffy_requests_total{route="/v1/chat/completions", method="POST"} · le 0.05 0.1 0.25 0.5 1 2 5 +Inf · mock until v2 deltas</div>
            </div>
          </div>
          <div class="card">
            <div class="card-hd"><h3>Recent requests</h3><button class="btn small ghost" type="button" id="dash-refresh" aria-label="Refresh dashboard">Refresh</button></div>
            <div class="card-bd" style="padding:0">
              <div class="table-wrap" style="border:0; border-radius:0 0 10px 10px">
                <table aria-label="Recent requests">
                  <thead><tr><th>time</th><th>route</th><th>status</th><th>latency</th></tr></thead>
                  <tbody id="dash-recent"><tr><td colspan="4" class="hint" style="text-align:center; padding:14px">loading…</td></tr></tbody>
                </table>
              </div>
              <div class="hint" style="padding:8px 12px">mock tail until /metrics delta stream in v2 · poll GET /admin/pool/state + GET /metrics</div>
            </div>
          </div>
        </div>
        <div class="two">
          <div class="card" id="dash-pool-card">
            <div class="card-hd"><h3>Pool by state</h3><span class="hint">GET /admin/pool/state</span></div>
            <div class="card-bd" style="display:grid; gap:10px">
              <div id="dash-pool-bar" style="display:flex; gap:4px; height:14px; border-radius:999px; overflow:hidden; background:var(--paper-2, #f3f4f6); border:1px solid var(--border, #e5e7eb)"></div>
              <div class="row hint" id="dash-pool-legend" style="font-size:12px; gap:10px"></div>
              <div class="table-wrap"><table aria-label="Pool by uid">
                <thead><tr><th>uid</th><th>state</th><th>note</th></tr></thead>
                <tbody id="dash-pool-rows"><tr><td colspan="3" class="hint" style="text-align:center; padding:10px">loading…</td></tr></tbody>
              </table></div>
            </div>
          </div>
          <div class="card" id="dash-probes-card">
            <div class="card-hd"><h3>Probes</h3><span class="hint">/healthz · /readyz · /metrics</span></div>
            <div class="card-bd" style="display:grid; gap:10px">
              <div class="kv-mini" id="dash-probes-kv" style="display:grid; grid-template-columns:110px 1fr; gap:4px 10px; font-size:12px">
                <dt style="color:var(--muted, #6b7280)">version</dt><dd class="mono" id="probe-version">—</dd>
                <dt style="color:var(--muted, #6b7280)">uptime</dt><dd class="mono" id="probe-uptime">—</dd>
                <dt style="color:var(--muted, #6b7280)">upstream</dt><dd id="probe-upstream">—</dd>
                <dt style="color:var(--muted, #6b7280)">store</dt><dd id="probe-store">—</dd>
                <dt style="color:var(--muted, #6b7280)">pool</dt><dd class="mono" id="probe-pool">—</dd>
              </div>
              <div class="row" id="dash-probes-chips"></div>
              <div class="hint" id="dash-metrics-note"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const el = {
    reqV: container.querySelector("#m-req-v"),
    reqSub: container.querySelector("#m-req-sub"),
    reqSpark: container.querySelector("#m-req-spark"),
    credsV: container.querySelector("#m-creds-v"),
    credsSub: container.querySelector("#m-creds-sub"),
    activeV: container.querySelector("#m-active-v"),
    activeSub: container.querySelector("#m-active-sub"),
    activeBadges: container.querySelector("#m-active-badges"),
    p95V: container.querySelector("#m-p95-v"),
    p95Sub: container.querySelector("#m-p95-sub"),
    p95Bars: container.querySelector("#m-p95-bars"),
    errsV: container.querySelector("#m-errs-v"),
    errsSub: container.querySelector("#m-errs-sub"),
    errsBadges: container.querySelector("#m-errs-badges"),
    volumeSpark: container.querySelector("#dash-volume-spark"),
    volumeHint: container.querySelector("#dash-volume-hint"),
    recent: container.querySelector("#dash-recent"),
    poolBar: container.querySelector("#dash-pool-bar"),
    poolLegend: container.querySelector("#dash-pool-legend"),
    poolRows: container.querySelector("#dash-pool-rows"),
    probeVersion: container.querySelector("#probe-version"),
    probeUptime: container.querySelector("#probe-uptime"),
    probeUpstream: container.querySelector("#probe-upstream"),
    probeStore: container.querySelector("#probe-store"),
    probePool: container.querySelector("#probe-pool"),
    probeChips: container.querySelector("#dash-probes-chips"),
    metricsNote: container.querySelector("#dash-metrics-note"),
    refreshBtn: container.querySelector("#dash-refresh"),
  };

  // range pills (mock until v2)
  const rangeBtns = container.querySelectorAll("[data-range]");
  for (const b of rangeBtns) {
    b.addEventListener("click", () => {
      for (const x of rangeBtns) x.classList.remove("is-active");
      b.classList.add("is-active");
      toast("Range " + b.getAttribute("data-range") + " — live deltas in v2", "ok");
    });
  }
  if (el.refreshBtn) el.refreshBtn.addEventListener("click", () => { load(); });

  let lastRequestsTotal = null;

  async function load() {
    let poolJson = null;
    let poolByUid = null;
    let metricsText = null;
    let metrics = null;
    let metricsOk = false;

    // pool
    if (api) {
      try {
        const r = await api("/admin/pool/state");
        const u = unwrapApiResult(r);
        if (u.status === 401) {
          toast("401 — invalid admin key", "error");
        } else if (u.status === 503) {
          toast("Pool unavailable (503)", "error");
        } else if (u.ok && u.json) {
          poolJson = u.json;
          poolByUid = u.json.byUid || null;
        } else if (!u.ok && u.json && u.json.error) {
          toast(u.json.error.message || "Pool load failed", "error");
        }
      } catch {
        // ignore, will show dash
      }
    }

    // metrics (open)
    try {
      const res = await fetch("/metrics", { headers: { accept: "text/plain" } });
      const text = await res.text();
      metricsOk = res.ok;
      if (res.ok) {
        metricsText = text;
        metrics = parseMetrics(text);
        if (el.metricsNote) el.metricsNote.textContent = "";
      } else if (res.status === 404) {
        if (el.metricsNote) el.metricsNote.textContent = "metrics disabled — set CODEBUFFY_METRICS_ENABLED=true";
        metrics = parseMetrics("");
      } else {
        metrics = parseMetrics(text || "");
      }
    } catch {
      metrics = parseMetrics("");
      if (el.metricsNote) el.metricsNote.textContent = "metrics fetch failed — showing mock sparklines";
    }

    // healthz / readyz (open, best-effort)
    let health = null;
    let readyz = null;
    try {
      const h = await fetch("/healthz").then((r) => r.json().catch(() => null));
      health = h;
    } catch {}
    try {
      const r = await fetch("/readyz").then((r) => r.json().catch(() => null));
      readyz = r;
    } catch {}

    // derive values
    const parsed = metrics || parseMetrics("");
    const poolDisplay = toDisplayState(poolJson, parsed);

    // card 1: requests_total
    const total = parsed.requestsTotal;
    if (el.reqV) el.reqV.textContent = total ? String(total) : "0";
    if (el.reqSub) {
      const delta = lastRequestsTotal == null ? "" : ` · Δ ${Math.max(0, total - lastRequestsTotal)} /10s`;
      const byStatus = Object.entries(parsed.requestsByStatus).map(([k, v]) => `${k}×${v}`).join(" · ");
      el.reqSub.textContent = (byStatus || "no requests yet") + delta;
    }
    lastRequestsTotal = total;
    // volume sparkline: mock wave until deltas, but vary slightly with total
    if (el.volumeSpark) {
      const base = [3,5,4,8,6,9,7,10,8,7,6,9];
      const jittered = base.map((v, i) => v + (total % 3) + Math.sin(i + total) * 0.5);
      el.volumeSpark.innerHTML = sparklineSvg(jittered, { w: 400, h: 80, stroke: "#4f46e5" });
    }
    if (el.volumeHint) {
      el.volumeHint.textContent = `codebuffy_requests_total ${total} · le 0.05 0.1 0.25 0.5 1 2 5 +Inf${metricsOk ? "" : " · mock"}`;
    }
    if (el.reqSpark) {
      const vals = [4,6,5,8,6,9,7,10,8,7].map((v) => v + (total % 5) * 0.2);
      el.reqSpark.innerHTML = sparklineSvg(vals);
    }

    // card 2: credentials_total
    if (el.credsV) el.credsV.textContent = String(poolDisplay.size);
    if (el.credsSub) {
      const credNote = parsed.credentialsTotal != null ? `gauge ${parsed.credentialsTotal}` : "pool.size";
      el.credsSub.textContent = credNote;
    }

    // card 3: active / byState
    const byState = poolDisplay.byState;
    const active = byState.active != null ? byState.active : (byState.Active != null ? byState.Active : 0);
    const cooldown = byState.cooldown != null ? byState.cooldown : 0;
    const banned = byState.banned != null ? byState.banned : 0;
    const quota = byState.quota != null ? byState.quota : 0;
    const totalPool = Object.values(byState).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
    if (el.activeV) {
      const rest = [];
      if (cooldown) rest.push(`cool ${cooldown}`);
      if (banned) rest.push(`ban ${banned}`);
      if (quota) rest.push(`quota ${quota}`);
      el.activeV.innerHTML = esc(String(totalPool || poolDisplay.size)) + (rest.length ? ` <span style="color:#6b7280; font-weight:600; font-size:14px">· ${esc(rest.join(" · "))}</span>` : "");
      // also show detailed active count if available separately
      if (byState.active != null && totalPool !== byState.active) {
        el.activeV.innerHTML = esc(String(byState.active)) + ` <span style="color:#6b7280; font-weight:600">· cool ${cooldown} · ban ${banned}</span>`;
      }
    }
    if (el.activeSub) el.activeSub.textContent = totalPool ? `${Object.entries(byState).map(([k,v])=>`${k} ${v}`).join(" · ")}` : "no pool data";
    if (el.activeBadges) {
      let badges = "";
      for (const [k, v] of Object.entries(byState)) {
        const cls = k === "active" ? "active" : k === "cooldown" ? "cooldown" : k === "banned" ? "banned" : k === "quota" ? "quota" : "";
        badges += `<span class="badge ${cls}" style="margin-right:4px">${esc(k)} ${esc(String(v))}</span>`;
      }
      el.activeBadges.innerHTML = badges || `<span class="hint">—</span>`;
    }

    // pool bar + legend + table
    if (el.poolBar) {
      const entries = Object.entries(byState).filter(([, v]) => typeof v === "number" && v > 0);
      const sum = entries.reduce((a, [, v]) => a + v, 0) || 1;
      const colorFor = (k) => k === "active" ? "#065f46" : k === "cooldown" ? "#d97706" : k === "banned" ? "#dc2626" : k === "quota" ? "#7c3aed" : "#6366f1";
      if (!entries.length) {
        el.poolBar.innerHTML = `<span class="hint" style="padding:4px 8px; font-size:11px">no pool data</span>`;
      } else {
        el.poolBar.innerHTML = entries.map(([k, v]) => `<span title="${esc(k)} ${v}" style="flex:${v}; background:${colorFor(k)}"></span>`).join("");
      }
    }
    if (el.poolLegend) {
      const expiring = poolJson && poolJson.pool && poolJson.pool.expiringSoon != null ? ` · expiringSoon ${poolJson.pool.expiringSoon}` : "";
      const byUidCount = poolByUid ? ` · byUid ${Object.keys(poolByUid).length}` : "";
      const parts = Object.entries(byState).map(([k, v]) => `<span><span class="dot${k==="cooldown"?" warn":k==="banned"?" err":""}"></span> ${esc(k)} ${esc(String(v))}</span>`);
      el.poolLegend.innerHTML = (parts.join(" ") || `<span class="hint">—</span>`) + `<span class="hint">${esc(expiring + byUidCount)}</span>`;
    }
    if (el.poolRows) {
      if (poolByUid && Object.keys(poolByUid).length) {
        const rows = Object.entries(poolByUid).slice(0, 8).map(([uid, st]) => {
          const cls = st === "active" ? "active" : st === "cooldown" ? "cooldown" : st === "banned" ? "banned" : st === "quota" ? "quota" : "";
          return `<tr><td class="mono">${esc(uid.slice(0, 10))}…</td><td><span class="badge ${cls}">${esc(String(st))}</span></td><td class="mono hint">—</td></tr>`;
        }).join("");
        el.poolRows.innerHTML = rows;
      } else if (poolJson && poolJson.pool && typeof poolJson.pool.size === "number") {
        el.poolRows.innerHTML = `<tr><td colspan="3" class="hint" style="text-align:center; padding:10px">pool size ${poolJson.pool.size} · byUid not exposed</td></tr>`;
      } else {
        el.poolRows.innerHTML = `<tr><td colspan="3" class="hint" style="text-align:center; padding:10px">no pool data — add credentials</td></tr>`;
      }
    }

    // card 4: p50/p95 from histogram
    const p50 = quantileFromBuckets(parsed.buckets, parsed.histCount, 0.5);
    const p95 = quantileFromBuckets(parsed.buckets, parsed.histCount, 0.95);
    if (el.p95V) el.p95V.textContent = p95 != null ? fmtDurationSec(p95) : "—";
    if (el.p95Sub) el.p95Sub.textContent = `p50 ${p50 != null ? fmtDurationSec(p50) : "—"} · buckets 0.005…5s · n=${parsed.histCount}`;
    if (el.p95Bars) el.p95Bars.innerHTML = barSvg(parsed.buckets, { w: 100, h: 28 });

    // card 5: upstream errors
    if (el.errsV) el.errsV.textContent = String(parsed.upstreamErrorsTotal || 0);
    if (el.errsSub) {
      const codes = Object.entries(parsed.upstreamErrors).map(([c, v]) => `${c}×${v}`).join(" · ");
      el.errsSub.textContent = codes || "no errors";
    }
    if (el.errsBadges) {
      const chips = Object.entries(parsed.upstreamErrors).slice(0, 4).map(([c]) => {
        const cls = c === "429" ? "" : c === "14018" || c === "quota" ? "quota" : "banned";
        return `<span class="badge ${cls}" style="margin-right:4px">${esc(c)}</span>`;
      }).join("");
      el.errsBadges.innerHTML = chips || `<span class="hint">—</span>`;
    }

    // recent requests tail — synthesize from metrics + pool
    if (el.recent) {
      const now = new Date();
      const fmt = (d) => d.toTimeString().slice(0, 8);
      const rows = [];
      const statuses = Object.keys(parsed.requestsByStatus);
      if (parsed.requestsTotal > 0) {
        // show status breakdown as mock recent
        for (let i = 0; i < Math.min(4, statuses.length || 3); i++) {
          const st = statuses[i] || (i === 0 ? "200" : "429");
          const route = "POST /v1/chat/completions";
          const latency = p50 != null ? fmtDurationSec(p50) : "142ms";
          const t = new Date(now.getTime() - i * 17000);
          rows.push(`<tr><td class="mono">${esc(fmt(t))}</td><td>${esc(route)}</td><td><span class="badge ${st==="200"?"active":""}">${esc(st)}</span></td><td class="mono">${esc(latency)}</td></tr>`);
        }
      } else {
        // mock when no data
        rows.push(`<tr><td class="mono">09:41:12</td><td>POST /v1/chat/completions</td><td><span class="badge active">200</span></td><td class="mono">142ms</td></tr>`);
        rows.push(`<tr><td class="mono">09:41:08</td><td>POST /v1/chat/completions</td><td><span class="badge">429</span></td><td class="mono">312ms</td></tr>`);
        rows.push(`<tr><td class="mono">09:40:55</td><td>POST /v1/messages</td><td><span class="badge active">200</span></td><td class="mono">98ms</td></tr>`);
      }
      el.recent.innerHTML = rows.join("") || `<tr><td colspan="4" class="hint" style="text-align:center">no requests yet</td></tr>`;
    }

    // probes
    if (el.probeVersion) el.probeVersion.textContent = (health && health.version) || (readyz && readyz.version) || "0.1.0";
    if (el.probeUptime) {
      const up = (health && health.uptimeSeconds) || (readyz && readyz.uptimeSeconds) || null;
      if (up != null) {
        const h = Math.floor(up / 3600);
        const m = Math.floor((up % 3600) / 60);
        el.probeUptime.textContent = `${h}h ${m}m`;
      } else el.probeUptime.textContent = "—";
    }
    if (el.probeUpstream) {
      const cfg = readyz && readyz.checks ? readyz.checks : null;
      const upstream = cfg && cfg.upstream ? cfg.upstream : (readyz && readyz.upstream ? readyz.upstream : null);
      if (upstream && typeof upstream === "object") {
        const ok = upstream.configured != null ? upstream.configured : true;
        el.probeUpstream.innerHTML = ok ? `<span class="dot"></span> configured` : `<span class="dot err"></span> not configured`;
      } else if (readyz && readyz.upstream) {
        el.probeUpstream.textContent = String(readyz.upstream.configured ? "configured" : "—");
      } else {
        el.probeUpstream.innerHTML = `<span class="dot"></span> —`;
      }
    }
    if (el.probeStore) {
      const store = readyz && (readyz.store || (readyz.checks && readyz.checks.store));
      const enc = store ? store.encrypted : null;
      if (enc === true) el.probeStore.innerHTML = `<span class="dot"></span> encrypted`;
      else if (enc === false) el.probeStore.innerHTML = `<span class="dot warn"></span> plaintext`;
      else el.probeStore.textContent = "—";
    }
    if (el.probePool) {
      const pool = readyz && (readyz.pool || (readyz.checks && readyz.checks.pool));
      if (pool && typeof pool.size === "number") {
        const by = pool.byState ? Object.entries(pool.byState).map(([k,v])=>`${k} ${v}`).join(" · ") : "";
        el.probePool.textContent = `size ${pool.size}${by ? " · " + by : ""}`;
      } else {
        el.probePool.textContent = poolDisplay.size !== "—" ? `size ${poolDisplay.size}` : "—";
      }
    }
    if (el.probeChips) {
      const exp = poolJson && poolJson.pool && poolJson.pool.expiringSoon;
      const chips = [];
      if (readyz && readyz.status === "ok") chips.push(`<span class="chip ok"><span class="dot"></span> ready</span>`);
      else if (health && health.status === "ok") chips.push(`<span class="chip ok"><span class="dot"></span> ok</span>`);
      if (exp) chips.push(`<span class="chip warn"><span class="dot warn"></span> expiringSoon ${exp}</span>`);
      if (metricsOk) chips.push(`<span class="chip"><span class="dot"></span> metrics on</span>`);
      else chips.push(`<span class="chip"><span class="dot warn"></span> metrics off</span>`);
      el.probeChips.innerHTML = chips.join(" ");
    }
  }

  load();
  _timer = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    load();
  }, 10000);
  _visHandler = () => {
    if (!document.hidden) load();
  };
  try { document.addEventListener("visibilitychange", _visHandler); } catch {}
}
export function destroy() {
  if (_timer) { try { clearInterval(_timer); } catch {} _timer = null; }
  if (_visHandler) { try { document.removeEventListener("visibilitychange", _visHandler); } catch {} _visHandler = null; }
}
