/* eslint-disable @typescript-eslint/no-unused-vars */
/* Codebuffy Admin — Usage / Stats
 * Range 1h-7d/today/yesterday, charts by model/credential, sortable tables,
 * autoRefresh, filters accessKey/credential. Parses GET /metrics Prometheus text;
 * falls back to mock when parse not yet / metrics disabled.
 * No console.*, no external deps. ESM.
 */
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
    // codebuffy_requests_total{route="...",method="...",status="..."} 42
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
  var base = Math.max(4, Math.round((total || 120) / points));
  var arr = [];
  var seed = 0;
  for (var i = 0; i < points; i++) {
    // deterministic pseudo-random wobble based on i
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
  // area
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
  // produce 3–5 synthetic credential rows when real per-credential counters missing
  var base = [
    { uid: "a1b2c3d4e5f6…9f", state: "active", req: 412, tok: 34000, err: 0.008 },
    { uid: "c3d4e5f6a7…11", state: "cooldown", req: 298, tok: 21000, err: 0.021 },
    { uid: "e5f6a7b8c9…22", state: "banned", req: 44, tok: 3000, err: 0.18 },
    { uid: "1122334455…33", state: "active", req: 310, tok: 27000, err: 0.012 },
    { uid: "9988776655…44", state: "quota", req: 88, tok: 6200, err: 0.045 }
  ];
  // scale to pool size hint
  var totalPool = 0;
  if (poolState) poolState.forEach(function (v) { totalPool += v; });
  if (totalPool && totalPool < base.length) base = base.slice(0, totalPool);
  // if groupBy credential, keep as is; if model, we still show cred rows
  return base;
}

