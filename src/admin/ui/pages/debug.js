/* Codebuffy Admin — Debug / Logs
 * DebugLogEntry with upstreamRequest/Response + transformedResponse + usage tokens,
 * highlighter/collapse, MCP icon, route/model/key filters, tail GET /admin/requests? or GET /admin/logs,
 * raw JSON view, copy. Falls back to mock when endpoints 404.
 * No console.*, no external deps. ESM.
 */
let _debugStop = null;
let _debugVis = null;
let _debugContainer = null;
function esc(s) {
  var d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}
function safeJson(v, indent) { try { return JSON.stringify(v, null, indent || 2); } catch { return String(v); } }
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
  var t = setTimeout(function () { el.style.opacity = "0"; el.style.transition = "opacity 180ms"; setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200); }, kind === "error" ? 4200 : 2600);
  el.addEventListener("click", function () { clearTimeout(t); if (el.parentNode) el.parentNode.removeChild(el); });
}
function copyText(deps, text, okMsg) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toastSafe(deps, okMsg || "Copied", "ok"); }, function () { fallbackCopy(deps, text, okMsg); });
    } else fallbackCopy(deps, text, okMsg);
  } catch { fallbackCopy(deps, text, okMsg); }
}
function fallbackCopy(deps, text, okMsg) {
  try {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    toastSafe(deps, okMsg || "Copied", "ok");
  } catch { toastSafe(deps, "Copy failed", "error"); }
}
function fmtMs(ms) { if (ms == null || isNaN(ms)) return "—"; if (ms < 1000) return String(Math.round(ms)) + "ms"; return (ms / 1000).toFixed(2) + "s"; }

// highlighter: tokenizes json string into spans; simple but readable
function highlightJson(obj) {
  var json = safeJson(obj, 2);
  var html = esc(json)
    .replace(/(&quot;(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\&quot;])*&quot;(\s*:)?)/g, function (m) {
      var isKey = /:\s*$/.test(m);
      return '<span style="color:' + (isKey ? '#0f172a' : '#4338ca') + '; font-weight:' + (isKey ? '700' : '400') + '">' + m + '</span>';
    })
    .replace(/\b(true|false|null)\b/g, '<span style="color:#065f46">$1</span>')
    .replace(/\b(-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)\b/g, '<span style="color:#92400e">$1</span>');
  return html;
}

