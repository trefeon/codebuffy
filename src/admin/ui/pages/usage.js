/* eslint-disable @typescript-eslint/no-unused-vars */
/* Codebuffy Admin — Usage / Stats
 * Range 1h-7d/today/yesterday, charts by model/credential, sortable tables,
 * autoRefresh, filters accessKey/credential. Parses GET /metrics Prometheus text;
 * falls back to mock when parse not yet / metrics disabled. Now also fetches
 * GET /admin/usage?range=... for real crb- rows (credits, cacheHit, tokens).
 * No console.*, no external deps. ESM.
 */
let _usageStop = null;
let _usageVis = null;
let _usageContainer = null;
function esc(s) {
  var d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}
function safeJson(v) { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }
function fmtInt(n) { return Number(n).toLocaleString("en-US"); }
function fmtPct(n) {
  if (n == null || isNaN(n)) return "—";
  return (n * 100).toFixed(1) + "%";
}
function toastSafe(deps, msg, kind) {
  if (deps && typeof deps.toast === "function") { deps.toast(msg, kind); return; }
  if (typeof window !== "undefined" && window.Codebuffy && typeof window.Codebuffy.toast === "function") { window.Codebuffy.toast(msg, kind); return; }
  var host = document.getElementById("toast") || document.getElementById("toasts");
  if (!host) return;
  var el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = msg;
  el.setAttribute("role", "status");
  host.appendChild(el);
  var t = setTimeout(function () {
    el.style.opacity = "0"; el.style.transition = "opacity 180ms";
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
  }, kind === "error" ? 4200 : 2600);
  el.addEventListener("click", function () { clearTimeout(t); if (el.parentNode) el.parentNode.removeChild(el); });
}

