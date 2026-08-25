/* eslint-disable @typescript-eslint/no-unused-vars */
/* Codebuffy Admin — Console / Playground
 * ESM module: export function render(container, deps)
 * Model from GET /v1/models, credential from GET /admin/credentials,
 * stream via fetch+reader SSE, 4-step trace (request→upstreamRequest→upstreamResponse→transformed)
 * No console.*, no external deps.
 */
function esc(s) {
  var d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}
function fmtMs(ms) {
  if (ms == null || isNaN(ms)) return "—";
  if (ms < 1000) return String(Math.round(ms)) + "ms";
  return (ms / 1000).toFixed(2) + "s";
}
function nowIso() {
  try { return new Date().toISOString(); } catch { return String(Date.now()); }
}
function safeJson(v, indent) {
  try { return JSON.stringify(v, null, indent || 2); } catch { return String(v); }
}
function buildCurl(url, key, body) {
  var b = safeJson(body);
  var k = key ? key.slice(0, 8) + "…" : "<key>";
  return "curl -X POST '" + url + "' \\\n  -H 'Authorization: Bearer " + k + "' \\\n  -H 'Content-Type: application/json' \\\n  -d '" + b.replace(/'/g, "'\\''") + "'";
}
function isAnthropicModel(m) {
  var s = String(m || "").toLowerCase();
  return s.indexOf("claude") !== -1;
}
function pickDownstreamKey(deps, override) {
  if (override && String(override).trim().length >= 8) return String(override).trim();
  try {
    if (deps && typeof deps.getKey === "function") return deps.getKey() || "";
    var v = localStorage.getItem("codebuffy_admin_key") || "";
    return v;
  } catch { return ""; }
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
    el.style.opacity = "0";
    el.style.transition = "opacity 180ms";
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
  }, kind === "error" ? 4200 : 2600);
  el.addEventListener("click", function () {
    clearTimeout(t);
    if (el.parentNode) el.parentNode.removeChild(el);
  });
}