function mockEntries() {
  return [
    {
      id: "req_abc123",
      time: "09:41:08",
      at: Date.now() - 4000,
      route: "POST /v1/chat/completions",
      model: "auto",
      key: "dk_1",
      keyLabel: "Cursor",
      cred: "e5f6a7b8…22",
      credUid: "e5f6a7b8c9d0e1f2a3b4c5d6",
      status: 429,
      latencyMs: 312,
      mcp: false,
      downstreamRequest: { method: "POST", path: "/v1/chat/completions", body: { model: "auto", messages: [{ role: "user", content: "debug me" }], stream: false, temperature: 0.7 } },
      upstreamRequest: { method: "POST", url: "https://copilot.tencent.com/v2/completions", headers: { "X-No-Authorization": "true" }, body: { model: "auto", messages: [{ role: "user", content: "debug me" }], stream: false }, cred: "e5f6…22" },
      upstreamResponse: { status: 429, body: { code: 14018, message: "quota exhausted" }, elapsedMs: 312, code: 14018 },
      transformedResponse: { status: 429, body: { error: { type: "insufficient_quota", param: null, code: "14018", message: "quota exhausted" } }, breaker: "e5f6…22 → quota (sticky)" },
      usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 }
    },
    {
      id: "req_def456",
      time: "09:41:12",
      at: Date.now() - 1000,
      route: "POST /v1/chat/completions",
      model: "auto",
      key: "dk_1",
      keyLabel: "Cursor",
      cred: "a1b2c3d4…9f",
      credUid: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      status: 200,
      latencyMs: 142,
      mcp: true,
      downstreamRequest: { method: "POST", path: "/v1/chat/completions", body: { model: "auto", messages: [{ role: "user", content: "Hello — test the gateway" }], stream: true, temperature: 0.7 } },
      upstreamRequest: { method: "POST", url: "https://copilot.tencent.com/v2/completions", headers: { "X-No-Authorization": "true" }, body: { model: "auto", messages: [{ role: "user", content: "Hello — test the gateway" }], stream: true }, cred: "a1b2…9f" },
      upstreamResponse: { status: 200, body: { choices: [{ delta: { content: "Hello" } }, { delta: { content: " world" } }], usage: { prompt_tokens: 12, completion_tokens: 8 } }, elapsedMs: 142, code: 0 },
      transformedResponse: { status: 200, body: { id: "chatcmpl-xyz", choices: [{ message: { content: "Hello world" } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }, breaker: "—" },
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
    },
    {
      id: "req_ghi789",
      time: "09:40:55",
      at: Date.now() - 15000,
      route: "POST /v1/messages",
      model: "claude-4-sonnet",
      key: "dk_2",
      keyLabel: "Codex CLI",
      cred: "a1b2…9f",
      credUid: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      status: 200,
      latencyMs: 980,
      mcp: false,
      downstreamRequest: { method: "POST", path: "/v1/messages", body: { model: "claude-4-sonnet", max_tokens: 512, messages: [{ role: "user", content: "explain this trace" }], stream: false } },
      upstreamRequest: { method: "POST", url: "https://copilot.tencent.com/v2/messages", headers: {}, body: { model: "claude-4-sonnet", messages: [{ role: "user", content: "explain this trace" }] }, cred: "a1b2…9f" },
      upstreamResponse: { status: 200, body: { content: [{ type: "text", text: "This trace shows…" }], usage: { input_tokens: 18, output_tokens: 42 } }, elapsedMs: 980, code: 0 },
      transformedResponse: { status: 200, body: { id: "msg_xyz", content: [{ type: "text", text: "This trace shows…" }], usage: { input_tokens: 18, output_tokens: 42 } }, breaker: "—" },
      usage: { prompt_tokens: 18, completion_tokens: 42, total_tokens: 60 }
    },
    {
      id: "req_jkl012",
      time: "09:40:44",
      at: Date.now() - 30000,
      route: "POST /v1/chat/completions",
      model: "gpt-4o",
      key: "dk_1",
      keyLabel: "Cursor",
      cred: "112233…33",
      credUid: "11223344556677889900aabb",
      status: 403,
      latencyMs: 210,
      mcp: false,
      downstreamRequest: { method: "POST", path: "/v1/chat/completions", body: { model: "gpt-4o", messages: [{ role: "user", content: "forbidden" }], stream: false } },
      upstreamRequest: { method: "POST", url: "https://copilot.tencent.com/v2/completions", headers: {}, body: { model: "gpt-4o", messages: [{ role: "user", content: "forbidden" }] }, cred: "1122…33" },
      upstreamResponse: { status: 403, body: { code: 11140, message: "banned" }, elapsedMs: 210, code: 11140 },
      transformedResponse: { status: 403, body: { error: { type: "invalid_request_error", code: "11140", message: "banned" } }, breaker: "1122…33 → banned (sticky)" },
      usage: { prompt_tokens: 8, completion_tokens: 0, total_tokens: 8 }
    }
  ];
}

function mockLogs() {
  return [
    "09:41:12 info  [pool] selected a1b2…9f  cacheAffinity hit",
    "09:41:12 error [upstream] code=14018 quota exhausted  cred=e5f6…22",
    "09:41:12 warn  [breaker] e5f6…22 → quota (sticky)",
    "09:41:12 info  [pool] retry with a1b2…9f",
    "09:41:12 info  [request] POST /v1/chat/completions 200 142ms",
    "09:40:55 info  [request] POST /v1/messages 200 980ms model=claude-4-sonnet",
    "09:40:44 error [upstream] code=11140 banned  cred=1122…33",
    "09:40:44 warn  [breaker] 1122…33 → banned (sticky)"
  ];
}

export function render(container, deps) {
  deps = deps || {};
  var getKey = deps.getKey || function () { try { return localStorage.getItem("codebuffy_admin_key") || ""; } catch { return ""; } };
  var api = deps.api || null;

  var entries = mockEntries();
  var logs = mockLogs();
  var selectedId = entries[1] ? entries[1].id : entries[0].id;
  var filters = { route: "all", model: "all", key: "all", status: "all", q: "" };
  var live = true;
  var pollTimer = null;
  var rawMode = "pretty"; // pretty | raw
  var collapsed = { s1: false, s2: false, s3: false, s4: false };

  container.innerHTML = ""
    + '<div class="card" data-debug-root>'
    + '  <div class="card-hd" style="flex-wrap:wrap; gap:8px">'
    + '    <div style="display:grid; gap:2px"><h3>Debug / Logs</h3><p>4-step trace · route/model/key filters · raw pino tail</p></div>'
    + '    <span class="row" style="margin-left:auto; gap:6px">'
    + '      <span class="chip ok" id="d-liveChip"><span class="dot"></span> Live</span>'
    + '      <button class="btn small ghost" id="d-pause" type="button">Pause</button>'
    + '      <button class="btn small ghost" id="d-reload" type="button">Reload</button>'
    + '    </span>'
    + '  </div>'
    + '  <div class="card-bd" style="display:grid; gap:12px">'
    + '    <div class="filterbar" id="d-filters" style="gap:8px">'
    + '      <select class="select" id="d-route" aria-label="Route"><option value="all">Route: all</option><option value="POST /v1/chat/completions">POST /v1/chat/completions</option><option value="POST /v1/messages">POST /v1/messages</option><option value="POST /v1/responses">POST /v1/responses</option><option value="GET /v1/models">GET /v1/models</option></select>'
    + '      <select class="select" id="d-model" aria-label="Model"><option value="all">Model: all</option><option value="auto">auto</option><option value="gpt-4o">gpt-4o</option><option value="claude-4-sonnet">claude-4-sonnet</option></select>'
    + '      <select class="select" id="d-key" aria-label="Key"><option value="all">Key: all</option><option value="dk_1">dk_1 Cursor</option><option value="dk_2">dk_2 Codex</option><option value="dk_3">dk_3 OpenCode</option></select>'
    + '      <select class="select" id="d-status" aria-label="Status"><option value="all">Status: all</option><option value="200">200</option><option value="429">429</option><option value="403">403</option><option value="500">500</option></select>'
    + '      <input class="input" id="d-q" placeholder="Search requestId / uid / traceId …" style="max-width:220px">'
    + '      <span class="hint" id="d-count" style="margin-left:auto">—</span>'
    + '    </div>'
    + '    <div class="trace" id="d-trace" style="display:grid; gap:10px">'
    + '      <div class="step" data-step="1"><div class="step-hd" style="cursor:pointer" data-toggle="s1"><b>① Downstream request</b><span class="hint" style="margin-left:auto" id="d-s1-hd">—</span><span class="hint" id="d-s1-toggle">▾</span></div><pre class="step-bd" id="d-s1-bd" style="max-height:220px">—</pre></div>'
    + '      <div class="step" data-step="2"><div class="step-hd" style="cursor:pointer" data-toggle="s2"><b>② Upstream request (IR → CodeBuddy)</b><span class="hint" style="margin-left:auto" id="d-s2-hd">—</span><span class="hint" id="d-s2-toggle">▾</span></div><pre class="step-bd" id="d-s2-bd" style="max-height:220px">—</pre></div>'
    + '      <div class="step" data-step="3"><div class="step-hd" style="cursor:pointer" data-toggle="s3"><b>③ Upstream response</b><span class="hint" style="margin-left:auto" id="d-s3-hd">—</span><span class="hint" id="d-s3-toggle">▾</span></div><pre class="step-bd" id="d-s3-bd" style="max-height:220px">—</pre></div>'
    + '      <div class="step" data-step="4"><div class="step-hd" style="cursor:pointer" data-toggle="s4"><b>④ Downstream response (transformed)</b><span class="hint" style="margin-left:auto" id="d-s4-hd">—</span><span class="hint" id="d-s4-toggle">▾</span></div><pre class="step-bd" id="d-s4-bd" style="max-height:220px">—</pre></div>'
    + '      <div class="row" style="gap:6px">'
    + '        <button class="btn small" id="d-copyTrace" type="button">Copy trace</button>'
    + '        <button class="btn small" id="d-openConsole" type="button">Open in Console</button>'
    + '        <button class="btn small ghost" id="d-copyCurl" type="button">Copy curl</button>'
    + '        <button class="btn small ghost" id="d-rawToggle" type="button">Raw JSON</button>'
    + '        <span class="hint" id="d-usage" style="margin-left:auto">tokens —</span>'
    + '      </div>'
    + '    </div>'
    + '    <div class="two" style="gap:12px">'
    + '      <div class="card" style="box-shadow:none"><div class="card-hd"><h3>Requests</h3><span class="hint" id="d-reqHint" style="margin-left:auto">click to inspect · MCP <span style="display:inline-block; width:14px; height:14px; border-radius:4px; background:#f5f3ff; border:1px solid #ddd6fe; text-align:center; line-height:13px; font-size:10px">⬢</span></span></div><div class="card-bd" style="padding:0"><div class="table-wrap" style="border:0"><table><thead><tr><th>time</th><th>route</th><th>model</th><th>status</th><th>cred</th><th>mcp</th></tr></thead><tbody id="d-reqBody"></tbody></table></div></div></div>'
    + '      <div class="card" style="box-shadow:none"><div class="card-hd"><h3>Raw pino tail (200)</h3><span class="row" style="margin-left:auto; gap:6px"><button class="btn small ghost" id="d-copyLogs" type="button">Copy logs</button><button class="btn small ghost" id="d-clearLogs" type="button">Clear</button></span></div><div style="padding:12px"><pre class="log" id="d-log" role="log" aria-live="off" style="margin:0; max-height:260px"></pre></div></div>'
    + '    </div>'
    + '    <div class="hint">Debug talks to <code>GET /admin/requests?tail=200</code> and <code>GET /admin/logs?tail=200</code> when available; otherwise shows mock 4-step trace. Trace vocabulary matches <code>mapUpstreamErrorToHttp</code> (11140→403, 14018→429) and breaker sticky rules. Raw JSON view is highlight + collapse per step.</div>'
    + '  </div>'
    + '</div>';

  var els = {
    liveChip: container.querySelector("#d-liveChip"),
    pause: container.querySelector("#d-pause"),
    reload: container.querySelector("#d-reload"),
    route: container.querySelector("#d-route"),
    model: container.querySelector("#d-model"),
    key: container.querySelector("#d-key"),
    status: container.querySelector("#d-status"),
    q: container.querySelector("#d-q"),
    count: container.querySelector("#d-count"),
    trace: container.querySelector("#d-trace"),
    s1hd: container.querySelector("#d-s1-hd"),
    s1bd: container.querySelector("#d-s1-bd"),
    s2hd: container.querySelector("#d-s2-hd"),
    s2bd: container.querySelector("#d-s2-bd"),
    s3hd: container.querySelector("#d-s3-hd"),
    s3bd: container.querySelector("#d-s3-bd"),
    s4hd: container.querySelector("#d-s4-hd"),
    s4bd: container.querySelector("#d-s4-bd"),
    copyTrace: container.querySelector("#d-copyTrace"),
    openConsole: container.querySelector("#d-openConsole"),
    copyCurl: container.querySelector("#d-copyCurl"),
    rawToggle: container.querySelector("#d-rawToggle"),
    usage: container.querySelector("#d-usage"),
    reqBody: container.querySelector("#d-reqBody"),
    reqHint: container.querySelector("#d-reqHint"),
    log: container.querySelector("#d-log"),
    copyLogs: container.querySelector("#d-copyLogs"),
    clearLogs: container.querySelector("#d-clearLogs")
  };

  function filtered() {
    return entries.filter(function (e) {
      if (filters.route !== "all" && e.route !== filters.route) return false;
      if (filters.model !== "all" && e.model !== filters.model) return false;
      if (filters.key !== "all" && e.key !== filters.key) return false;
      if (filters.status !== "all" && String(e.status) !== String(filters.status)) return false;
      if (filters.q) {
        var q = filters.q.toLowerCase();
        var hay = (e.id + " " + e.cred + " " + e.credUid + " " + e.route + " " + e.model + " " + e.key + " " + safeJson(e.downstreamRequest.body)).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function renderReqTable() {
    if (!els.reqBody) return;
    var list = filtered();
    if (els.count) els.count.textContent = list.length + " / " + entries.length + " requests" + (list.length !== entries.length ? " (filtered)" : "");
    if (list.length === 0) {
      els.reqBody.innerHTML = '<tr><td colspan="6" class="hint" style="text-align:center; padding:16px">no requests match filter</td></tr>';
      return;
    }
    var html = "";
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var isSel = e.id === selectedId;
      var badge = e.status >= 200 && e.status < 300 ? "active" : e.status === 429 ? "quota" : e.status === 403 ? "banned" : "cooldown";
      var mcpIcon = e.mcp ? '<span title="MCP tool call" style="display:inline-grid; place-items:center; width:18px; height:18px; border-radius:4px; background:#f5f3ff; border:1px solid #ddd6fe; font-size:10px">⬢</span>' : '<span class="hint">—</span>';
      html += '<tr data-id="' + esc(e.id) + '" style="cursor:pointer; ' + (isSel ? 'background:var(--paper, #faf9f5)' : '') + '">'
        + '<td class="mono">' + esc(e.time) + '</td>'
        + '<td>' + esc(e.route) + '</td>'
        + '<td>' + esc(e.model) + '</td>'
        + '<td><span class="badge ' + esc(badge) + '">' + esc(String(e.status)) + '</span></td>'
        + '<td class="mono">' + esc(e.cred) + '</td>'
        + '<td>' + mcpIcon + '</td>'
        + '</tr>';
    }
    els.reqBody.innerHTML = html;
    var trs = els.reqBody.querySelectorAll("tr[data-id]");
    for (var j = 0; j < trs.length; j++) trs[j].addEventListener("click", function (ev) {
      var id = ev.currentTarget.getAttribute("data-id");
      if (id) { selectedId = id; renderTrace(); renderReqTable(); }
    });
  }

  function renderLogs() {
    if (!els.log) return;
    var text = logs.join("\n");
    // color via spans already styled in .log? we keep plain with class hooks
    // transform prefixes to colored spans
    var html = esc(text)
      .replace(/error/g, '<span class="err">error</span>')
      .replace(/warn/g, '<span class="warn">warn</span>')
      .replace(/info/g, '<span class="dim">info</span>')
      .replace(/\[pool\]/g, '<span class="ok">[pool]</span>')
      .replace(/\[upstream\]/g, '<span class="err">[upstream]</span>')
      .replace(/\[breaker\]/g, '<span class="warn">[breaker]</span>');
    els.log.innerHTML = html;
  }

  function curEntry() {
    for (var i = 0; i < entries.length; i++) if (entries[i].id === selectedId) return entries[i];
    return entries[0] || null;
  }

  function renderTrace() {
    var e = curEntry();
    if (!e) return;
    if (els.s1hd) els.s1hd.textContent = e.route + " · " + e.id + " · key " + e.key + " · model " + e.model;
    if (els.s2hd) els.s2hd.textContent = e.upstreamRequest.url + " · cred " + e.cred + " · " + fmtMs(e.upstreamResponse.elapsedMs);
    if (els.s3hd) {
      var c3 = e.upstreamResponse.code ? "code " + e.upstreamResponse.code : "ok";
      els.s3hd.textContent = e.upstreamResponse.status + " · " + fmtMs(e.upstreamResponse.elapsedMs) + " · " + c3;
    }
    if (els.s4hd) {
      var br = e.transformedResponse.breaker && e.transformedResponse.breaker !== "—" ? " · breaker " + e.transformedResponse.breaker : "";
      els.s4hd.textContent = e.transformedResponse.status + " · transformed" + br;
    }
    if (els.usage) {
      var u = e.usage;
      els.usage.textContent = "tokens prompt " + (u.prompt_tokens != null ? u.prompt_tokens : "—") + " · completion " + (u.completion_tokens != null ? u.completion_tokens : "—") + " · total " + (u.total_tokens != null ? u.total_tokens : "—") + " · latency " + fmtMs(e.latencyMs);
    }

    var doHighlight = rawMode === "pretty";
    function setBd(el, obj) {
      if (!el) return;
      if (!obj) { el.textContent = "—"; return; }
      if (doHighlight && typeof obj === "object") el.innerHTML = highlightJson(obj);
      else el.textContent = typeof obj === "string" ? obj : safeJson(obj, 2);
    }

    setBd(els.s1bd, e.downstreamRequest.body);
    // s2: combine headers + body
    var s2obj = { method: e.upstreamRequest.method, url: e.upstreamRequest.url, headers: e.upstreamRequest.headers, body: e.upstreamRequest.body, cred: e.upstreamRequest.cred, note: "PASSTHROUGH_BODY_KEYS — upstream schema preserved" };
    setBd(els.s2bd, s2obj);
    setBd(els.s3bd, e.upstreamResponse.body);
    setBd(els.s4bd, e.transformedResponse.body);

    // handle collapsed
    ["s1", "s2", "s3", "s4"].forEach(function (k) {
      var bd = k === "s1" ? els.s1bd : k === "s2" ? els.s2bd : k === "s3" ? els.s3bd : els.s4bd;
      var toggleEl = container.querySelector('[data-toggle="' + k + '"] #d-' + k + '-toggle') || container.querySelector('#d-' + k + '-toggle');
      if (!bd) return;
      if (collapsed[k]) { bd.style.display = "none"; if (toggleEl) toggleEl.textContent = "▸"; }
      else { bd.style.display = "block"; if (toggleEl) toggleEl.textContent = "▾"; }
    });
  }

  function bindFilters() {
    if (els.route) els.route.addEventListener("change", function () { filters.route = els.route.value; renderReqTable(); });
    if (els.model) els.model.addEventListener("change", function () { filters.model = els.model.value; renderReqTable(); });
    if (els.key) els.key.addEventListener("change", function () { filters.key = els.key.value; renderReqTable(); });
    if (els.status) els.status.addEventListener("change", function () { filters.status = els.status.value; renderReqTable(); });
    if (els.q) els.q.addEventListener("input", function () { filters.q = els.q.value; renderReqTable(); });

    if (els.trace) els.trace.addEventListener("click", function (e) {
      var t = e.target;
      while (t && t !== els.trace && !t.getAttribute("data-toggle")) t = t.parentElement;
      if (!t || !t.getAttribute("data-toggle")) return;
      var k = t.getAttribute("data-toggle");
      collapsed[k] = !collapsed[k];
      renderTrace();
    });

    if (els.pause) els.pause.addEventListener("click", function () {
      live = !live;
      if (live) { els.pause.textContent = "Pause"; if (els.liveChip) { els.liveChip.className = "chip ok"; els.liveChip.innerHTML = '<span class="dot"></span> Live'; } startPoll(); toastSafe(deps, "Live resumed", "ok"); }
      else { els.pause.textContent = "Resume"; if (els.liveChip) { els.liveChip.className = "chip warn"; els.liveChip.innerHTML = '<span class="dot warn"></span> Paused'; } stopPoll(); toastSafe(deps, "Live paused", "ok"); }
    });
    if (els.reload) els.reload.addEventListener("click", function () { fetchRemote(); });
    if (els.copyTrace) els.copyTrace.addEventListener("click", function () {
      var e = curEntry();
      if (!e) return;
      var trace = {
        id: e.id, time: e.time, route: e.route, model: e.model, key: e.key, cred: e.cred,
        downstreamRequest: e.downstreamRequest,
        upstreamRequest: e.upstreamRequest,
        upstreamResponse: e.upstreamResponse,
        transformedResponse: e.transformedResponse,
        usage: e.usage
      };
      copyText(deps, safeJson(trace, 2), "Trace copied");
    });
    if (els.openConsole) els.openConsole.addEventListener("click", function () {
      var e = curEntry();
      // navigate to console via hash; console page can read sessionStorage for prefill
      try {
        if (e && e.downstreamRequest && e.downstreamRequest.body) {
          var msgs = e.downstreamRequest.body.messages;
          var userMsg = "";
          if (Array.isArray(msgs)) {
            for (var i = 0; i < msgs.length; i++) if (msgs[i].role === "user") userMsg = msgs[i].content || userMsg;
          } else if (typeof e.downstreamRequest.body.input === "string") userMsg = e.downstreamRequest.body.input;
          sessionStorage.setItem("codebuffy_console_prefill", safeJson({ model: e.model, messages: msgs || userMsg }));
        }
      } catch {}
      // use hash routing contract from UIShell: #/console
      var target = "#/console";
      if (typeof window !== "undefined") {
        if (window.location.hash !== target) window.location.hash = target;
        // also dispatch if shell listens to hashchange
        try { window.dispatchEvent(new HashChangeEvent("hashchange")); } catch {}
      }
      toastSafe(deps, "Opened in Console", "ok");
    });
    if (els.copyCurl) els.copyCurl.addEventListener("click", function () {
      var e = curEntry();
      if (!e) return;
      var url = e.route;
      var body = e.downstreamRequest.body;
      var curl = "curl -X POST '" + url + "' -H 'Authorization: Bearer <key>' -H 'Content-Type: application/json' -d '" + safeJson(body).replace(/'/g, "'\\''") + "'";
      copyText(deps, curl, "Copied curl");
    });
    if (els.rawToggle) els.rawToggle.addEventListener("click", function () {
      rawMode = rawMode === "pretty" ? "raw" : "pretty";
      els.rawToggle.textContent = rawMode === "pretty" ? "Raw JSON" : "Pretty";
      renderTrace();
      toastSafe(deps, rawMode === "pretty" ? "Pretty highlight on" : "Raw JSON on", "ok");
    });
    if (els.copyLogs) els.copyLogs.addEventListener("click", function () { copyText(deps, logs.join("\n"), "Logs copied"); });
    if (els.clearLogs) els.clearLogs.addEventListener("click", function () { logs = []; renderLogs(); toastSafe(deps, "Logs cleared (local only)", "ok"); });
  }

  async function tryFetch(path, opts) {
    var headers = {};
    try {
      var k = getKey();
      if (k) headers["Authorization"] = "Bearer " + k;
    } catch {}
    try {
      var res = await fetch(path, { headers: headers, method: (opts && opts.method) || "GET" });
      if (!res.ok) return null;
      var ct = res.headers.get("content-type") || "";
      if (ct.indexOf("application/json") !== -1) return await res.json();
      return await res.text();
    } catch { return null; }
  }

  async function fetchRemote() {
    // Try admin-scoped endpoints first (behind adminAuth), then open fallback.
    // Priority: /admin/requests, /admin/logs
    var didUpdate = false;

    // Try GET /admin/requests?tail=100 or ?limit=50
    var j = null;
    if (api) {
      try {
        var r = await api("/admin/requests?tail=100");
        if (r && r.res && r.res.ok && r.json) j = r.json;
        else {
          var r2 = await api("/admin/requests?limit=50");
          if (r2 && r2.res && r2.res.ok && r2.json) j = r2.json;
        }
      } catch {}
    }
    if (!j) {
      // direct fetch fallback (covers mock servers)
      var alt = await tryFetch("/admin/requests?tail=100");
      if (alt && typeof alt === "object") j = alt;
      else if (!alt) {
        var alt2 = await tryFetch("/admin/requests");
        if (alt2 && typeof alt2 === "object") j = alt2;
      }
    }
    if (j) {
      var arr = Array.isArray(j) ? j : (Array.isArray(j.requests) ? j.requests : (Array.isArray(j.entries) ? j.entries : (Array.isArray(j.data) ? j.data : null)));
      if (arr && arr.length) {
        // normalize to our entry shape; keep mock if shape unknown
        var normalized = [];
        for (var i = 0; i < arr.length; i++) {
          var it = arr[i];
          if (!it || typeof it !== "object") continue;
          normalized.push({
            id: it.id || it.requestId || ("req_" + i),
            time: it.time || (it.at ? new Date(it.at).toLocaleTimeString() : "—"),
            at: it.at || Date.now() - i * 2000,
            route: it.route || it.path || it.method + " " + (it.route || ""),
            model: it.model || "auto",
            key: it.key || it.apiKey || it.accessKey || "dk_1",
            keyLabel: it.keyLabel || "",
            cred: it.cred || it.credential || it.uid || "—",
            credUid: it.credUid || it.uid || "",
            status: it.status != null ? Number(it.status) : 200,
            latencyMs: it.latencyMs != null ? it.latencyMs : (it.durationMs || 0),
            mcp: !!it.mcp,
            downstreamRequest: it.downstreamRequest || { method: it.method || "POST", path: it.route || it.path || "/v1/chat/completions", body: it.body || it.requestBody || {} },
            upstreamRequest: it.upstreamRequest || { method: "POST", url: it.upstreamUrl || "https://copilot.tencent.com/v2/completions", headers: it.upstreamHeaders || {}, body: it.upstreamBody || {}, cred: it.cred || "—" },
            upstreamResponse: it.upstreamResponse || { status: it.upstreamStatus || it.status || 200, body: it.upstreamBody || it.responseBody || {}, elapsedMs: it.latencyMs || 0, code: it.code || 0 },
            transformedResponse: it.transformedResponse || { status: it.status || 200, body: it.responseBody || {}, breaker: it.breaker || "—" },
            usage: it.usage || { prompt_tokens: it.promptTokens || 0, completion_tokens: it.completionTokens || 0, total_tokens: (it.promptTokens || 0) + (it.completionTokens || 0) }
          });
        }
        if (normalized.length) { entries = normalized; didUpdate = true; }
      }
    }

    // Try logs
    var lj = await tryFetch("/admin/logs?tail=200");
    if (!lj) lj = await tryFetch("/admin/logs");
    if (lj) {
      var logArr = null;
      if (typeof lj === "string") logArr = lj.split("\n").filter(function (s) { return s.trim(); });
      else if (Array.isArray(lj)) logArr = lj;
      else if (Array.isArray(lj.logs)) logArr = lj.logs;
      else if (typeof lj.text === "string") logArr = lj.text.split("\n").filter(function (s) { return s.trim(); });
      if (logArr && logArr.length) { logs = logArr.slice(-200); didUpdate = true; }
    }

    if (didUpdate) {
      // keep selection if still exists else pick first
      var still = false;
      for (var k = 0; k < entries.length; k++) if (entries[k].id === selectedId) still = true;
      if (!still && entries.length) selectedId = entries[0].id;
      renderReqTable();
      renderLogs();
      renderTrace();
      toastSafe(deps, "Debug refreshed from live endpoints", "ok");
    } else {
      // mock already shown; no toast flood
    }
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(function () {
      if (!live || document.hidden) return;
      fetchRemote();
    }, 5000);
  }
  function stopPoll() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  _debugStop = stopPoll;
  _debugContainer = container;
  _debugVis = function () {
    if (document.hidden) stopPoll();
    else if (live) startPoll();
  };
  bindFilters();
  renderReqTable();
  renderLogs();
  renderTrace();
  fetchRemote();
  if (live) startPoll();

  document.addEventListener("visibilitychange", _debugVis);

  return {
    destroy: function () { try { stopPoll(); } catch {} try { if (_debugVis) document.removeEventListener("visibilitychange", _debugVis); } catch {} _debugVis = null; _debugStop = null; try { container.innerHTML = ""; } catch {} },
    reload: function () { fetchRemote(); }
  };
}
export function destroy() {
  try { if (_debugStop) _debugStop(); } catch {}
  try { if (_debugVis) document.removeEventListener("visibilitychange", _debugVis); } catch {}
  _debugVis = null;
  _debugStop = null;
  try { if (_debugContainer) _debugContainer.innerHTML = ""; } catch {}
  _debugContainer = null;
}
export function mount(c, d) { return render(c, d); }
if (typeof window !== "undefined") window.CodebuffyDebugRender = render;