function mockRequestLog() {
  return [
    { time: "09:41:12", route: "POST /v1/chat/completions", model: "auto", cred: "a1b2…9f", key: "dk_1", status: 200, latency: 142 },
    { time: "09:41:08", route: "POST /v1/chat/completions", model: "auto", cred: "c3d4…11", key: "dk_1", status: 429, latency: 312 },
    { time: "09:40:55", route: "POST /v1/messages", model: "claude-4-sonnet", cred: "a1b2…9f", key: "dk_2", status: 200, latency: 980 },
    { time: "09:40:44", route: "POST /v1/chat/completions", model: "gpt-4o", cred: "e5f6…22", key: "dk_1", status: 403, latency: 210 },
    { time: "09:39:30", route: "GET /v1/models", model: "—", cred: "—", key: "dk_1", status: 200, latency: 18 },
    { time: "09:38:12", route: "POST /v1/responses", model: "auto", cred: "a1b2…9f", key: "dk_3", status: 200, latency: 165 }
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
    logRows: mockRequestLog()
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
    + '      <div class="card metric" style="box-shadow:none"><div class="label">Tokens</div><div class="value" id="u-tok">—</div><div class="sub" id="u-tokSub">prompt + completion (mock until usage counter)</div></div>'
    + '      <div class="card metric" style="box-shadow:none"><div class="label">Latency</div><div class="value" id="u-lat">—</div><div class="sub" id="u-latSub">p50 — · p95 —</div></div>'
    + '    </div>'
    + '    <div class="row" style="gap:8px">'
    + '      <span class="hint">Filters:</span>'
    + '      <input class="input" id="u-filterKey" placeholder="accessKey / apiKey prefix (e.g. dk_1)" style="max-width:220px">'
    + '      <input class="input" id="u-filterCred" placeholder="credential uid (e.g. a1b2…)" style="max-width:220px">'
    + '      <span class="hint" id="u-cacheHit" style="margin-left:auto">cacheHit — · avgLatency —</span>'
    + '    </div>'
    + '    <div class="two" style="gap:12px">'
    + '      <div class="card" style="box-shadow:none"><div class="card-hd"><h3>Requests over time</h3><span class="hint" id="u-sparkHint" style="margin-left:auto">1h buckets · codebuffy_requests_total + histogram</span></div><div class="card-bd" id="u-spark">—</div></div>'
    + '      <div class="card" style="box-shadow:none"><div class="card-hd"><h3 id="u-breakTitle">Tokens by model</h3><span class="hint" id="u-breakHint" style="margin-left:auto">mock until model label lands</span></div><div class="card-bd" id="u-breakdown" style="display:grid; gap:8px">—</div></div>'
    + '    </div>'
    + '    <div class="card" style="box-shadow:none"><div class="card-hd"><h3>By credential</h3><span class="hint" id="u-credHint" style="margin-left:auto">from pool + synthetic until GET /admin/usage</span></div><div class="card-bd" style="padding:0"><div class="table-wrap" style="border:0"><table id="u-credTable"><thead><tr>'
    + '      <th data-sort="uid" style="cursor:pointer">credential ▾</th><th data-sort="requests" style="cursor:pointer">requests</th><th data-sort="tokens" style="cursor:pointer">tokens</th><th data-sort="err" style="cursor:pointer">err rate</th><th>state</th>'
    + '    </tr></thead><tbody id="u-credBody"><tr><td colspan="5" class="hint" style="text-align:center; padding:18px">loading…</td></tr></tbody></table></div></div></div>'
    + '    <div class="table-wrap"><table id="u-logTable"><thead><tr>'
    + '      <th>time</th><th>route</th><th>model</th><th>credential</th><th>apiKey</th><th>status</th><th>latency</th>'
    + '    </tr></thead><tbody id="u-logBody"><tr><td colspan="7" class="hint" style="text-align:center; padding:18px">loading…</td></tr></tbody></table></div>'
    + '    <div class="hint">Usage today reads <code>GET /metrics</code> (Prometheus text) for <code>codebuffy_requests_total</code> + <code>codebuffy_request_duration_seconds_bucket</code> (0.005…5 +Inf). Breakdown by model/credential is synthetic in v1; wire to <code>GET /admin/usage?range&groupBy</code> when the aggregator exposes token counters. See <code>local/ui-console-usage-patch.md</code>.</div>'
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
    logBody: container.querySelector("#u-logBody")
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
    var count = m ? m.histCount : 0;
    var sum = m ? m.histSum : 0;
    var avg = count ? sum / count : 0;
    var p50 = m ? quantileFromBuckets(m.buckets, m.histCount, 0.5) : null;
    var p95 = m ? quantileFromBuckets(m.buckets, m.histCount, 0.95) : null;

    if (els.req) els.req.textContent = fmtInt(total || 0);
    if (els.reqSub) els.reqSub.textContent = (state.range === "today" ? "today" : state.range === "yesterday" ? "yesterday" : "in range " + state.range) + " · " + (m ? "live from /metrics" : "mock");
    // tokens mock: derive from requests * avg tokens (synthetic)
    var tokTotal = total ? total * 72 : 89231;
    var promptPart = Math.round(tokTotal * 0.61);
    var compPart = tokTotal - promptPart;
    if (els.tok) els.tok.textContent = total ? fmtInt(tokTotal) : "89k";
    if (els.tokSub) els.tokSub.textContent = "prompt " + fmtInt(promptPart) + " · completion " + fmtInt(compPart) + " · mock until usage counter";
    var avgMs = avg ? Math.round(avg * 1000) : 142;
    if (els.lat) els.lat.textContent = avgMs + "ms";
    if (els.latSub) els.latSub.textContent = "p50 " + (p50 != null ? Math.round(p50 * 1000) + "ms" : "—") + " · p95 " + (p95 != null ? Math.round(p95 * 1000) + "ms" : "—") + " · count " + fmtInt(count || total || 0);
    if (els.cacheHit) {
      // cacheHit not yet a metric; show mock with note
      els.cacheHit.textContent = "cacheHit 23% (mock) · avgLatency " + avgMs + "ms";
    }
    if (els.updated) {
      var at = state.lastFetchAt ? new Date(state.lastFetchAt).toLocaleTimeString() : "—";
      els.updated.textContent = "updated " + at + " · GET /metrics " + (m ? "ok" : "mock");
    }

    // sparkline
    var series = syntheticSeries(state.range, total || 0);
    if (els.spark) els.spark.innerHTML = svgSparkline(series);
    if (els.sparkHint) els.sparkHint.textContent = series.length + " buckets · " + state.range;

    // breakdown
    if (els.breakdown) {
      var gb = state.groupBy;
      if (els.breakTitle) els.breakTitle.textContent = gb === "model" ? "Tokens by model" : gb === "credential" ? "Requests by credential" : gb === "apiKey" ? "Requests by apiKey" : "Requests by route";
      if (els.breakHint) els.breakHint.textContent = gb === "model" ? "synthetic until model label lands on requests_total" : "mock until GET /admin/usage";
      var rows = [];
      if (gb === "model") {
        var models = [{ label: "auto", share: 0.52 }, { label: "gpt-4o", share: 0.31 }, { label: "claude-4-sonnet", share: 0.17 }];
        for (var mi = 0; mi < models.length; mi++) rows.push(barRow(models[mi].label, models[mi].share, Math.round(models[mi].share * 100) + "%"));
      } else if (gb === "credential") {
        var credRows = state.CredRows;
        var totReq = 0; for (var ci = 0; ci < credRows.length; ci++) totReq += credRows[ci].req;
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
      els.breakdown.innerHTML = rows.join("");
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
    // filter
    var fk = state.filterKey.trim().toLowerCase();
    var fc = state.filterCred.trim().toLowerCase();
    if (fk) {
      // filter by apiKey not in cred rows; skip but keep hook for future
    }
    if (fc) {
      rows = rows.filter(function (r) { return r.uid.toLowerCase().indexOf(fc) !== -1; });
    }
    // sort
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
    if (fk) rows = rows.filter(function (r) { return String(r.key).toLowerCase().indexOf(fk) !== -1; });
    if (fc) rows = rows.filter(function (r) { return String(r.cred).toLowerCase().indexOf(fc) !== -1; });
    if (rows.length === 0) {
      els.logBody.innerHTML = '<tr><td colspan="7" class="hint" style="text-align:center; padding:16px">no rows match filter</td></tr>';
      return;
    }
    var html = "";
    for (var i = 0; i < rows.length; i++) {
      var r2 = rows[i];
      var badge = r2.status >= 200 && r2.status < 300 ? "active" : r2.status === 429 ? "quota" : r2.status === 403 ? "banned" : "";
      html += '<tr>'
        + '<td class="mono">' + esc(r2.time) + '</td>'
        + '<td>' + esc(r2.route) + '</td>'
        + '<td>' + esc(r2.model) + '</td>'
        + '<td class="mono">' + esc(r2.cred) + '</td>'
        + '<td class="mono">' + esc(r2.key) + '</td>'
        + '<td><span class="badge ' + esc(badge) + '">' + esc(String(r2.status)) + '</span></td>'
        + '<td class="mono">' + esc(String(r2.latency)) + 'ms</td>'
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
      // enrich credential rows from poolState if present
      if (parsed.poolState && parsed.poolState.size) {
        // keep mock shape but could adjust counts
      }
      refreshTables();
    } catch (e) {
      state.metrics = null;
      state.lastFetchAt = Date.now();
      refreshTables();
      toastSafe(deps, "GET /metrics failed: " + (e && e.message ? e.message : String(e)) + " — showing mock", "error");
    }
  }

  async function fetchCredsForBreakdown() {
    try {
      if (api) {
        var r = await api("/admin/credentials");
        if (r && r.res && r.res.ok && r.json && Array.isArray(r.json.credentials)) {
          var list = r.json.credentials;
          // map to rows but keep request counts synthetic until usage endpoint exists
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
    if (els.reload) els.reload.addEventListener("click", function () { fetchMetrics(); fetchCredsForBreakdown(); });
    if (els.filterKey) els.filterKey.addEventListener("input", function () { state.filterKey = els.filterKey.value; renderLogTable(); });
    if (els.filterCred) els.filterCred.addEventListener("input", function () { state.filterCred = els.filterCred.value; renderCredTable(); renderLogTable(); });

    // sortable cred table
    var head = container.querySelector("#u-credTable thead");
    if (head) head.addEventListener("click", function (e) {
      var th = e.target;
      while (th && th.tagName !== "TH") th = th.parentElement;
      if (!th || !th.getAttribute("data-sort")) return;
      var col = th.getAttribute("data-sort");
      if (state.sortCol === col) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      else { state.sortCol = col; state.sortDir = col === "uid" ? "asc" : "desc"; }
      // update header arrows
      var ths = head.querySelectorAll("th[data-sort]");
      for (var i = 0; i < ths.length; i++) {
        var c = ths[i].getAttribute("data-sort");
        var arrow = c === state.sortCol ? (state.sortDir === "asc" ? " ▲" : " ▼") : "";
        ths[i].textContent = c + arrow;
        // restore labels
        if (c === "uid") ths[i].textContent = "credential" + arrow;
        else if (c === "requests") ths[i].textContent = "requests" + arrow;
        else if (c === "tokens") ths[i].textContent = "tokens" + arrow;
        else if (c === "err") ths[i].textContent = "err rate" + arrow;
      }
      renderCredTable();
    });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) stopPoll();
      else if (state.auto) startPoll();
    });
  }

  function startPoll() {
    stopPoll();
    state.timer = setInterval(function () {
      if (!state.auto || document.hidden) return;
      fetchMetrics();
    }, 10000);
  }
  function stopPoll() {
    clearInterval(state.timer);
    state.timer = null;
  }

  bind();
  fetchMetrics();
  fetchCredsForBreakdown();
  refreshTables();
  if (state.auto) startPoll();

  return {
    destroy: function () { stopPoll(); container.innerHTML = ""; },
    reload: function () { fetchMetrics(); fetchCredsForBreakdown(); }
  };
}
export function mount(c, d) { return render(c, d); }
if (typeof window !== "undefined") window.CodebuffyUsageRender = render;