export function render(container, deps) {
  deps = deps || {};
  var getKey = deps.getKey || function () {
    try { return localStorage.getItem("codebuffy_admin_key") || ""; } catch { return ""; }
  };

  var abortCtrl = null;
  var startAt = 0;
  var aggregated = "";
  var rawSse = "";
  var lastPayload = null;
  var lastEndpoint = "/v1/chat/completions";

  container.innerHTML = ""
    + '<div class="card" data-console-root>'
    + '  <div class="card-hd">'
    + '    <h3>Console / Playground</h3>'
    + '    <p>Model from GET /v1/models · credential from GET /admin/credentials · trace 4-step</p>'
    + '    <span class="chip" id="c-modelChip" style="margin-left:auto">model: auto</span>'
    + '  </div>'
    + '  <div class="card-bd" style="display:grid; gap:12px">'
    + '    <div class="row" style="gap:8px">'
    + '      <select class="select" id="c-model" aria-label="Model" style="min-width:220px"><option value="auto">auto</option></select>'
    + '      <select class="select" id="c-cred" aria-label="Credential" style="min-width:200px"><option value="">credential: auto (pool)</option></select>'
    + '      <label class="chip" style="gap:6px"><input type="checkbox" id="c-stream" checked> Stream</label>'
    + '      <label class="chip" style="gap:6px">Temp <input class="input" id="c-temp" value="0.7" type="number" min="0" max="2" step="0.1" style="width:72px; min-width:72px; padding:4px 8px; min-height:28px"></label>'
    + '      <label class="chip" style="gap:6px">Max <input class="input" id="c-max" value="512" type="number" min="1" max="8192" step="1" style="width:84px; min-width:84px; padding:4px 8px; min-height:28px"></label>'
    + '      <input class="input" id="c-dskey" type="password" placeholder="Downstream key (defaults to admin key)" autocomplete="off" spellcheck="false" aria-label="Downstream bearer key" style="max-width:260px">'
    + '    </div>'
    + '    <div class="row" style="gap:8px">'
    + '      <select class="select" id="c-route" aria-label="Route" style="min-width:220px"><option value="auto">route: auto</option><option value="/v1/chat/completions">POST /v1/chat/completions</option><option value="/v1/messages">POST /v1/messages</option><option value="/v1/responses">POST /v1/responses</option></select>'
    + '      <span class="hint" id="c-routeHint">auto picks /v1/messages for claude models, else /v1/chat/completions</span>'
    + '    </div>'
    + '    <label class="hint" style="display:grid; gap:4px">System prompt<textarea class="textarea" id="c-system" rows="2" placeholder="You are a helpful assistant."></textarea></label>'
    + '    <label class="hint" style="display:grid; gap:4px">User message<textarea class="textarea" id="c-user" rows="4" placeholder="Hello — test the gateway…"></textarea></label>'
    + '    <div class="row">'
    + '      <button class="btn accent" id="c-send" type="button">Send</button>'
    + '      <button class="btn" id="c-stop" type="button" disabled>Stop</button>'
    + '      <button class="btn ghost small" id="c-curl" type="button">Copy curl</button>'
    + '      <button class="btn ghost small" id="c-clear" type="button">Clear</button>'
    + '      <span class="hint" id="c-status" style="margin-left:auto" role="status" aria-live="polite">idle</span>'
    + '    </div>'
    + '    <div class="two" style="align-items:start">'
    + '      <div class="card" style="box-shadow:none">'
    + '        <div class="card-hd"><h3>Response</h3><span class="row" style="margin-left:auto"><button class="btn small ghost" id="c-copy" type="button">Copy</button><button class="btn small ghost" id="c-save" type="button">Save as fixture</button><button class="btn small ghost" id="c-rawToggle" type="button">Raw SSE</button></span></div>'
    + '        <div class="card-bd" style="display:grid; gap:8px">'
    + '          <div id="c-out" style="white-space:pre-wrap; line-height:1.6; min-height:84px; font-size:13px">— send a prompt to see streaming output —</div>'
    + '          <div class="hint" id="c-meta">tokens: — · finish_reason: —</div>'
    + '          <pre id="c-raw" style="display:none; max-height:240px; overflow:auto; background:var(--paper, #faf9f5); border:1px solid var(--border, #e5e7eb); border-radius:8px; padding:10px; font-size:12px; line-height:1.5; white-space:pre-wrap; word-break:break-all"></pre>'
    + '        </div>'
    + '      </div>'
    + '      <div class="card" style="box-shadow:none">'
    + '        <div class="card-hd"><h3>Trace (SSE)</h3><span class="badge" id="c-live" style="margin-left:auto">LIVE</span><span class="hint" id="c-elapsed" style="margin-left:6px">—</span></div>'
    + '        <div class="card-bd trace" id="c-trace" style="display:grid; gap:8px">'
    + '          <div class="step" id="c-s1"><div class="step-hd"><b>① downstream request</b><span class="hint" style="margin-left:auto" id="c-s1-hd">—</span></div><pre class="step-bd" id="c-s1-bd">—</pre></div>'
    + '          <div class="step" id="c-s2"><div class="step-hd"><b>② upstream request</b><span class="hint" style="margin-left:auto" id="c-s2-hd">—</span></div><pre class="step-bd" id="c-s2-bd">— pool selects credential · IR → CodeBuddy · POST /v2/completions</pre></div>'
    + '          <div class="step" id="c-s3"><div class="step-hd"><b>③ upstream response</b><span class="hint" style="margin-left:auto" id="c-s3-hd">—</span></div><pre class="step-bd" id="c-s3-bd">— waiting for upstream chunks —</pre></div>'
    + '          <div class="step" id="c-s4"><div class="step-hd"><b>④ downstream response</b><span class="hint" style="margin-left:auto" id="c-s4-hd">—</span></div><pre class="step-bd" id="c-s4-bd">— transformed → OpenAI SSE / JSON</pre></div>'
    + '          <div class="row"><span class="hint">Advanced:</span><button class="btn small ghost" id="c-showUp" type="button">Show raw upstream JSON</button><button class="btn small ghost" id="c-showIr" type="button">Show IR</button><span class="hint" id="c-traceHint" style="margin-left:auto">TTFT — · total —</span></div>'
    + '        </div>'
    + '      </div>'
    + '    </div>'
    + '    <div class="hint">Console talks to live <code>/v1/*</code> via Bearer (downstream key or admin fallback). Trace shows request → upstreamRequest → upstreamResponse → transformed. Stream uses fetch + ReadableStream reader (EventSource-like).</div>'
    + '  </div>'
    + '</div>';

  var els = {
    model: container.querySelector("#c-model"),
    cred: container.querySelector("#c-cred"),
    stream: container.querySelector("#c-stream"),
    temp: container.querySelector("#c-temp"),
    max: container.querySelector("#c-max"),
    dskey: container.querySelector("#c-dskey"),
    route: container.querySelector("#c-route"),
    system: container.querySelector("#c-system"),
    user: container.querySelector("#c-user"),
    send: container.querySelector("#c-send"),
    stop: container.querySelector("#c-stop"),
    curlBtn: container.querySelector("#c-curl"),
    clearBtn: container.querySelector("#c-clear"),
    status: container.querySelector("#c-status"),
    out: container.querySelector("#c-out"),
    meta: container.querySelector("#c-meta"),
    raw: container.querySelector("#c-raw"),
    rawToggle: container.querySelector("#c-rawToggle"),
    copy: container.querySelector("#c-copy"),
    save: container.querySelector("#c-save"),
    modelChip: container.querySelector("#c-modelChip"),
    live: container.querySelector("#c-live"),
    elapsed: container.querySelector("#c-elapsed"),
    traceHint: container.querySelector("#c-traceHint"),
    s1hd: container.querySelector("#c-s1-hd"),
    s1bd: container.querySelector("#c-s1-bd"),
    s2hd: container.querySelector("#c-s2-hd"),
    s2bd: container.querySelector("#c-s2-bd"),
    s3hd: container.querySelector("#c-s3-hd"),
    s3bd: container.querySelector("#c-s3-bd"),
    s4hd: container.querySelector("#c-s4-hd"),
    s4bd: container.querySelector("#c-s4-bd"),
    showUp: container.querySelector("#c-showUp"),
    showIr: container.querySelector("#c-showIr")
  };

  function setStatus(msg, isError) {
    if (!els.status) return;
    els.status.textContent = msg;
    els.status.style.color = isError ? "#991b1b" : "";
  }
  function setTraceHd(which, text) {
    var el = which === 1 ? els.s1hd : which === 2 ? els.s2hd : which === 3 ? els.s3hd : els.s4hd;
    if (el) el.textContent = text;
  }
  function setStepBd(which, text) {
    var el = which === 1 ? els.s1bd : which === 2 ? els.s2bd : which === 3 ? els.s3bd : els.s4bd;
    if (el) el.textContent = text;
  }
  function updateModelChip() {
    if (els.modelChip) els.modelChip.textContent = "model: " + (els.model ? els.model.value : "auto");
  }
  function resolveEndpoint(model, routeSel) {
    if (routeSel && routeSel !== "auto") return routeSel;
    if (isAnthropicModel(model)) return "/v1/messages";
    return "/v1/chat/completions";
  }

  async function loadModels() {
    var key = pickDownstreamKey(deps, els.dskey ? els.dskey.value : "");
    if (!key) {
      if (els.model) els.model.innerHTML = '<option value="auto">auto (set key to list models)</option>';
      return;
    }
    try {
      var res = await fetch("/v1/models", {
        headers: { "Authorization": "Bearer " + key },
        method: "GET"
      });
      if (!res.ok) {
        var txt = await res.text();
        setStatus("GET /v1/models → " + res.status + " " + txt.slice(0, 120), true);
        return;
      }
      var j = await res.json();
      var data = (j && Array.isArray(j.data)) ? j.data : [];
      if (data.length === 0) return;
      var cur = els.model ? els.model.value : "auto";
      if (!els.model) return;
      var html = "";
      for (var i = 0; i < data.length; i++) {
        var id = data[i] && data[i].id ? String(data[i].id) : "";
        if (!id) continue;
        html += '<option value="' + esc(id) + '">' + esc(id) + "</option>";
      }
      if (html) {
        var hasAuto = false;
        for (var k = 0; k < data.length; k++) if (String(data[k].id) === "auto") hasAuto = true;
        if (!hasAuto) html = '<option value="auto">auto</option>' + html;
        els.model.innerHTML = html;
        var found = false;
        for (var o = 0; o < els.model.options.length; o++) if (els.model.options[o].value === cur) { els.model.value = cur; found = true; break; }
        if (!found) els.model.value = "auto";
        updateModelChip();
      }
      setStatus("Models loaded (" + data.length + ")", false);
    } catch (e) {
      setStatus("GET /v1/models failed: " + (e && e.message ? e.message : String(e)), true);
    }
  }

  async function loadCreds() {
    var doApi = deps.api;
    if (!doApi) {
      try {
        var k = getKey();
        if (!k) return;
        var r = await fetch("/admin/credentials", { headers: { "Authorization": "Bearer " + k } });
        if (!r.ok) return;
        var jj = await r.json();
        renderCredOptions(jj && jj.credentials ? jj.credentials : []);
      } catch {}
      return;
    }
    try {
      var r2 = await doApi("/admin/credentials");
      if (!r2 || !r2.res || !r2.res.ok) return;
      var list = r2.json && r2.json.credentials ? r2.json.credentials : [];
      renderCredOptions(list);
    } catch {}
  }

  function renderCredOptions(list) {
    if (!els.cred) return;
    var cur = els.cred.value;
    var html = '<option value="">credential: auto (pool)</option>';
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var uid = c.uid || "";
      var short = uid.length > 8 ? uid.slice(0, 4) + "…" + uid.slice(-2) : uid;
      var state = c.state || "";
      var label = c.label ? " · " + c.label : "";
      html += '<option value="' + esc(uid) + '">' + esc(short) + " [" + esc(state) + "]" + esc(label) + "</option>";
    }
    els.cred.innerHTML = html;
    if (cur) {
      for (var j = 0; j < els.cred.options.length; j++) if (els.cred.options[j].value === cur) { els.cred.value = cur; break; }
    }
  }

  function buildPayload() {
    var model = els.model ? els.model.value : "auto";
    var sys = els.system ? els.system.value : "";
    var user = els.user ? els.user.value : "";
    var stream = !!(els.stream && els.stream.checked);
    var tempRaw = els.temp ? els.temp.value : "0.7";
    var maxRaw = els.max ? els.max.value : "512";
    var endpoint = resolveEndpoint(model, els.route ? els.route.value : "auto");
    lastEndpoint = endpoint;
    var temp = parseFloat(tempRaw);
    if (isNaN(temp)) temp = 0.7;
    var maxTok = parseInt(maxRaw, 10);
    if (isNaN(maxTok) || maxTok < 1) maxTok = 512;
    var payload;
    if (endpoint === "/v1/messages") {
      payload = {
        model: model,
        max_tokens: maxTok,
        stream: stream,
        messages: [{ role: "user", content: user || "Hello" }],
        temperature: temp
      };
      if (sys && sys.trim()) payload.system = sys;
    } else if (endpoint === "/v1/responses") {
      payload = {
        model: model,
        input: user || "Hello",
        stream: stream,
        temperature: temp,
        max_output_tokens: maxTok
      };
      if (sys && sys.trim()) payload.instructions = sys;
    } else {
      var msgs = [];
      if (sys && sys.trim()) msgs.push({ role: "system", content: sys });
      msgs.push({ role: "user", content: user || "Hello" });
      payload = {
        model: model,
        messages: msgs,
        stream: stream,
        temperature: temp,
        max_tokens: maxTok
      };
    }
    return { model: model, endpoint: endpoint, payload: payload, stream: stream };
  }

  function updateCurlPreview() {
    var built = buildPayload();
    var key = pickDownstreamKey(deps, els.dskey ? els.dskey.value : "");
    var curl = buildCurl(built.endpoint, key, built.payload);
    lastPayload = built.payload;
    if (els.curlBtn) els.curlBtn.setAttribute("data-curl", curl);
    setTraceHd(1, built.endpoint + " · model " + built.model + (built.stream ? " · stream" : " · json"));
    setStepBd(1, safeJson(built.payload, 2));
    setTraceHd(2, (els.cred && els.cred.value ? "cred " + els.cred.value.slice(0, 8) + "… (hint)" : "pool auto-select") + " → upstream IR");
    setStepBd(2, "// IR → CodeBuddy\n// PASSTHROUGH_BODY_KEYS: server keeps upstream schema\n// Upstream: POST https://copilot.tencent.com/v2/completions (pool selects credential)\n" + (els.cred && els.cred.value ? "// Hint credential: " + els.cred.value + "\n" : "") + safeJson(built.payload, 2));
  }

  async function doSend() {
    var userVal = els.user ? els.user.value.trim() : "";
    if (!userVal) {
      toastSafe(deps, "Enter a user message", "error");
      if (els.user) els.user.focus();
      return;
    }
    var key = pickDownstreamKey(deps, els.dskey ? els.dskey.value : "");
    if (!key) {
      toastSafe(deps, "Set downstream key (or admin key fallback) before sending", "error");
      setStatus("no key — set Downstream key or Save admin key", true);
      return;
    }
    var built = buildPayload();
    var endpoint = built.endpoint;
    var payload = built.payload;
    var wantStream = built.stream;

    if (els.send) els.send.disabled = true;
    if (els.stop) els.stop.disabled = false;
    if (els.live) { els.live.textContent = "STREAMING"; els.live.style.background = "#ecfdf5"; }
    aggregated = "";
    rawSse = "";
    if (els.out) els.out.textContent = "";
    if (els.raw) els.raw.textContent = "";
    if (els.meta) els.meta.textContent = "tokens: — · finish_reason: —";
    setStatus("POST " + endpoint + " …", false);
    updateCurlPreview();
    setStepBd(3, wantStream ? "— streaming chunks —" : "— awaiting JSON —");
    setStepBd(4, "— awaiting transformed response —");
    startAt = Date.now();
    var ttft = 0;
    var statusCode = 0;
    var finishReason = "—";
    var promptTok = "—";
    var compTok = "—";

    abortCtrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var signal = abortCtrl ? abortCtrl.signal : undefined;
    var headers = {
      "Authorization": "Bearer " + key,
      "Content-Type": "application/json"
    };
    if (els.cred && els.cred.value) headers["x-codebuffy-credential"] = els.cred.value;

    try {
      var res = await fetch(endpoint, {
        method: "POST",
        headers: headers,
        body: safeJson(payload),
        signal: signal
      });
      statusCode = res.status;
      setTraceHd(3, res.status + " · " + (wantStream ? "stream" : "json") + " · " + (res.headers.get("content-type") || ""));
      setTraceHd(4, "downstream " + res.status + " · transform");
      setStatus(endpoint + " → " + res.status + " " + res.statusText, res.ok ? false : true);

      if (!res.ok) {
        var errText = await res.text();
        var errJson = null;
        try { errJson = errText ? JSON.parse(errText) : null; } catch {}
        aggregated = errText;
        if (els.out) els.out.textContent = errJson ? safeJson(errJson, 2) : errText;
        rawSse = errText;
        if (els.raw) els.raw.textContent = rawSse;
        setStepBd(3, safeJson(errJson || errText, 2));
        setStepBd(4, "// mapUpstreamErrorToHttp\n// code 11140→403, 14018→429, 5xx→500\n" + safeJson(errJson || errText, 2));
        var elapsed = Date.now() - startAt;
        if (els.elapsed) els.elapsed.textContent = fmtMs(elapsed);
        if (els.traceHint) els.traceHint.textContent = "TTFT — · total " + fmtMs(elapsed);
        if (els.meta) els.meta.textContent = "error " + res.status + " · " + (errJson && errJson.error && errJson.error.code ? errJson.error.code : "—");
        toastSafe(deps, endpoint + " " + res.status + " " + (errJson && errJson.error && errJson.error.message ? errJson.error.message : res.statusText), "error");
        return;
      }

      if (!wantStream) {
        var j = await res.json();
        rawSse = safeJson(j, 2);
        if (els.raw) els.raw.textContent = rawSse;
        if (endpoint === "/v1/messages") {
          var txtA = "";
          if (j && Array.isArray(j.content)) {
            for (var a = 0; a < j.content.length; a++) if (j.content[a].type === "text") txtA += j.content[a].text || "";
          }
          aggregated = txtA || safeJson(j, 2);
          if (els.out) els.out.textContent = aggregated;
          finishReason = j.stop_reason || j.finish_reason || "—";
          if (j.usage) { promptTok = j.usage.input_tokens != null ? String(j.usage.input_tokens) : "—"; compTok = j.usage.output_tokens != null ? String(j.usage.output_tokens) : "—"; }
        } else if (endpoint === "/v1/responses") {
          var txtR = "";
          try {
            if (j.output && Array.isArray(j.output)) {
              for (var r = 0; r < j.output.length; r++) {
                var it = j.output[r];
                if (it && Array.isArray(it.content)) for (var rc = 0; rc < it.content.length; rc++) if (it.content[rc].text) txtR += it.content[rc].text;
              }
            }
          } catch {}
          aggregated = txtR || safeJson(j, 2);
          if (els.out) els.out.textContent = aggregated;
          finishReason = j.status || "—";
          if (j.usage) { promptTok = j.usage.input_tokens != null ? String(j.usage.input_tokens) : (j.usage.prompt_tokens != null ? String(j.usage.prompt_tokens) : "—"); compTok = j.usage.output_tokens != null ? String(j.usage.output_tokens) : (j.usage.completion_tokens != null ? String(j.usage.completion_tokens) : "—"); }
        } else {
          var choice = j && j.choices && j.choices[0] ? j.choices[0] : null;
          aggregated = choice && choice.message && choice.message.content ? choice.message.content : safeJson(j, 2);
          if (els.out) els.out.textContent = aggregated;
          finishReason = choice && choice.finish_reason ? choice.finish_reason : (j.finish_reason || "—");
          if (j.usage) { promptTok = j.usage.prompt_tokens != null ? String(j.usage.prompt_tokens) : "—"; compTok = j.usage.completion_tokens != null ? String(j.usage.completion_tokens) : "—"; }
        }
        if (els.meta) els.meta.textContent = "tokens: prompt " + promptTok + " · completion " + compTok + " · finish_reason: " + finishReason;
        setStepBd(3, rawSse);
        setStepBd(4, rawSse);
      } else {
        var reader = null;
        var decoder = new TextDecoder();
        var buf = "";
        var firstChunkAt = 0;

        if (res.body && typeof res.body.getReader === "function") {
          reader = res.body.getReader();
        } else {
          var t = await res.text();
          rawSse = t;
          if (els.raw) els.raw.textContent = rawSse;
          if (els.out) els.out.textContent = t;
          aggregated = t;
          setStepBd(3, t);
          setStepBd(4, t);
          return;
        }

        while (true) {
          var read = await reader.read();
          if (read.done) break;
          var chunk = decoder.decode(read.value, { stream: true });
          buf += chunk;
          rawSse += chunk;
          if (els.raw) els.raw.textContent = rawSse;

          var parts = buf.split("\n\n");
          buf = parts.pop() || "";
          for (var pi = 0; pi < parts.length; pi++) {
            var block = parts[pi];
            var lines = block.split("\n");
            for (var li = 0; li < lines.length; li++) {
              var line = lines[li];
              if (line.indexOf("data: ") !== 0) continue;
              var dataStr = line.slice(6).trim();
              if (dataStr === "[DONE]") { finishReason = "stop"; continue; }
              var obj = null;
              try { obj = JSON.parse(dataStr); } catch { continue; }
              if (!firstChunkAt) {
                firstChunkAt = Date.now();
                ttft = firstChunkAt - startAt;
                if (els.traceHint) els.traceHint.textContent = "TTFT " + fmtMs(ttft) + " · streaming…";
              }
              var delta = "";
              if (obj.choices && obj.choices[0]) {
                var ch = obj.choices[0];
                if (ch.delta && typeof ch.delta.content === "string") delta = ch.delta.content;
                else if (ch.text) delta = ch.text;
                if (ch.finish_reason) finishReason = ch.finish_reason;
                if (ch.delta && ch.delta.finish_reason) finishReason = ch.delta.finish_reason;
              } else if (obj.delta && typeof obj.delta.text === "string") {
                delta = obj.delta.text;
                if (obj.delta.stop_reason) finishReason = obj.delta.stop_reason;
              } else if (obj.type === "content_block_delta" && obj.delta && obj.delta.text) {
                delta = obj.delta.text;
              } else if (obj.output_text) {
                delta = obj.output_text;
              } else if (obj.response && obj.response.output_text) {
                delta = obj.response.output_text;
              }
              if (delta) {
                aggregated += delta;
                if (els.out) els.out.textContent = aggregated;
              }
              if (obj.usage) {
                if (obj.usage.prompt_tokens != null) promptTok = String(obj.usage.prompt_tokens);
                if (obj.usage.input_tokens != null) promptTok = String(obj.usage.input_tokens);
                if (obj.usage.completion_tokens != null) compTok = String(obj.usage.completion_tokens);
                if (obj.usage.output_tokens != null) compTok = String(obj.usage.output_tokens);
                if (els.meta) els.meta.textContent = "tokens: prompt " + promptTok + " · completion " + compTok + " · finish_reason: " + finishReason;
              }
            }
          }
          if (buf.length > 8192) {
            var extra = buf;
            buf = "";
            rawSse += extra;
            if (els.raw) els.raw.textContent = rawSse;
          }
        }
        try { var tail = decoder.decode(); if (tail) { rawSse += tail; if (els.raw) els.raw.textContent = rawSse; } } catch {}
        if (!aggregated && rawSse) {
          if (els.out) els.out.textContent = rawSse.slice(0, 4000);
        }
        setStepBd(3, rawSse.slice(0, 6000) || "— no chunks —");
        setStepBd(4, aggregated ? aggregated.slice(0, 6000) : rawSse.slice(0, 6000));
        if (els.meta) els.meta.textContent = "tokens: prompt " + promptTok + " · completion " + compTok + " · finish_reason: " + finishReason;
      }

      var totalElapsed = Date.now() - startAt;
      if (els.elapsed) els.elapsed.textContent = fmtMs(totalElapsed);
      var ttftStr = ttft ? fmtMs(ttft) : "—";
      if (els.traceHint) els.traceHint.textContent = "TTFT " + ttftStr + " · total " + fmtMs(totalElapsed) + " · route " + endpoint + " · key " + (key.slice(0, 6) + "…");
      setTraceHd(3, statusCode + " · " + fmtMs(totalElapsed) + " · " + (finishReason !== "—" ? finishReason : "done"));
      setTraceHd(4, "transformed · " + finishReason + " · " + fmtMs(totalElapsed));
      setStatus("done " + statusCode + " · " + fmtMs(totalElapsed) + (ttft ? " · TTFT " + fmtMs(ttft) : ""), false);
    } catch (e) {
      if (e && e.name === "AbortError") {
        setStatus("aborted", true);
        toastSafe(deps, "Stopped", "ok");
        setStepBd(3, rawSse + "\n— aborted —");
      } else {
        var msg = e && e.message ? e.message : String(e);
        setStatus("error: " + msg, true);
        toastSafe(deps, msg, "error");
        if (els.out) els.out.textContent = "error: " + msg + "\n" + rawSse;
        setStepBd(3, "error: " + msg + "\n" + rawSse);
        setStepBd(4, "error: " + msg);
      }
    } finally {
      if (els.send) els.send.disabled = false;
      if (els.stop) els.stop.disabled = true;
      if (els.live) { els.live.textContent = "IDLE"; els.live.style.background = ""; }
      abortCtrl = null;
    }
  }

  function doStop() {
    if (abortCtrl) { try { abortCtrl.abort(); } catch {} }
    if (els.send) els.send.disabled = false;
    if (els.stop) els.stop.disabled = true;
    setStatus("stopped", false);
  }
  function copyText(text, okMsg) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toastSafe(deps, okMsg || "Copied", "ok"); }, function () { fallbackCopy(text, okMsg); });
      } else fallbackCopy(text, okMsg);
    } catch { fallbackCopy(text, okMsg); }
  }
  function fallbackCopy(text, okMsg) {
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

  if (els.model) els.model.addEventListener("change", function () { updateModelChip(); updateCurlPreview(); });
  if (els.route) els.route.addEventListener("change", updateCurlPreview);
  if (els.cred) els.cred.addEventListener("change", updateCurlPreview);
  if (els.temp) els.temp.addEventListener("input", updateCurlPreview);
  if (els.max) els.max.addEventListener("input", updateCurlPreview);
  if (els.system) els.system.addEventListener("input", updateCurlPreview);
  if (els.user) els.user.addEventListener("input", updateCurlPreview);
  if (els.dskey) els.dskey.addEventListener("input", function () { updateCurlPreview(); loadModels(); });
  if (els.send) els.send.addEventListener("click", doSend);
  if (els.stop) els.stop.addEventListener("click", doStop);
  if (els.curlBtn) els.curlBtn.addEventListener("click", function () {
    var built = buildPayload();
    var key = pickDownstreamKey(deps, els.dskey ? els.dskey.value : "");
    var curl = buildCurl(built.endpoint, key, built.payload);
    copyText(curl, "Copied curl");
  });
  if (els.clearBtn) els.clearBtn.addEventListener("click", function () {
    if (els.system) els.system.value = "";
    if (els.user) els.user.value = "";
    if (els.out) els.out.textContent = "— send a prompt to see streaming output —";
    if (els.raw) { els.raw.textContent = ""; els.raw.style.display = "none"; }
    if (els.meta) els.meta.textContent = "tokens: — · finish_reason: —";
    rawSse = ""; aggregated = "";
    setStepBd(1, "—"); setStepBd(3, "— waiting —"); setStepBd(4, "—");
    setStatus("cleared", false);
    toastSafe(deps, "Cleared", "ok");
  });
  if (els.copy) els.copy.addEventListener("click", function () {
    var t = aggregated || (els.out ? els.out.textContent : "");
    copyText(t, "Copied response");
  });
  if (els.save) els.save.addEventListener("click", function () {
    var built = buildPayload();
    var fixture = { at: nowIso(), endpoint: built.endpoint, request: built.payload, responseText: aggregated, rawSse: rawSse };
    var blob = new Blob([safeJson(fixture, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "codebuffy-fixture-" + Date.now() + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
    toastSafe(deps, "Fixture saved", "ok");
  });
  if (els.rawToggle) els.rawToggle.addEventListener("click", function () {
    if (!els.raw) return;
    var isHidden = els.raw.style.display === "none" || !els.raw.style.display;
    els.raw.style.display = isHidden ? "block" : "none";
    els.rawToggle.textContent = isHidden ? "Hide SSE" : "Raw SSE";
  });
  if (els.showUp) els.showUp.addEventListener("click", function () {
    if (els.raw && rawSse) { els.raw.style.display = "block"; els.raw.textContent = rawSse.slice(0, 8000); toastSafe(deps, "Raw upstream / SSE shown", "ok"); }
    else toastSafe(deps, "No upstream data yet", "error");
  });
  if (els.showIr) els.showIr.addEventListener("click", function () {
    var built = buildPayload();
    var ir = { model: built.model, messages: built.payload.messages || built.payload.input || built.payload.messages, stream: built.payload.stream, _note: "IR is the normalized intermediate representation before upstream conversion" };
    if (els.raw) { els.raw.style.display = "block"; els.raw.textContent = safeJson(ir, 2); }
    toastSafe(deps, "IR shown", "ok");
  });

  container.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); doSend(); }
  });

  updateModelChip();
  updateCurlPreview();
  loadModels();
  loadCreds();
  setStatus("ready — pick model, enter prompt, Send (⌘+Enter)", false);

  return {
    destroy: function () { doStop(); container.innerHTML = ""; },
    reload: function () { loadModels(); loadCreds(); }
  };
}
export function mount(c, d) { return render(c, d); }
// legacy global for non-module script tag
if (typeof window !== "undefined") window.CodebuffyConsoleRender = render;