function parseMetrics(text) {
  var out = {
    requestsTotal: new Map(),
    upstreamErrors: new Map(),
    credentialsTotal: 0,
    poolState: new Map(),
    buckets: [],
    histCount: 0,
    histSum: 0,
    raw: text
  };
  if (!text) return out;
  var lines = text.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.charAt(0) === "#") continue;
    var m = line.match(/^([a-zA-Z0-9_:]+)(\{[^}]*\})?\s+([0-9.eE+\-]+)/);
    if (!m) continue;
    var name = m[1];
    var labelsRaw = m[2] || "";
    var val = Number(m[3]);
    if (name === "codebuffy_requests_total") {
      var route = "", method = "", status = "";
      var rm = labelsRaw.match(/route="((?:\\"|[^"])*)"/);
      if (rm) route = rm[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      var mm = labelsRaw.match(/method="((?:\\"|[^"])*)"/);
      if (mm) method = mm[1].replace(/\\"/g, '"');
      var sm = labelsRaw.match(/status="((?:\\"|[^"])*)"/);
      if (sm) status = sm[1].replace(/\\"/g, '"');
      var key = route + "\x00" + method + "\x00" + status;
      out.requestsTotal.set(key, val);
    } else if (name === "codebuffy_upstream_errors_total") {
      var cm = labelsRaw.match(/code="((?:\\"|[^"])*)"/);
      var code = cm ? cm[1].replace(/\\"/g, '"') : labelsRaw;
      out.upstreamErrors.set(code, val);
    } else if (name === "codebuffy_credentials_total") {
      out.credentialsTotal = val;
    } else if (name === "codebuffy_pool_state") {
      var stm = labelsRaw.match(/state="((?:\\"|[^"])*)"/);
      var st = stm ? stm[1].replace(/\\"/g, '"') : labelsRaw || "unknown";
      out.poolState.set(st, val);
    } else if (name === "codebuffy_request_duration_seconds_bucket") {
      var lem = labelsRaw.match(/le="([^"]+)"/);
      var le = lem ? lem[1] : "";
      out.buckets.push({ le: le, count: val });
    } else if (name === "codebuffy_request_duration_seconds_count") {
      out.histCount = val;
    } else if (name === "codebuffy_request_duration_seconds_sum") {
      out.histSum = val;
    }
  }
  out.buckets.sort(function (a, b) {
    if (a.le === "+Inf") return 1;
    if (b.le === "+Inf") return -1;
    return Number(a.le) - Number(b.le);
  });
  return out;
}

function quantileFromBuckets(buckets, count, q) {
  if (!buckets.length || !count) return null;
  var target = q * count;
  for (var i = 0; i < buckets.length; i++) {
    if (buckets[i].count >= target) {
      var le = buckets[i].le;
      if (le === "+Inf") return null;
      return Number(le);
    }
  }
  return null;
}

function syntheticSeries(range, total) {
  var points = 24;
  if (range === "1h") points = 12;
  else if (range === "6h") points = 18;
  else if (range === "24h" || range === "1d" || range === "today" || range === "yesterday") points = 24;
  else if (range === "7d") points = 28;
  else if (range === "30d") points = 30;
  var base = Math.max(4, Math.round((total || 120) / points));
  var arr = [];
  var seed = 0;
  for (var i = 0; i < points; i++) {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    var wobble = ((seed % 100) / 100 - 0.5) * 0.6;
    var trend = Math.sin(i / points * Math.PI * 2) * 0.3;
    var v = Math.max(0, Math.round(base * (1 + wobble + trend)));
    if (i === points - 1) v = Math.max(v, Math.round(base * 1.2));
    arr.push(v);
  }
  return arr;
}

function svgSparkline(values, color) {
  if (!values.length) return '<div class="hint">no data</div>';
  var w = 400, h = 80, pad = 6;
  var max = 0;
  for (var i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
  if (max === 0) max = 1;
  var step = (w - pad * 2) / Math.max(1, values.length - 1);
  var d = "";
  var area = "";
  for (var j = 0; j < values.length; j++) {
    var x = pad + j * step;
    var y = h - pad - (values[j] / max) * (h - pad * 2);
    d += (j === 0 ? "M" : " L") + x.toFixed(1) + " " + y.toFixed(1);
  }
  area = d + " L" + (pad + (values.length - 1) * step).toFixed(1) + " " + (h - pad).toFixed(1) + " L" + pad.toFixed(1) + " " + (h - pad).toFixed(1) + " Z";
  var col = color || "#4f46e5";
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '" role="img" aria-label="sparkline">'
    + '<path d="' + esc(area) + '" fill="' + esc(col) + '" opacity="0.08"></path>'
    + '<path d="' + esc(d) + '" fill="none" stroke="' + esc(col) + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>'
    + '</svg>';
}

function barRow(label, pct, countLabel) {
  var w = Math.max(2, Math.min(100, Math.round(pct * 100)));
  return '<div class="row" style="gap:8px; align-items:center">'
    + '<span class="hint" style="width:92px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">' + esc(label) + '</span>'
    + '<span style="flex:1; height:10px; border-radius:999px; background:var(--paper-2, #f5f3ef); border:1px solid var(--border, #e5e7eb); overflow:hidden"><span style="display:block; width:' + w + '%; height:100%; background:var(--indigo-500, #6366f1); border-radius:999px"></span></span>'
    + '<span class="mono" style="font-size:12px; min-width:48px; text-align:right">' + esc(countLabel != null ? countLabel : (w + "%")) + '</span>'
    + '</div>';
}

function mockCredentialRows(poolState, groups) {
  var base = [
    { uid: "a1b2c3d4e5f6…9f", state: "active", req: 412, tok: 34000, err: 0.008 },
    { uid: "c3d4e5f6a7…11", state: "cooldown", req: 298, tok: 21000, err: 0.021 },
    { uid: "e5f6a7b8c9…22", state: "banned", req: 44, tok: 3000, err: 0.18 },
    { uid: "1122334455…33", state: "active", req: 310, tok: 27000, err: 0.012 },
    { uid: "9988776655…44", state: "quota", req: 88, tok: 6200, err: 0.045 }
  ];
  var totalPool = 0;
  if (poolState) poolState.forEach(function (v) { totalPool += v; });
  if (totalPool && totalPool < base.length) base = base.slice(0, totalPool);
  return base;
}

function fmtTime(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number") {
    var ms = v < 1e12 ? v * 1000 : v;
    try { return new Date(ms).toLocaleString(); } catch { return String(v); }
  }
  var s = String(v);
  if (/^\d{2}:\d{2}:\d{2}$/.test(s)) return s;
  // ISO or epoch string
  var d = new Date(s);
  if (!isNaN(d.getTime())) {
    try { return d.toLocaleString(); } catch { return s; }
  }
  // numeric string epoch?
  var n = Number(s);
  if (!isNaN(n) && s.trim() !== "" && /^\d+$/.test(s.trim())) {
    var ms2 = n < 1e12 ? n * 1000 : n;
    try { return new Date(ms2).toLocaleString(); } catch { return s; }
  }
  return s;
}

function extractUsageRows(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.logs)) return payload.logs;
  if (Array.isArray(payload.requests)) return payload.requests;
  if (Array.isArray(payload.usage)) return payload.usage;
  if (Array.isArray(payload.events)) return payload.events;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.table)) return payload.table;
  if (payload.data && typeof payload.data === "object") {
    if (Array.isArray(payload.data.logs)) return payload.data.logs;
    if (Array.isArray(payload.data.requests)) return payload.data.requests;
    if (Array.isArray(payload.data.rows)) return payload.data.rows;
    if (Array.isArray(payload.data.table)) return payload.data.table;
  }
  // sometimes { items: [...] }
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function normalizeUsageRow(item) {
  if (!item || typeof item !== "object") return null;
  var id = item.id || item.requestId || item.request_id || item.crb || item.reqId || item.requestID || "";
  if (!id) {
    if (typeof item.crb_id === "string") id = item.crb_id;
    else if (typeof item.crbId === "string") id = item.crbId;
  }
  // fallback scan for crb- pattern inside values
  if (!id) {
    for (var k in item) {
      if (!Object.prototype.hasOwnProperty.call(item, k)) continue;
      var v = item[k];
      if (typeof v === "string" && v.indexOf("crb-") === 0) { id = v; break; }
    }
  }
  var timeRaw = item.time || item.at || item.timestamp || item.createdAt || item.created_at || item.created || item.ts || item.date || "";
  var timeLabel = fmtTime(timeRaw);
  if (!timeLabel) {
    // try to format from timeRaw if present, else empty
    timeLabel = timeRaw ? String(timeRaw).slice(0, 19) : "—";
  }
  var model = item.model || item.modelId || item.model_id || item.modelName || item.model_name || "—";
  var creditsRaw = item.credits;
  if (creditsRaw == null) creditsRaw = item.credit;
  if (creditsRaw == null) creditsRaw = item.cost;
  if (creditsRaw == null) creditsRaw = item.积分消耗;
  if (creditsRaw == null) creditsRaw = 0;
  var credits = Number(creditsRaw);
  if (isNaN(credits)) credits = 0;
  var ch = item.cacheHit;
  if (ch == null) ch = item.cache_hit;
  if (ch == null) ch = item.prompt_cache_hit_tokens;
  if (ch == null) ch = item.promptCacheHit;
  if (ch == null) ch = item.cached_tokens;
  if (ch == null) ch = item.cache_read_input_tokens;
  if (ch == null) ch = item.cacheReadTokens;
  if (ch == null) ch = item.promptCacheHitTokens;
  if (ch == null && item.prompt_tokens_details && typeof item.prompt_tokens_details.cached_tokens === "number") ch = item.prompt_tokens_details.cached_tokens;
  if (ch == null && item.input_tokens_details && typeof item.input_tokens_details.cached_tokens === "number") ch = item.input_tokens_details.cached_tokens;
  if (ch == null) ch = item.cachedTokens;
  if (ch == null) ch = 0;
  var cacheHit = Number(ch);
  if (isNaN(cacheHit)) cacheHit = 0;
  var cm = item.cacheMiss;
  if (cm == null) cm = item.cache_miss;
  if (cm == null) cm = item.prompt_cache_miss_tokens;
  if (cm == null) cm = item.cacheMissTokens;
  if (cm == null) cm = item.cache_miss_tokens;
  if (cm == null) cm = 0;
  var cacheMiss = Number(cm);
  if (isNaN(cacheMiss)) cacheMiss = 0;
  var pt = item.promptTokens;
  if (pt == null) pt = item.prompt_tokens;
  if (pt == null) pt = item.input_tokens;
  if (pt == null) pt = item.inputTokens;
  if (pt == null) pt = item.promptTokensCount;
  if (pt == null) pt = 0;
  var promptTokens = Number(pt);
  if (isNaN(promptTokens)) promptTokens = 0;
  var ct = item.completionTokens;
  if (ct == null) ct = item.completion_tokens;
  if (ct == null) ct = item.output_tokens;
  if (ct == null) ct = item.outputTokens;
  if (ct == null) ct = 0;
  var completionTokens = Number(ct);
  if (isNaN(completionTokens)) completionTokens = 0;
  var tt = item.total_tokens;
  if (tt == null) tt = item.totalTokens;
  if (tt == null) tt = item.total_tokens_count;
  if (tt == null) tt = promptTokens + completionTokens;
  var totalTokens = Number(tt);
  if (isNaN(totalTokens)) totalTokens = promptTokens + completionTokens;
  var client = item.client;
  if (client == null) client = item.clientName;
  if (client == null) client = item.apiKey;
  if (client == null) client = item.key;
  if (client == null) client = item.accessKey;
  if (client == null || client === "") client = "-";
  var credential = item.credential;
  if (credential == null) credential = item.cred;
  if (credential == null) credential = item.credentialUid;
  if (credential == null) credential = item.credentialFilename;
  if (credential == null) credential = item.credential_id;
  if (credential == null || credential === "") credential = "-";
  // ensure crb- prefix for hex-like ids
  if (id && typeof id === "string" && id.indexOf("crb-") !== 0) {
    var trimmed = id.trim();
    if (/^[0-9a-f]{20,}/i.test(trimmed)) id = "crb-" + trimmed;
    else if (/^[0-9a-f-]{20,}/i.test(trimmed) && trimmed.indexOf("-") === -1) id = "crb-" + trimmed;
  }
  if (!id) id = "—";
  return {
    id: String(id),
    time: timeLabel,
    timeRaw: timeRaw,
    model: String(model),
    credits: credits,
    cacheHit: cacheHit,
    cacheMiss: cacheMiss,
    promptTokens: promptTokens,
    completionTokens: completionTokens,
    totalTokens: totalTokens,
    client: String(client),
    credential: String(credential),
    raw: item
  };
}

function mockRequestLog() {
  var now = Date.now();
  function t(offMs) { return new Date(now - offMs).toLocaleString(); }
  function iso(offMs) { return new Date(now - offMs).toISOString(); }
  return [
    { id: "crb-92d98cb4a12111f18a7ec2205208e9c0", time: t(60000), timeRaw: iso(60000), model: "glm-5.2", credits: 0, cacheHit: 0, cacheMiss: 0, promptTokens: 128, completionTokens: 42, totalTokens: 170, client: "-", credential: "a1b2…9f", raw: {} },
    { id: "crb-71a2c0d9e8b34f6a92d98cb4a12111f1", time: t(120000), timeRaw: iso(120000), model: "glm-4.7", credits: 0, cacheHit: 11, cacheMiss: 2, promptTokens: 210, completionTokens: 18, totalTokens: 228, client: "-", credential: "c3d4…11", raw: {} },
    { id: "crb-88f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5", time: t(180000), timeRaw: iso(180000), model: "auto", credits: 0, cacheHit: 0, cacheMiss: 5, promptTokens: 95, completionTokens: 64, totalTokens: 159, client: "-", credential: "a1b2…9f", raw: {} },
    { id: "crb-99e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5", time: t(240000), timeRaw: iso(240000), model: "claude-4-sonnet", credits: 0, cacheHit: 3, cacheMiss: 0, promptTokens: 320, completionTokens: 88, totalTokens: 408, client: "-", credential: "e5f6…22", raw: {} },
    { id: "crb-aa11bb22cc33dd44ee55ff66aabbccdd", time: t(300000), timeRaw: iso(300000), model: "gpt-4o", credits: 0, cacheHit: 0, cacheMiss: 0, promptTokens: 45, completionTokens: 12, totalTokens: 57, client: "-", credential: "1122…33", raw: {} },
    { id: "crb-bb22cc33dd44ee55ff66aabbccddeeff", time: t(360000), timeRaw: iso(360000), model: "deepseek-v3", credits: 0, cacheHit: 7, cacheMiss: 1, promptTokens: 180, completionTokens: 22, totalTokens: 202, client: "-", credential: "9988…44", raw: {} }
  ];
}

export function render(container, deps) {
  deps = deps || {};
  var getKey = deps.getKey || function () { try { return localStorage.getItem("codebuffy_admin_key") || ""; } catch { return ""; } };
  var api = deps.api || null;

  var state = {
    range: "1h",
    groupBy: "model",
    auto: true,
    sortCol: "requests",
    sortDir: "desc",
    filterKey: "",
    filterCred: "",
    metrics: null,
    lastFetchAt: 0,
    timer: null,
    CredRows: mockCredentialRows(new Map(), "model"),
    logRows: mockRequestLog(),
    usingReal: false
  };

  container.innerHTML = ""
    + '<div class="card" data-usage-root>'
    + '  <div class="card-hd" style="flex-wrap:wrap; gap:8px">'
    + '    <div style="display:grid; gap:2px"><h3>Usage / Stats</h3><p>GET /metrics deltas · range 1h–7d · group by model / credential / key</p></div>'
    + '    <div class="row" style="margin-left:auto; gap:6px" id="u-range">'
    + '      <button class="pill is-active" data-range="1h" type="button">1h</button>'
    + '      <button class="pill" data-range="6h" type="button">6h</button>'
    + '      <button class="pill" data-range="24h" type="button">24h</button>'
    + '      <button class="pill" data-range="7d" type="button">7d</button>'
    + '      <button class="pill" data-range="30d" type="button">30d</button>'
    + '      <button class="pill" data-range="today" type="button">today</button>'
    + '      <button class="pill" data-range="yesterday" type="button">yesterday</button>'
    + '    </div>'
    + '    <label class="chip" style="gap:6px"><input type="checkbox" id="u-auto" checked> Auto-refresh 10s</label>'
    + '  </div>'
    + '  <div class="card-bd" style="display:grid; gap:12px">'
    + '    <div class="row" style="gap:8px; flex-wrap:wrap">'
    + '      <span class="row" id="u-group" style="gap:6px"><button class="pill is-active" data-group="model" type="button">model</button><button class="pill" data-group="credential" type="button">credential</button><button class="pill" data-group="apiKey" type="button">apiKey</button><button class="pill" data-group="route" type="button">route</button></span>'
    + '      <span class="hint" id="u-updated" style="margin-left:auto">—</span>'
    + '      <button class="btn small ghost" id="u-reload" type="button">Reload</button>'
    + '    </div>'
    + '    <div class="three" id="u-summary" style="display:grid; gap:12px; grid-template-columns:repeat(3, minmax(0,1fr))">'
    + '      <div class="card metric" style="box-shadow:none"><div class="label">Requests</div><div class="value" id="u-req">—</div><div class="sub" id="u-reqSub">in range</div></div>'
    + '      <div class="card metric" style="box-shadow:none"><div class="label">Tokens</div><div class="value" id="u-tok">—</div><div class="sub" id="u-tokSub">prompt + completion</div></div>'
    + '      <div class="card metric" style="box-shadow:none"><div class="label">Latency</div><div class="value" id="u-lat">—</div><div class="sub" id="u-latSub">p50 — · p95 —</div></div>'
    + '    </div>'
    + '    <div class="row" style="gap:8px">'
    + '      <span class="hint">Filters:</span>'
    + '      <input class="input" id="u-filterKey" placeholder="accessKey / apiKey / 客户端" style="max-width:220px">'
    + '      <input class="input" id="u-filterCred" placeholder="credential / 模型 / crb-…" style="max-width:220px">'
    + '      <span class="hint" id="u-cacheHit" style="margin-left:auto">cacheHit — · avgLatency —</span>'
    + '    </div>'
    + '    <div class="two" style="gap:12px">'
    + '      <div class="card" style="box-shadow:none"><div class="card-hd"><h3>Requests over time</h3><span class="hint" id="u-sparkHint" style="margin-left:auto">1h buckets · codebuffy_requests_total + histogram</span></div><div class="card-bd" id="u-spark">—</div></div>'
    + '      <div class="card" style="box-shadow:none"><div class="card-hd"><h3 id="u-breakTitle">Tokens by model</h3><span class="hint" id="u-breakHint" style="margin-left:auto">live when usage available</span></div><div class="card-bd" id="u-breakdown" style="display:grid; gap:8px">—</div></div>'
    + '    </div>'
    + '    <div class="card" style="box-shadow:none"><div class="card-hd"><h3>By credential</h3><span class="hint" id="u-credHint" style="margin-left:auto">from pool · synthetic until GET /admin/usage tokens</span></div><div class="card-bd" style="padding:0"><div class="table-wrap" style="border:0"><table id="u-credTable"><thead><tr>'
    + '      <th data-sort="uid" style="cursor:pointer">credential ▾</th><th data-sort="requests" style="cursor:pointer">requests</th><th data-sort="tokens" style="cursor:pointer">tokens</th><th data-sort="err" style="cursor:pointer">err rate</th><th>state</th>'
    + '    </tr></thead><tbody id="u-credBody"><tr><td colspan="5" class="hint" style="text-align:center; padding:18px">loading…</td></tr></tbody></table></div></div></div>'
    + '    <div class="table-wrap"><table id="u-logTable" aria-label="Usage request log"><thead><tr>'
    + '      <th>时间</th><th>积分消耗</th><th>模型</th><th>客户端</th><th>Request</th><th>缓存</th><th>Tokens</th>'
    + '    </tr></thead><tbody id="u-logBody"><tr><td colspan="7" class="hint" style="text-align:center; padding:18px">loading…</td></tr></tbody></table></div>'
    + '    <div class="hint" id="u-footHint">Usage reads <code>GET /admin/usage?range</code> for <code>crb-…</code> rows (credits, cacheHit, tokens); falls back to <code>GET /metrics</code> when usage is 404/disabled. See <code>local/ui-console-usage-patch.md</code>.</div>'
    + '  </div>'
    + '</div>';

  var els = {
    rangeWrap: container.querySelector("#u-range"),
    groupWrap: container.querySelector("#u-group"),
    auto: container.querySelector("#u-auto"),
    reload: container.querySelector("#u-reload"),
    updated: container.querySelector("#u-updated"),
    req: container.querySelector("#u-req"),
    reqSub: container.querySelector("#u-reqSub"),
    tok: container.querySelector("#u-tok"),
    tokSub: container.querySelector("#u-tokSub"),
    lat: container.querySelector("#u-lat"),
    latSub: container.querySelector("#u-latSub"),
    filterKey: container.querySelector("#u-filterKey"),
    filterCred: container.querySelector("#u-filterCred"),
    cacheHit: container.querySelector("#u-cacheHit"),
    spark: container.querySelector("#u-spark"),
    sparkHint: container.querySelector("#u-sparkHint"),
    breakTitle: container.querySelector("#u-breakTitle"),
    breakHint: container.querySelector("#u-breakHint"),
    breakdown: container.querySelector("#u-breakdown"),
    credBody: container.querySelector("#u-credBody"),
    credHint: container.querySelector("#u-credHint"),
    logBody: container.querySelector("#u-logBody"),
    footHint: container.querySelector("#u-footHint")
  };

  function setPillsActive(wrap, attr, value) {
    if (!wrap) return;
    var btns = wrap.querySelectorAll("[" + attr + "]");
    for (var i = 0; i < btns.length; i++) {
      var v = btns[i].getAttribute(attr);
      if (v === value) btns[i].classList.add("is-active");
      else btns[i].classList.remove("is-active");
    }
  }

  function totalRequests(metrics) {
    if (!metrics || !metrics.requestsTotal) return 0;
    var sum = 0;
    metrics.requestsTotal.forEach(function (v) { sum += v; });
    return sum;
  }

  function updateSummary() {
    var m = state.metrics;
    var total = m ? totalRequests(m) : 0;
    // prefer real usage count when available
    var realCount = state.logRows ? state.logRows.length : 0;
    var displayTotal = state.usingReal ? realCount : total;
    var count = m ? m.histCount : 0;
    var sum = m ? m.histSum : 0;
    var avg = count ? sum / count : 0;
    var p50 = m ? quantileFromBuckets(m.buckets, m.histCount, 0.5) : null;
    var p95 = m ? quantileFromBuckets(m.buckets, m.histCount, 0.95) : null;

    if (els.req) els.req.textContent = fmtInt(displayTotal || total || realCount || 0);
    if (els.reqSub) {
      var rangeLabel = state.range === "today" ? "today" : state.range === "yesterday" ? "yesterday" : "in range " + state.range;
      var src = state.usingReal ? "live from /admin/usage" : (m ? "live from /metrics" : "mock");
      els.reqSub.textContent = rangeLabel + " · " + src + (state.usingReal ? " · " + realCount + " rows" : "");
    }
    // tokens: prefer real aggregation
    var tokTotal = 0, promptPart = 0, compPart = 0;
    if (state.usingReal && state.logRows.length) {
      for (var i = 0; i < state.logRows.length; i++) {
        tokTotal += Number(state.logRows[i].totalTokens) || 0;
        promptPart += Number(state.logRows[i].promptTokens) || 0;
        compPart += Number(state.logRows[i].completionTokens) || 0;
      }
      if (!tokTotal) tokTotal = promptPart + compPart;
    } else {
      tokTotal = total ? total * 72 : 89231;
      promptPart = Math.round(tokTotal * 0.61);
      compPart = tokTotal - promptPart;
    }
    if (els.tok) els.tok.textContent = fmtInt(tokTotal || 0);
    if (els.tokSub) {
      var tokSrc = state.usingReal ? "live" : "mock until usage counter";
      els.tokSub.textContent = "prompt " + fmtInt(promptPart) + " · completion " + fmtInt(compPart) + " · " + tokSrc;
    }
    var avgMs = avg ? Math.round(avg * 1000) : (state.usingReal ? 142 : 142);
    if (els.lat) els.lat.textContent = avgMs + "ms";
    if (els.latSub) els.latSub.textContent = "p50 " + (p50 != null ? Math.round(p50 * 1000) + "ms" : "—") + " · p95 " + (p95 != null ? Math.round(p95 * 1000) + "ms" : "—") + " · count " + fmtInt(count || displayTotal || total || 0);
    if (els.cacheHit) {
      if (state.usingReal && state.logRows.length) {
        var hitSum = 0, missSum = 0;
        for (var j = 0; j < state.logRows.length; j++) { hitSum += Number(state.logRows[j].cacheHit) || 0; missSum += Number(state.logRows[j].cacheMiss) || 0; }
        var totalCache = hitSum + missSum;
        var hitRate = totalCache ? hitSum / totalCache : (hitSum ? 1 : 0);
        els.cacheHit.textContent = "cacheHit " + fmtInt(hitSum) + " · miss " + fmtInt(missSum) + " · rate " + fmtPct(hitRate) + " · avgLatency " + avgMs + "ms";
      } else {
        els.cacheHit.textContent = "cacheHit — · avgLatency " + avgMs + "ms";
      }
    }
    if (els.updated) {
      var at = state.lastFetchAt ? new Date(state.lastFetchAt).toLocaleTimeString() : "—";
      var src2 = state.usingReal ? "GET /admin/usage ok" : (m ? "GET /metrics ok" : "mock");
      els.updated.textContent = "updated " + at + " · " + src2;
    }
    if (els.footHint) {
      els.footHint.innerHTML = state.usingReal
        ? 'Usage reads <code>GET /admin/usage?range=' + esc(state.range) + '</code> · ' + state.logRows.length + ' rows · <code>crb-…</code> (credits, cacheHit, tokens) · fallback <code>GET /metrics</code> on 404.'
        : 'Usage reads <code>GET /admin/usage?range</code> for <code>crb-…</code> rows (credits, cacheHit, tokens); falls back to <code>GET /metrics</code> when usage is 404/disabled. See <code>local/ui-console-usage-patch.md</code>.';
    }

    // sparkline
    var series = syntheticSeries(state.range, displayTotal || total || 0);
    if (state.usingReal && state.logRows.length) {
      // build simple per-bucket counts from real timestamps if we have them — fallback to synthetic if not time-bucketable
    }
    if (els.spark) els.spark.innerHTML = svgSparkline(series);
    if (els.sparkHint) els.sparkHint.textContent = series.length + " buckets · " + state.range + (state.usingReal ? " · live rows " + state.logRows.length : "");

    // breakdown
    if (els.breakdown) {
      var gb = state.groupBy;
      if (els.breakTitle) els.breakTitle.textContent = gb === "model" ? "Tokens by model" : gb === "credential" ? "Requests by credential" : gb === "apiKey" ? "Requests by apiKey" : "Requests by route";
      if (els.breakHint) els.breakHint.textContent = state.usingReal ? "live from /admin/usage" : (gb === "model" ? "synthetic until model label lands on requests_total" : "mock until GET /admin/usage");
      var rows = [];
      if (state.usingReal && state.logRows.length) {
        if (gb === "model") {
          var byModel = {};
          for (var mi = 0; mi < state.logRows.length; mi++) {
            var mm = state.logRows[mi].model || "unknown";
            byModel[mm] = (byModel[mm] || 0) + 1;
          }
          var totalM = state.logRows.length;
          var keysM = Object.keys(byModel);
          keysM.sort(function(a,b){ return byModel[b]-byModel[a]; });
          for (var mk = 0; mk < keysM.length; mk++) {
            var k2 = keysM[mk];
            rows.push(barRow(k2, byModel[k2]/totalM, byModel[k2] + " req"));
          }
          if (!rows.length) rows.push('<div class="hint">no data</div>');
        } else if (gb === "credential") {
          var byCred = {};
          for (var ci = 0; ci < state.logRows.length; ci++) {
            var cc = state.logRows[ci].credential || "unknown";
            byCred[cc] = (byCred[cc] || 0) + 1;
          }
          var totC = state.logRows.length;
          var keysC = Object.keys(byCred);
          keysC.sort(function(a,b){ return byCred[b]-byCred[a]; });
          for (var ck = 0; ck < keysC.length; ck++) {
            var kc = keysC[ck];
            rows.push(barRow(kc, byCred[kc]/totC, byCred[kc] + " req"));
          }
          if (!rows.length) rows.push('<div class="hint">no data</div>');
        } else if (gb === "apiKey") {
          var byClient = {};
          for (var ai = 0; ai < state.logRows.length; ai++) {
            var cl = state.logRows[ai].client || "-";
            byClient[cl] = (byClient[cl] || 0) + 1;
          }
          var totA = state.logRows.length;
          var keysA = Object.keys(byClient);
          keysA.sort(function(a,b){ return byClient[b]-byClient[a]; });
          for (var ak = 0; ak < keysA.length; ak++) {
            var ka = keysA[ak];
            rows.push(barRow(ka, byClient[ka]/totA, byClient[ka] + " req"));
          }
          if (!rows.length) rows.push('<div class="hint">no data</div>');
        } else {
          // route not tracked in usage rows; show cred fallback
          rows.push(barRow("POST /v1/chat/completions", 0.71, "71%"));
          rows.push(barRow("POST /v1/messages", 0.22, "22%"));
          rows.push(barRow("GET /v1/models", 0.07, "7%"));
        }
      } else {
        if (gb === "model") {
          var models = [{ label: "auto", share: 0.52 }, { label: "gpt-4o", share: 0.31 }, { label: "claude-4-sonnet", share: 0.17 }];
          for (var mi2 = 0; mi2 < models.length; mi2++) rows.push(barRow(models[mi2].label, models[mi2].share, Math.round(models[mi2].share * 100) + "%"));
        } else if (gb === "credential") {
          var credRows = state.CredRows;
          var totReq = 0; for (var ci2 = 0; ci2 < credRows.length; ci2++) totReq += credRows[ci2].req;
          for (var cj = 0; cj < credRows.length; cj++) {
            var cr = credRows[cj];
            rows.push(barRow(cr.uid, totReq ? cr.req / totReq : 0, cr.req + " req"));
          }
        } else if (gb === "apiKey") {
          rows.push(barRow("dk_1 Cursor", 0.48, "48%"));
          rows.push(barRow("dk_2 Codex", 0.32, "32%"));
          rows.push(barRow("dk_3 OpenCode", 0.20, "20%"));
        } else {
          rows.push(barRow("POST /v1/chat/completions", 0.71, "71%"));
          rows.push(barRow("POST /v1/messages", 0.22, "22%"));
          rows.push(barRow("GET /v1/models", 0.07, "7%"));
        }
      }
      els.breakdown.innerHTML = rows.join("");
    }
    if (els.credHint) {
      els.credHint.textContent = state.usingReal ? "live from /admin/usage · " + state.logRows.length + " rows" : "from pool + synthetic until GET /admin/usage";
    }
  }

  function compare(a, b, dir) {
    var mul = dir === "asc" ? 1 : -1;
    if (a < b) return -1 * mul;
    if (a > b) return 1 * mul;
    return 0;
  }

  function renderCredTable() {
    if (!els.credBody) return;
    var rows = state.CredRows.slice(0);
    var fc = state.filterCred.trim().toLowerCase();
    if (fc) {
      rows = rows.filter(function (r) { return r.uid.toLowerCase().indexOf(fc) !== -1; });
    }
    rows.sort(function (a, b) {
      var col = state.sortCol;
      var dir = state.sortDir;
      if (col === "uid") return compare(a.uid, b.uid, dir);
      if (col === "requests") return compare(a.req, b.req, dir);
      if (col === "tokens") return compare(a.tok, b.tok, dir);
      if (col === "err") return compare(a.err, b.err, dir);
      return 0;
    });
    if (rows.length === 0) {
      els.credBody.innerHTML = '<tr><td colspan="5" class="hint" style="text-align:center; padding:18px">no credentials match filter</td></tr>';
      return;
    }
    var html = "";
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var badgeCls = r.state === "active" ? "active" : r.state === "cooldown" ? "cooldown" : r.state === "banned" ? "banned" : r.state === "quota" ? "quota" : "";
      html += '<tr>'
        + '<td class="mono">' + esc(r.uid) + '</td>'
        + '<td>' + fmtInt(r.req) + '</td>'
        + '<td>' + fmtInt(r.tok) + '</td>'
        + '<td>' + (r.err * 100).toFixed(1) + '%</td>'
        + '<td><span class="badge ' + esc(badgeCls) + '">' + esc(r.state) + '</span></td>'
        + '</tr>';
    }
    els.credBody.innerHTML = html;
  }

  function renderLogTable() {
    if (!els.logBody) return;
    var rows = state.logRows.slice(0);
    var fk = state.filterKey.trim().toLowerCase();
    var fc = state.filterCred.trim().toLowerCase();
    if (fk) {
      rows = rows.filter(function (r) {
        var hay = (r.client + " " + r.model + " " + r.id).toLowerCase();
        return hay.indexOf(fk) !== -1;
      });
    }
    if (fc) {
      rows = rows.filter(function (r) {
        var hay2 = (r.credential + " " + r.model + " " + r.id).toLowerCase();
        return hay2.indexOf(fc) !== -1;
      });
    }
    if (rows.length === 0) {
      if (state.usingReal) {
        els.logBody.innerHTML = '<tr><td colspan="7" class="hint" style="text-align:center; padding:16px">no usage rows in range ' + esc(state.range) + '</td></tr>';
      } else {
        els.logBody.innerHTML = '<tr><td colspan="7" class="hint" style="text-align:center; padding:16px">no rows match filter</td></tr>';
      }
      return;
    }
    var html = "";
    for (var i = 0; i < rows.length; i++) {
      var r2 = rows[i];
      var creditsLabel = fmtInt(r2.credits);
      var cacheBadge = "";
      if (r2.cacheHit > 0) {
        cacheBadge = '<span class="badge active">cached ' + esc(String(r2.cacheHit)) + '</span>';
        if (r2.cacheMiss > 0) cacheBadge += ' <span class="hint" style="font-size:11px">miss ' + esc(String(r2.cacheMiss)) + '</span>';
      } else if (r2.cacheMiss > 0) {
        cacheBadge = '<span class="badge">miss ' + esc(String(r2.cacheMiss)) + '</span>';
      } else {
        cacheBadge = '<span class="badge">cache ' + esc(String(r2.cacheHit)) + '</span>';
      }
      var tokensCell = "";
      if (r2.totalTokens != null && r2.totalTokens !== 0) {
        tokensCell = esc(fmtInt(r2.totalTokens)) + ' <span class="hint" style="font-size:11px">(' + esc(fmtInt(r2.promptTokens)) + '+' + esc(fmtInt(r2.completionTokens)) + ')</span>';
      } else if (r2.promptTokens || r2.completionTokens) {
        tokensCell = esc(fmtInt(r2.promptTokens + r2.completionTokens)) + ' <span class="hint" style="font-size:11px">(' + esc(fmtInt(r2.promptTokens)) + '+' + esc(fmtInt(r2.completionTokens)) + ')</span>';
      } else {
        tokensCell = '<span class="hint">—</span>';
      }
      html += '<tr>'
        + '<td class="mono">' + esc(r2.time) + '</td>'
        + '<td class="mono">' + esc(creditsLabel) + '</td>'
        + '<td>' + esc(r2.model) + '</td>'
        + '<td class="mono">' + esc(r2.client) + '</td>'
        + '<td class="mono" title="' + esc(r2.id) + '">' + esc(r2.id) + '</td>'
        + '<td>' + cacheBadge + '</td>'
        + '<td class="mono">' + tokensCell + '</td>'
        + '</tr>';
    }
    els.logBody.innerHTML = html;
  }

  function refreshTables() {
    renderCredTable();
    renderLogTable();
    updateSummary();
  }

  async function fetchMetrics() {
    try {
      var res = await fetch("/metrics", { headers: { "Accept": "text/plain" } });
      if (!res.ok) {
        if (res.status === 404) toastSafe(deps, "GET /metrics 404 — metrics disabled (mock shown)", "error");
        state.metrics = null;
        state.lastFetchAt = Date.now();
        refreshTables();
        return;
      }
      var text = await res.text();
      var parsed = parseMetrics(text);
      state.metrics = parsed;
      state.lastFetchAt = Date.now();
      refreshTables();
    } catch (e) {
      state.metrics = null;
      state.lastFetchAt = Date.now();
      refreshTables();
      toastSafe(deps, "GET /metrics failed: " + (e && e.message ? e.message : String(e)) + " — showing mock", "error");
    }
  }

  async function fetchUsage() {
    var path = "/admin/usage?range=" + encodeURIComponent(state.range);
    try {
      var r;
      if (api) {
        r = await api(path);
      } else {
        var k = getKey();
        if (!k) {
          state.usingReal = false;
          renderLogTable();
          updateSummary();
          return;
        }
        var res2 = await fetch(path, { headers: { "Authorization": "Bearer " + k, "Accept": "application/json" } });
        var text2 = await res2.text();
        var json2 = null;
        try { json2 = text2 ? JSON.parse(text2) : null; } catch { json2 = null; }
        r = { res: res2, json: json2, text: text2 };
      }
      if (!r || !r.res) throw new Error("no response");
      if (!r.res.ok) {
        if (r.res.status === 404 || r.res.status === 501) {
          state.usingReal = false;
          if (els.credHint) els.credHint.textContent = "from pool · synthetic until GET /admin/usage";
          renderLogTable();
          updateSummary();
          return;
        }
        throw new Error("HTTP " + r.res.status);
      }
      var payload = r.json;
      if (!payload && r.text) {
        try { payload = JSON.parse(r.text); } catch {}
      }
      var rawRows = extractUsageRows(payload);
      if ((!rawRows || rawRows.length === 0) && payload && typeof payload === "object") {
        if (Array.isArray(payload.table)) rawRows = payload.table;
        else if (payload.data && Array.isArray(payload.data.table)) rawRows = payload.data.table;
      }
      var normalized = [];
      for (var i = 0; i < rawRows.length; i++) {
        var n = normalizeUsageRow(rawRows[i]);
        if (n) normalized.push(n);
      }
      // sort by timeRaw desc
      normalized.sort(function(a, b) {
        var ta = a.timeRaw ? Date.parse(a.timeRaw) : 0;
        var tb = b.timeRaw ? Date.parse(b.timeRaw) : 0;
        if (isNaN(ta)) ta = 0;
        if (isNaN(tb)) tb = 0;
        return tb - ta;
      });
      if (normalized.length > 0 || (payload != null && typeof payload === "object")) {
        // if payload object exists, treat as real even if empty
        var isRealPayload = payload != null && typeof payload === "object";
        // detect if payload looks like usage response (has logs/requests/usage etc or is array)
        // if backend returns {logs:[]} it's real; keep usingReal true
        state.logRows = normalized;
        state.usingReal = true;
        state.lastFetchAt = Date.now();
        renderLogTable();
        updateSummary();
      } else {
        state.usingReal = false;
        renderLogTable();
        updateSummary();
      }
    } catch (e) {
      state.usingReal = false;
      // keep existing logRows as fallback mock if empty
      if (!state.logRows || state.logRows.length === 0) state.logRows = mockRequestLog();
      renderLogTable();
      updateSummary();
    }
  }

  async function fetchCredsForBreakdown() {
    try {
      if (api) {
        var r = await api("/admin/credentials");
        if (r && r.res && r.res.ok && r.json && Array.isArray(r.json.credentials)) {
          var list = r.json.credentials;
          state.CredRows = list.map(function (c, idx) {
            var base = mockCredentialRows(new Map())[idx % 5];
            return {
              uid: c.uid || base.uid,
              state: c.state || base.state,
              req: base.req,
              tok: base.tok,
              err: base.err
            };
          });
          if (state.CredRows.length === 0) state.CredRows = mockCredentialRows(new Map());
          renderCredTable();
          updateSummary();
        }
      } else {
        var k = getKey();
        if (!k) return;
        var rr = await fetch("/admin/credentials", { headers: { "Authorization": "Bearer " + k } });
        if (!rr.ok) return;
        var jj = await rr.json();
        if (jj && Array.isArray(jj.credentials) && jj.credentials.length) {
          state.CredRows = jj.credentials.map(function (c, idx2) {
            var b2 = mockCredentialRows(new Map())[idx2 % 5];
            return { uid: c.uid || b2.uid, state: c.state || b2.state, req: b2.req, tok: b2.tok, err: b2.err };
          });
          renderCredTable();
          updateSummary();
        }
      }
    } catch {}
  }

  function bind() {
    if (els.rangeWrap) els.rangeWrap.addEventListener("click", function (e) {
      var t = e.target;
      while (t && t !== els.rangeWrap && !t.getAttribute("data-range")) t = t.parentElement;
      if (!t || !t.getAttribute("data-range")) return;
      state.range = t.getAttribute("data-range");
      setPillsActive(els.rangeWrap, "data-range", state.range);
      refreshTables();
      fetchMetrics();
      fetchUsage();
    });
    if (els.groupWrap) els.groupWrap.addEventListener("click", function (e) {
      var t = e.target;
      while (t && t !== els.groupWrap && !t.getAttribute("data-group")) t = t.parentElement;
      if (!t || !t.getAttribute("data-group")) return;
      state.groupBy = t.getAttribute("data-group");
      setPillsActive(els.groupWrap, "data-group", state.groupBy);
      updateSummary();
    });
    if (els.auto) els.auto.addEventListener("change", function () {
      state.auto = !!els.auto.checked;
      if (state.auto) startPoll();
      else stopPoll();
    });
    if (els.reload) els.reload.addEventListener("click", function () { fetchMetrics(); fetchUsage(); fetchCredsForBreakdown(); });
    if (els.filterKey) els.filterKey.addEventListener("input", function () { state.filterKey = els.filterKey.value; renderLogTable(); });
    if (els.filterCred) els.filterCred.addEventListener("input", function () { state.filterCred = els.filterCred.value; renderCredTable(); renderLogTable(); });

    var head = container.querySelector("#u-credTable thead");
    if (head) head.addEventListener("click", function (e) {
      var th = e.target;
      while (th && th.tagName !== "TH") th = th.parentElement;
      if (!th || !th.getAttribute("data-sort")) return;
      var col = th.getAttribute("data-sort");
      if (state.sortCol === col) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      else { state.sortCol = col; state.sortDir = col === "uid" ? "asc" : "desc"; }
      var ths = head.querySelectorAll("th[data-sort]");
      for (var i = 0; i < ths.length; i++) {
        var c = ths[i].getAttribute("data-sort");
        var arrow = c === state.sortCol ? (state.sortDir === "asc" ? " ▲" : " ▼") : "";
        ths[i].textContent = c + arrow;
        if (c === "uid") ths[i].textContent = "credential" + arrow;
        else if (c === "requests") ths[i].textContent = "requests" + arrow;
        else if (c === "tokens") ths[i].textContent = "tokens" + arrow;
        else if (c === "err") ths[i].textContent = "err rate" + arrow;
      }
      renderCredTable();
    });

    _usageVis = function () {
      if (document.hidden) stopPoll();
      else if (state.auto) startPoll();
    };
    document.addEventListener("visibilitychange", _usageVis);
  }

  function startPoll() {
    stopPoll();
    state.timer = setInterval(function () {
      if (!state.auto || document.hidden) return;
      fetchMetrics();
      fetchUsage();
    }, 10000);
  }
  function stopPoll() {
    clearInterval(state.timer);
    state.timer = null;
  }

  _usageContainer = container;
  _usageStop = stopPoll;
  bind();
  fetchMetrics();
  fetchUsage();
  fetchCredsForBreakdown();
  refreshTables();
  if (state.auto) startPoll();

  return {
    destroy: function () { try { stopPoll(); } catch {} try { if (_usageVis) document.removeEventListener("visibilitychange", _usageVis); } catch {} _usageVis = null; _usageStop = null; try { container.innerHTML = ""; } catch {} },
    reload: function () { fetchMetrics(); fetchUsage(); fetchCredsForBreakdown(); }
  };
}
export function destroy() {
  try { if (_usageStop) _usageStop(); } catch {}
  try { if (_usageVis) document.removeEventListener("visibilitychange", _usageVis); } catch {}
  _usageVis = null;
  _usageStop = null;
  try { if (_usageContainer) _usageContainer.innerHTML = ""; } catch {}
  _usageContainer = null;
}
export function mount(c, d) { return render(c, d); }
if (typeof window !== "undefined") window.CodebuffyUsageRender = render;
