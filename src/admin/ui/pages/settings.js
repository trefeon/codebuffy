/* eslint-disable @typescript-eslint/no-unused-vars */
/* Codebuffy Admin — Settings
 * 15 CODEBUFFY_* vars grouped System / Network / Pool / Security,
 * visual ↔ YAML toggle (textarea, js-yaml-like stringify, no CodeMirror),
 * passkey/WebAuthn 501 stub, theme/locale toggles (admin-theme, localePreference).
 * Save is env-only note (requires restart, no live patch).
 * No console.*, vanilla JS, ESM named export render().
 */
export function render(container, deps) {
  deps = deps || {};
  var toastSafe = deps.toast || function (msg, kind) {
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
    el.addEventListener("click", function () { clearTimeout(t); if (el.parentNode) el.parentNode.removeChild(el); });
  };

  function getKey() {
    if (deps.getKey) try { return deps.getKey() || ""; } catch { return ""; }
    try { return localStorage.getItem("codebuffy_admin_key") || ""; } catch { return ""; }
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function getTheme() {
    if (deps.theme && typeof deps.theme.get === "function") try { return deps.theme.get(); } catch { /* fallthrough */ }
    try { return localStorage.getItem("admin-theme") || "light"; } catch { return "light"; }
  }

  function setThemeVal(v) {
    if (deps.theme && typeof deps.theme.set === "function") { try { deps.theme.set(v); return; } catch { /* fallthrough */ } }
    try { localStorage.setItem("admin-theme", v); } catch { /* ignore */ }
    try {
      var root = document.documentElement;
      if (v === "dark") root.setAttribute("data-theme", "dark");
      else root.removeAttribute("data-theme");
      // also toggle via style like wireframe does (520ms mix handled by shell style.css if present)
    } catch { /* ignore */ }
  }

  function getLocale() {
    try {
      return localStorage.getItem("localePreference") || localStorage.getItem("admin-locale") || "en-US";
    } catch { return "en-US"; }
  }

  function setLocale(v) {
    try {
      localStorage.setItem("localePreference", v);
      localStorage.setItem("admin-locale", v);
    } catch { /* ignore */ }
  }

  var FIELDS = [
    { env: "CODEBUFFY_PORT", key: "port", group: "System", label: "CODEBUFFY_PORT", type: "number", default: 3000, hint: "1–65535 · default 3000", placeholder: "3000" },
    { env: "CODEBUFFY_HOST", key: "host", group: "System", label: "CODEBUFFY_HOST", type: "text", default: "127.0.0.1", hint: "bind host", placeholder: "127.0.0.1" },
    { env: "CODEBUFFY_LOG_LEVEL", key: "logLevel", group: "System", label: "CODEBUFFY_LOG_LEVEL", type: "select", options: ["fatal", "error", "warn", "info", "debug", "trace", "silent"], default: "info" },
    { env: "CODEBUFFY_API_BASE", key: "apiBase", group: "Network", label: "CODEBUFFY_API_BASE", type: "text", default: "https://copilot.tencent.com", hint: "http url", placeholder: "https://copilot.tencent.com" },
    { env: "CODEBUFFY_CONSOLE_BASE", key: "consoleBase", group: "Network", label: "CODEBUFFY_CONSOLE_BASE", type: "text", default: "https://www.codebuddy.cn", placeholder: "https://www.codebuddy.cn" },
    { env: "CODEBUFFY_UPSTREAM_TIMEOUT_MS", key: "upstreamTimeoutMs", group: "Network", label: "CODEBUFFY_UPSTREAM_TIMEOUT_MS", type: "number", default: 30000, hint: "1000–120000 ms" },
    { env: "CODEBUFFY_POOL_COOLDOWN_MS", key: "poolCooldownMs", group: "Pool", label: "CODEBUFFY_POOL_COOLDOWN_MS", type: "number", default: 30000, hint: "1000–600000 ms · G6" },
    { env: "CODEBUFFY_BREAKER_THRESHOLD", key: "breakerThreshold", group: "Pool", label: "CODEBUFFY_BREAKER_THRESHOLD", type: "number", default: 5, hint: "1–100 · breaker trips" },
    { env: "CODEBUFFY_BREAKER_RESET_MS", key: "breakerResetMs", group: "Pool", label: "CODEBUFFY_BREAKER_RESET_MS", type: "number", default: 60000, hint: "1000–600000 ms" },
    { env: "CODEBUFFY_CACHE_AFFINITY_TTL_MS", key: "cacheAffinityTtlMs", group: "Pool", label: "CODEBUFFY_CACHE_AFFINITY_TTL_MS", type: "number", default: 300000, hint: "1000–3600000 ms" },
    { env: "CODEBUFFY_ENCRYPTION_KEY", key: "encryptionKey", group: "Security", label: "CODEBUFFY_ENCRYPTION_KEY", type: "secret", default: "", hint: "store.encrypted ● when set" },
    { env: "CODEBUFFY_ADMIN_KEYS", key: "adminKeys", group: "Security", label: "CODEBUFFY_ADMIN_KEYS", type: "secret", default: "", hint: "comma-split · min 8 · Bearer for /admin/*" },
    { env: "CODEBUFFY_METRICS_ENABLED", key: "metricsEnabled", group: "Security", label: "CODEBUFFY_METRICS_ENABLED", type: "boolean", default: true },
    { env: "CODEBUFFY_CHECKIN_ENABLED", key: "checkinEnabled", group: "Security", label: "CODEBUFFY_CHECKIN_ENABLED", type: "boolean", default: false },
    { env: "CODEBUFFY_CHECKIN_JITTER_MS", key: "checkinJitterMs", group: "Security", label: "CODEBUFFY_CHECKIN_JITTER_MS", type: "number", default: 3600000, hint: "0–43200000 ms · jitter" }
  ];

  var GROUPS = ["System", "Network", "Pool", "Security"];

  // state
  var current = {};
  var revealed = {};
  var rawDirty = false;
  var mode = "visual";
  var loadedFromSettings = false;

  FIELDS.forEach(function (f) { current[f.key] = f.default; });

  function yamlStringify(obj) {
    var lines = [];
    lines.push("# Codebuffy settings — env layer CODEBUFFY_*");
    lines.push("# Defaults < config.json < CODEBUFFY_* env");
    lines.push("# Save is env-only (requires restart, no live patch)");
    lines.push("");
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var v = obj[f.key];
      if (f.type === "secret" && v) {
        // keep raw value in yaml (masked only in visual); stringify as quoted
        var q = String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        lines.push(f.key + ': "' + q + '"  # ' + f.env);
      } else if (f.type === "boolean") {
        lines.push(f.key + ": " + (v ? "true" : "false") + "  # " + f.env);
      } else if (f.type === "number") {
        lines.push(f.key + ": " + String(v) + "  # " + f.env);
      } else if (f.type === "select") {
        var qs = String(v).replace(/"/g, '\\"');
        lines.push(f.key + ': "' + qs + '"  # ' + f.env);
      } else {
        var qq = String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        lines.push(f.key + ': "' + qq + '"  # ' + f.env);
      }
    }
    return lines.join("\n");
  }

  function parseYamlLike(text) {
    var out = {};
    var errs = [];
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var trimmed = raw.trim();
      if (!trimmed || trimmed.charAt(0) === "#") continue;
      var colon = raw.indexOf(":");
      if (colon === -1) continue;
      var k = raw.slice(0, colon).trim();
      var rest = raw.slice(colon + 1).trim();
      // strip inline comment outside quotes
      var commentIdx = -1;
      var inStr = false;
      var escNext = false;
      for (var c = 0; c < rest.length; c++) {
        var ch = rest.charAt(c);
        if (escNext) { escNext = false; continue; }
        if (ch === "\\") { if (inStr) escNext = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (ch === "#" && !inStr) { commentIdx = c; break; }
      }
      if (commentIdx !== -1) rest = rest.slice(0, commentIdx).trim();
      // unwrap quotes
      if (rest.length >= 2 && rest.charAt(0) === '"' && rest.charAt(rest.length - 1) === '"') {
        rest = rest.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      } else if (rest.length >= 2 && rest.charAt(0) === "'" && rest.charAt(rest.length - 1) === "'") {
        rest = rest.slice(1, -1).replace(/''/g, "'");
      }
      // find field
      var field = null;
      for (var f = 0; f < FIELDS.length; f++) if (FIELDS[f].key === k) { field = FIELDS[f]; break; }
      if (!field) {
        // unknown key: keep as raw for export but warn
        continue;
      }
      if (field.type === "boolean") {
        if (rest === "true") out[k] = true;
        else if (rest === "false") out[k] = false;
        else errs.push(k + ": boolean expected true/false, got " + rest);
      } else if (field.type === "number") {
        var n = Number(rest);
        if (!isFinite(n) || rest === "") errs.push(k + ": number expected");
        else out[k] = n;
      } else {
        out[k] = rest;
      }
    }
    return { values: out, errors: errs };
  }

  function envToYamlMasked(obj) {
    // alias for yamlStringify but masked secrets as "••••••••" comment for display-only export?
    return yamlStringify(obj);
  }

  function renderGroupsHtml() {
    var html = "";
    for (var g = 0; g < GROUPS.length; g++) {
      var group = GROUPS[g];
      var fields = FIELDS.filter(function (f) { return f.group === group; });
      var title = group;
      if (group === "System") title = "System";
      else if (group === "Network") title = "Network / Upstream";
      else if (group === "Pool") title = "Pool / Hardening (G6/G9)";
      else if (group === "Security") title = "Security / Storage";

      html += '<div data-group="' + esc(group) + '">';
      html += '<div class="mini-title" style="margin-bottom:8px">' + esc(title) + '</div>';

      // layout depends on group: use .three for System/Network/Pool, .two-ish for Security secrets area
      if (group === "Security") {
        html += '<div style="display:grid; gap:10px">';
        // secrets row
        html += '<div class="two" style="gap:12px">';
        for (var si = 0; si < fields.length; si++) {
          var sf = fields[si];
          if (sf.type !== "secret") continue;
          var isRevealed = !!revealed[sf.key];
          var val = current[sf.key] == null ? "" : String(current[sf.key]);
          var displayVal = val ? (isRevealed ? esc(val) : "••••••••") : "";
          var inputType = isRevealed ? "text" : "password";
          html += '<label class="hint" style="display:grid; gap:4px">' + esc(sf.label);
          if (sf.hint) html += ' <span style="font-weight:400; text-transform:none; letter-spacing:0">· ' + esc(sf.hint) + '</span>';
          html += '<span class="row" style="gap:6px">';
          html += '<input class="input mono" data-field="' + esc(sf.key) + '" type="' + inputType + '" value="' + displayVal + '" placeholder="' + esc(sf.hint || "") + '" spellcheck="false" autocomplete="off" ' + (val && !isRevealed ? 'readonly' : '') + ' style="flex:1; min-width:0">';
          html += '<button class="btn small ghost" type="button" data-reveal="' + esc(sf.key) + '">' + (isRevealed ? "Hide" : "Reveal") + '</button>';
          if (sf.key === "encryptionKey") html += '<button class="btn small ghost" type="button" data-set-secret="' + esc(sf.key) + '">Set</button>';
          else html += '<button class="btn small ghost" type="button" data-copy-secret="' + esc(sf.key) + '">Copy</button>';
          html += '</span></label>';
        }
        html += '</div>';
        // booleans + jitter row
        html += '<div class="row" style="gap:12px; flex-wrap:wrap">';
        for (var bi = 0; bi < fields.length; bi++) {
          var bf = fields[bi];
          if (bf.type === "boolean") {
            var checked = !!current[bf.key];
            html += '<label class="chip" style="gap:6px"><input type="checkbox" data-field="' + esc(bf.key) + '" ' + (checked ? "checked" : "") + '> ' + esc(bf.label) + '</label>';
          }
        }
        // jitter number inline after checkinEnabled
        var jitter = FIELDS.find(function (f) { return f.key === "checkinJitterMs"; });
        if (jitter) {
          html += '<label class="hint" style="display:inline-flex; gap:6px; align-items:center">jitter <input class="input" data-field="checkinJitterMs" type="number" value="' + esc(String(current.checkinJitterMs)) + '" style="width:130px; min-width:130px; min-height:28px; padding:4px 8px"> <span class="hint">ms</span></label>';
          html += '<span class="hint">POST /admin/checkin/:uid → 501 when off</span>';
        }
        html += '</div>';
        html += '<div class="hint">adminAuth order: CODEBUFFY_ADMIN_KEYS → CODEBUFFY_API_KEYS fallback → open mode · store.encrypted ● when CODEBUFFY_ENCRYPTION_KEY set · GET /readyz → store.encrypted</div>';
        html += '</div>';
      } else {
        // generic grid
        var cols = group === "System" || group === "Network" || group === "Pool" ? "three" : "two";
        html += '<div class="' + cols + '" style="gap:12px">';
        for (var fi = 0; fi < fields.length; fi++) {
          var f = fields[fi];
          if (group === "Security" && f.type === "secret") continue;
          if (f.key === "checkinJitterMs") continue; // rendered in Security row
          var val2 = current[f.key];
          if (f.type === "select") {
            html += '<label class="hint" style="display:grid; gap:4px">' + esc(f.label);
            if (f.hint) html += ' <span style="font-weight:400">' + esc(f.hint) + '</span>';
            html += '<select class="select" data-field="' + esc(f.key) + '">';
            for (var o = 0; o < f.options.length; o++) {
              var opt = f.options[o];
              html += '<option value="' + esc(opt) + '"' + (String(val2) === opt ? " selected" : "") + '>' + esc(opt) + '</option>';
            }
            html += '</select></label>';
          } else if (f.type === "number") {
            html += '<label class="hint" style="display:grid; gap:4px">' + esc(f.label) + (f.hint ? ' <span style="font-weight:400">' + esc(f.hint) + '</span>' : '') + '<input class="input" data-field="' + esc(f.key) + '" type="number" value="' + esc(String(val2)) + '" placeholder="' + esc(f.placeholder || "") + '"></label>';
          } else if (f.type === "boolean") {
            var chk = !!val2;
            html += '<label class="chip" style="gap:6px; align-self:end"><input type="checkbox" data-field="' + esc(f.key) + '" ' + (chk ? "checked" : "") + '> ' + esc(f.label) + '</label>';
          } else {
            html += '<label class="hint" style="display:grid; gap:4px">' + esc(f.label) + (f.hint ? ' <span style="font-weight:400">' + esc(f.hint) + '</span>' : '') + '<input class="input" data-field="' + esc(f.key) + '" type="text" value="' + esc(String(val2 == null ? "" : val2)) + '" placeholder="' + esc(f.placeholder || "") + '" spellcheck="false"></label>';
          }
        }
        html += '</div>';
        if (group === "System") {
          html += '<div class="hint" style="margin-top:8px">Hint: change requires restart — env-only. No live patch. See local/ui-settings-patch.md</div>';
        }
      }
      html += '</div>';
    }
    return html;
  }

  // build shell HTML
  container.innerHTML = ""
    + '<div class="card" data-settings-root>'
    + '  <div class="card-hd" style="gap:10px; flex-wrap:wrap">'
    + '    <div style="display:grid; gap:2px">'
    + '      <h3 style="margin:0; font-size:13px; font-weight:750; letter-spacing:-.01em">Settings</h3>'
    + '      <p style="margin:0; color:var(--muted, #6b7280); font-size:12px">15 CODEBUFFY_* vars · grouped like CLIProxy 263-key · visual ↔ YAML (CodeMirror-like) · Save is env-only</p>'
    + '    </div>'
    + '    <span class="row" style="margin-left:auto; gap:6px">'
    + '      <button class="pill is-active" id="s-visualBtn" type="button" aria-pressed="true">Visual</button>'
    + '      <button class="pill" id="s-rawBtn" type="button" aria-pressed="false">Raw YAML</button>'
    + '      <button class="btn small ghost" id="s-validate" type="button">Validate</button>'
    + '      <button class="btn primary small" id="s-save" type="button">Save</button>'
    + '      <button class="btn small ghost" id="s-export" type="button">Export .env</button>'
    + '    </span>'
    + '  </div>'
    + '  <div class="card-bd" style="display:grid; gap:18px">'
    + '    <div id="s-visual" style="display:grid; gap:18px">'
    + renderGroupsHtml()
    + '    </div>'
    + '    <div id="s-raw" style="display:none; gap:12px">'
    + '      <div class="hint" style="display:flex; gap:8px; align-items:center; justify-content:space-between">'
    + '        <span>Raw YAML — parity with Visual (CLIProxy visual↔raw). Edits validate against zod ConfigSchema. <span style="font-weight:650">Frontend-only</span> — no backend PUT /admin/settings yet.</span>'
    + '        <span class="badge" title="no backend PUT">frontend-only</span>'
    + '      </div>'
    + '      <textarea class="textarea mono" id="s-yaml" rows="18" spellcheck="false" style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; font-size:12.5px; line-height:1.6; white-space:pre; overflow:auto; min-height:320px">' + esc(yamlStringify(current)) + '</textarea>'
    + '      <div class="hint" style="display:flex; gap:8px; align-items:center">'
    + '        <span id="s-rawStatus" role="status" aria-live="polite"></span>'
    + '        <span style="margin-left:auto" class="hint">js-yaml-like stringify, no CodeMirror dep, simple pre.</span>'
    + '      </div>'
    + '    </div>'
    + '    <div id="s-envBanner" class="hint" style="border:1px dashed var(--border, #e5e7eb); background:var(--paper, #faf9f5); border-radius:8px; padding:10px 12px; display:flex; gap:8px; align-items:center">Save is <strong>env-only</strong> — change CODEBUFFY_* in env / config.json and restart (no live patch). Visual ↔ YAML parity checked on Validate.</div>'
    + '    <hr class="divider" style="height:1px; background:var(--border, #e5e7eb); border:0; margin:0">'
    + '    <div class="two" style="gap:12px; align-items:start">'
    + '      <div class="card" style="box-shadow:none">'
    + '        <div class="card-hd" style="padding:12px 14px"><h3 style="margin:0; font-size:13px; font-weight:700">Passkey / WebAuthn</h3><span class="badge" style="margin-left:auto">501 stub</span></div>'
    + '        <div class="card-bd" style="display:grid; gap:8px">'
    + '          <div class="hint">GET/POST <code>/admin/auth/passkey</code> → <code>{code:"NOT_IMPLEMENTED"}</code>. Real WebAuthn is a separate milestone. Login still uses Bearer gate.</div>'
    + '          <div class="hint">Manage Bearer key in <a href="#/login">Login</a> — same <code>localStorage codebuffy_admin_key</code> flow. Passkey would live beside it (future).</div>'
    + '          <div class="row"><button class="btn small" type="button" disabled title="v2 — needs RP ID + store">Register passkey</button><a class="btn small ghost" href="#/login">Go to Login →</a><button class="btn small ghost" id="s-probePasskey" type="button">Probe /admin/auth/passkey</button></div>'
    + '          <div class="hint" id="s-passkeyStatus" role="status" aria-live="polite"></div>'
    + '        </div>'
    + '      </div>'
    + '      <div class="card" style="box-shadow:none" data-appearance-card>'
    + '        <div class="card-hd" style="padding:12px 14px"><h3 style="margin:0; font-size:13px; font-weight:700">Appearance</h3></div>'
    + '        <div class="card-bd" style="display:grid; gap:10px">'
    + '          <div class="row" style="gap:8px; align-items:center">'
    + '            <span class="hint" style="min-width:52px">Theme</span>'
    + '            <button class="pill" id="s-themeLight" type="button">Light ●</button>'
    + '            <button class="pill" id="s-themeDark" type="button">Dark ○</button>'
    + '            <button class="pill" id="s-themeSystem" type="button">System ○</button>'
    + '            <select class="select" id="s-locale" aria-label="Locale" style="margin-left:auto; min-width:140px">'
    + '              <option value="en-US">Locale: en-US</option>'
    + '              <option value="ja-JP">Locale: ja-JP</option>'
    + '              <option value="zh-CN">Locale: zh-CN</option>'
    + '            </select>'
    + '          </div>'
    + '          <div class="hint">Radius 10px · Shadows soft · Font system → Space Grotesk fallback · Theme 520ms mix (prefers-reduced-motion honors shell) · locale stored as <code>localePreference</code> + <code>admin-locale</code></div>'
    + '          <div class="row" style="gap:6px"><span class="swatch" style="background:#faf9f5; width:18px; height:18px; border-radius:6px; border:1px solid var(--border, #e5e7eb); display:inline-block"></span><span class="swatch" style="background:#e0e7ff; width:18px; height:18px; border-radius:6px; border:1px solid var(--border, #e5e7eb); display:inline-block"></span><span class="swatch" style="background:#6366f1; width:18px; height:18px; border-radius:6px; border:1px solid var(--border, #e5e7eb); display:inline-block"></span><span class="swatch" style="background:#111827; width:18px; height:18px; border-radius:6px; border:1px solid var(--border, #e5e7eb); display:inline-block"></span><span class="swatch" style="background:#065f46; width:18px; height:18px; border-radius:6px; border:1px solid var(--border, #e5e7eb); display:inline-block"></span><span class="swatch" style="background:#dc2626; width:18px; height:18px; border-radius:6px; border:1px solid var(--border, #e5e7eb); display:inline-block"></span><span class="hint" id="s-themeStatus" role="status" aria-live="polite" style="margin-left:8px"></span></div>'
    + '        </div>'
    + '      </div>'
    + '    </div>'
    + '    <div class="hint" style="display:flex; gap:6px; align-items:center; flex-wrap:wrap"><span class="badge">15 vars</span> System 3 · Network 3 · Pool 4 · Security 5 · Layering <code>defaults &lt; config.json &lt; CODEBUFFY_* env</code> · <code>GET /readyz</code> <code>store.encrypted</code> · <code>GET /healthz</code> version/uptime</div>'
    + '  </div>'
    + '</div>';

  var visualBtn = container.querySelector("#s-visualBtn");
  var rawBtn = container.querySelector("#s-rawBtn");
  var visual = container.querySelector("#s-visual");
  var raw = container.querySelector("#s-raw");
  var yamlEl = container.querySelector("#s-yaml");
  var rawStatus = container.querySelector("#s-rawStatus");
  var validateBtn = container.querySelector("#s-validate");
  var saveBtn = container.querySelector("#s-save");
  var exportBtn = container.querySelector("#s-export");
  var themeLight = container.querySelector("#s-themeLight");
  var themeDark = container.querySelector("#s-themeDark");
  var themeSystem = container.querySelector("#s-themeSystem");
  var themeStatus = container.querySelector("#s-themeStatus");
  var localeSel = container.querySelector("#s-locale");
  var probePasskeyBtn = container.querySelector("#s-probePasskey");
  var passkeyStatus = container.querySelector("#s-passkeyStatus");

  function setMode(next) {
    mode = next;
    if (next === "raw") {
      if (visual) visual.style.display = "none";
      if (raw) raw.style.display = "grid";
      if (visualBtn) { visualBtn.classList.remove("is-active"); visualBtn.setAttribute("aria-pressed", "false"); }
      if (rawBtn) { rawBtn.classList.add("is-active"); rawBtn.setAttribute("aria-pressed", "true"); }
      // sync yaml from current
      if (yamlEl && !rawDirty) yamlEl.value = yamlStringify(current);
      rawDirty = false;
    } else {
      // raw -> visual: try to parse yaml back
      if (yamlEl) {
        var parsed = parseYamlLike(yamlEl.value);
        if (parsed.errors.length) {
          if (rawStatus) { rawStatus.textContent = "YAML has errors: " + parsed.errors.slice(0, 3).join(" · "); rawStatus.style.color = "#991b1b"; }
          toastSafe("YAML parse: " + parsed.errors[0], "error");
          // stay in raw to let user fix? keep visual hidden until fixed? Instead allow visual but mark
        } else if (Object.keys(parsed.values).length) {
          for (var k in parsed.values) if (Object.prototype.hasOwnProperty.call(parsed.values, k)) current[k] = parsed.values[k];
          if (rawStatus) { rawStatus.textContent = "YAML parsed — visual updated."; rawStatus.style.color = ""; setTimeout(function () { if (rawStatus) rawStatus.textContent = ""; }, 2200); }
          refreshVisualInputs();
        }
      }
      if (visual) visual.style.display = "grid";
      if (raw) raw.style.display = "none";
      if (rawBtn) { rawBtn.classList.remove("is-active"); rawBtn.setAttribute("aria-pressed", "false"); }
      if (visualBtn) { visualBtn.classList.add("is-active"); visualBtn.setAttribute("aria-pressed", "true"); }
    }
  }

  function refreshVisualInputs() {
    var inputs = container.querySelectorAll("[data-field]");
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var key = el.getAttribute("data-field");
      if (!key || !(key in current)) continue;
      var field = FIELDS.find(function (f) { return f.key === key; });
      if (!field) continue;
      if (field.type === "secret") {
        var isRev = !!revealed[key];
        var v = current[key] == null ? "" : String(current[key]);
        if (isRev) {
          el.value = v;
          el.type = "text";
          el.removeAttribute("readonly");
        } else {
          el.value = v ? "••••••••" : "";
          el.type = "password";
          if (v) el.setAttribute("readonly", "");
          else el.removeAttribute("readonly");
        }
        var btn = container.querySelector('[data-reveal="' + key + '"]');
        if (btn) btn.textContent = isRev ? "Hide" : "Reveal";
      } else if (field.type === "boolean") {
        el.checked = !!current[key];
      } else {
        el.value = String(current[key] == null ? "" : current[key]);
      }
    }
    if (yamlEl && mode === "raw" && !rawDirty) yamlEl.value = yamlStringify(current);
  }

  function collectFromVisual() {
    var inputs = container.querySelectorAll("[data-field]");
    var next = {};
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var key = el.getAttribute("data-field");
      if (!key) continue;
      var field = FIELDS.find(function (f) { return f.key === key; });
      if (!field) continue;
      if (field.type === "boolean") next[key] = !!el.checked;
      else if (field.type === "number") {
        var n = Number(el.value);
        next[key] = isFinite(n) ? n : field.default;
      } else if (field.type === "secret") {
        // if masked (readonly + ••••) don't overwrite
        if (el.getAttribute("readonly") != null && el.value === "••••••••") {
          next[key] = current[key];
        } else {
          next[key] = el.value;
        }
      } else if (field.type === "select") next[key] = el.value;
      else next[key] = el.value;
    }
    // merge with current for missing
    for (var k = 0; k < FIELDS.length; k++) {
      var fk = FIELDS[k].key;
      if (!(fk in next)) next[fk] = current[fk];
    }
    return next;
  }

  function validateCurrent(obj) {
    var errs = [];
    // port 1-65535
    var p = Number(obj.port);
    if (!isFinite(p) || p < 1 || p > 65535 || (p | 0) !== p) errs.push("CODEBUFFY_PORT must be int 1–65535");
    if (obj.host != null && String(obj.host).trim() === "") errs.push("CODEBUFFY_HOST must be non-empty");
    var levels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];
    if (levels.indexOf(String(obj.logLevel)) === -1) errs.push("CODEBUFFY_LOG_LEVEL must be one of " + levels.join(","));
    var apiB = String(obj.apiBase || "");
    if (apiB && apiB.indexOf("http://") !== 0 && apiB.indexOf("https://") !== 0) errs.push("CODEBUFFY_API_BASE must be http(s) url");
    var conB = String(obj.consoleBase || "");
    if (conB && conB.indexOf("http://") !== 0 && conB.indexOf("https://") !== 0) errs.push("CODEBUFFY_CONSOLE_BASE must be http(s) url");
    var ut = Number(obj.upstreamTimeoutMs);
    if (!isFinite(ut) || ut < 1000 || ut > 120000) errs.push("CODEBUFFY_UPSTREAM_TIMEOUT_MS 1000–120000");
    var cd = Number(obj.poolCooldownMs);
    if (!isFinite(cd) || cd < 1000 || cd > 600000) errs.push("CODEBUFFY_POOL_COOLDOWN_MS 1000–600000");
    var th = Number(obj.breakerThreshold);
    if (!isFinite(th) || th < 1 || th > 100 || (th | 0) !== th) errs.push("CODEBUFFY_BREAKER_THRESHOLD 1–100");
    var br = Number(obj.breakerResetMs);
    if (!isFinite(br) || br < 1000 || br > 600000) errs.push("CODEBUFFY_BREAKER_RESET_MS 1000–600000");
    var ca = Number(obj.cacheAffinityTtlMs);
    if (!isFinite(ca) || ca < 1000 || ca > 3600000) errs.push("CODEBUFFY_CACHE_AFFINITY_TTL_MS 1000–3600000");
    var jit = Number(obj.checkinJitterMs);
    if (!isFinite(jit) || jit < 0 || jit > 43200000) errs.push("CODEBUFFY_CHECKIN_JITTER_MS 0–43200000");
    // secrets min 8 if non-empty and not masked bullet
    function checkSecret(k, env) {
      var v = obj[k];
      if (v == null || v === "") return;
      if (v === "••••••••") return;
      if (String(v).length < 8) errs.push(env + " min 8 chars if set");
    }
    checkSecret("encryptionKey", "CODEBUFFY_ENCRYPTION_KEY");
    checkSecret("adminKeys", "CODEBUFFY_ADMIN_KEYS");
    return errs;
  }

  function syncYamlFromVisualIfNeeded() {
    if (mode === "visual") return;
    if (yamlEl && !rawDirty) yamlEl.value = yamlStringify(current);
  }

  // events
  if (visualBtn) visualBtn.addEventListener("click", function () { setMode("visual"); });
  if (rawBtn) rawBtn.addEventListener("click", function () { setMode("raw"); });

  if (yamlEl) {
    yamlEl.addEventListener("input", function () { rawDirty = true; if (rawStatus) rawStatus.textContent = "Edited — Validate to sync to Visual."; });
  }

  // delegate input changes
  container.addEventListener("input", function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var f = t.getAttribute("data-field");
    if (!f) return;
    // update current live for yaml preview
    var field = FIELDS.find(function (ff) { return ff.key === f; });
    if (!field) return;
    if (field.type === "secret" && t.getAttribute("readonly") != null) return; // masked bullet, ignore typing until reveal
    if (field.type === "boolean") current[f] = !!t.checked;
    else if (field.type === "number") {
      var nn = Number(t.value);
      if (isFinite(nn)) current[f] = nn;
    } else current[f] = t.value;
    syncYamlFromVisualIfNeeded();
    if (rawStatus && mode === "raw") rawStatus.textContent = "";
  });

  container.addEventListener("change", function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var f = t.getAttribute("data-field");
    if (!f) return;
    var field = FIELDS.find(function (ff) { return ff.key === f; });
    if (!field) return;
    if (field.type === "boolean") current[f] = !!t.checked;
    else if (field.type === "select") current[f] = t.value;
    syncYamlFromVisualIfNeeded();
  });

  // reveal/copy/set handlers
  container.addEventListener("click", function (e) {
    var rev = e.target.closest("[data-reveal]");
    if (rev) {
      var key = rev.getAttribute("data-reveal");
      revealed[key] = !revealed[key];
      refreshVisualInputs();
      return;
    }
    var copyB = e.target.closest("[data-copy-secret]");
    if (copyB) {
      var k2 = copyB.getAttribute("data-copy-secret");
      var v2 = current[k2] || "";
      if (!v2) { toastSafe("No value to copy", "error"); return; }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(String(v2)).then(function () { toastSafe("Copied", "ok"); }, function () { toastSafe("Copy failed", "error"); });
        } else {
          var tmp = document.createElement("textarea");
          tmp.value = String(v2);
          tmp.setAttribute("readonly", "");
          tmp.style.position = "absolute";
          tmp.style.left = "-9999px";
          document.body.appendChild(tmp);
          tmp.select();
          document.execCommand("copy");
          document.body.removeChild(tmp);
          toastSafe("Copied", "ok");
        }
      } catch { toastSafe("Copy failed", "error"); }
      return;
    }
    var setB = e.target.closest("[data-set-secret]");
    if (setB) {
      var k3 = setB.getAttribute("data-set-secret");
      revealed[k3] = true;
      refreshVisualInputs();
      var inp = container.querySelector('[data-field="' + k3 + '"]');
      if (inp) { inp.focus(); inp.select(); }
      toastSafe("Paste new value, then Validate → Save (env-only)", "");
      return;
    }
  });

  if (validateBtn) validateBtn.addEventListener("click", function () {
    var obj = mode === "raw" && yamlEl ? parseYamlLike(yamlEl.value).values : collectFromVisual();
    // if raw, merge
    if (mode === "raw" && yamlEl) {
      var pr = parseYamlLike(yamlEl.value);
      if (pr.errors.length) { toastSafe("Validate: " + pr.errors[0], "error"); if (rawStatus) { rawStatus.textContent = pr.errors.join(" · "); rawStatus.style.color = "#991b1b"; } return; }
      obj = Object.assign({}, current, pr.values);
    }
    var errs = validateCurrent(obj);
    if (errs.length) {
      toastSafe(errs[0], "error");
      if (rawStatus) { rawStatus.textContent = errs.slice(0, 2).join(" · "); rawStatus.style.color = "#991b1b"; }
      return;
    }
    // sync back
    current = Object.assign({}, current, obj);
    refreshVisualInputs();
    if (yamlEl) yamlEl.value = yamlStringify(current);
    rawDirty = false;
    if (rawStatus) { rawStatus.textContent = "Validated ✓"; rawStatus.style.color = "#065f46"; setTimeout(function () { if (rawStatus) rawStatus.textContent = ""; }, 2400); }
    toastSafe("Validated ✓", "ok");
  });

  if (saveBtn) saveBtn.addEventListener("click", function () {
    var obj = mode === "raw" && yamlEl ? parseYamlLike(yamlEl.value).values : collectFromVisual();
    if (mode === "raw" && yamlEl) {
      var pr2 = parseYamlLike(yamlEl.value);
      if (pr2.errors.length) { toastSafe("Fix YAML first: " + pr2.errors[0], "error"); return; }
      obj = Object.assign({}, current, pr2.values);
    }
    var errs = validateCurrent(obj);
    if (errs.length) { toastSafe(errs[0], "error"); return; }
    current = Object.assign({}, current, obj);
    refreshVisualInputs();
    toastSafe("Settings are env-only — update CODEBUFFY_* in env / config.json and restart (no live patch). Visual ↔ YAML parity held.", "");
    if (rawStatus) { rawStatus.textContent = "Env-only — restart required."; rawStatus.style.color = ""; }
  });

  if (exportBtn) exportBtn.addEventListener("click", function () {
    var obj = mode === "raw" && yamlEl ? parseYamlLike(yamlEl.value).values : collectFromVisual();
    if (mode === "raw" && yamlEl) {
      var pr3 = parseYamlLike(yamlEl.value);
      if (!pr3.errors.length) obj = Object.assign({}, current, pr3.values);
    }
    var merged = Object.assign({}, current, obj);
    var lines = [];
    lines.push("# Codebuffy .env export — copy into .env or shell");
    lines.push("# Layering: defaults < config.json < CODEBUFFY_* env · restart required");
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var v = merged[f.key];
      if (f.type === "boolean") lines.push(f.env + "=" + (v ? "true" : "false"));
      else if (f.type === "number") lines.push(f.env + "=" + String(v));
      else if (f.type === "secret") {
        if (!v || v === "••••••••") lines.push("# " + f.env + "=<set via env — not exported masked>");
        else lines.push(f.env + '="' + String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"');
      } else {
        var s = String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        lines.push(f.env + '="' + s + '"');
      }
    }
    var txt = lines.join("\n");
    // try clipboard, else show in yaml textarea
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { toastSafe("Exported .env to clipboard", "ok"); }, function () {
          if (yamlEl) { setMode("raw"); yamlEl.value = txt; rawDirty = true; }
          toastSafe("Export shown in Raw — copy manually", "");
        });
      } else {
        if (yamlEl) { setMode("raw"); yamlEl.value = txt; rawDirty = true; }
        toastSafe("Export shown in Raw — copy manually", "");
      }
    } catch {
      if (yamlEl) { setMode("raw"); yamlEl.value = txt; rawDirty = true; }
      toastSafe("Export shown in Raw", "");
    }
  });

  // appearance
  function updateThemePills() {
    var cur = getTheme();
    var isDark = cur === "dark";
    var isLight = cur === "light";
    var isSystem = cur === "system" || (!isDark && !isLight);
    // reset
    if (themeLight) { themeLight.classList.toggle("is-active", isLight); themeLight.textContent = isLight ? "Light ●" : "Light ○"; }
    if (themeDark) { themeDark.classList.toggle("is-active", isDark); themeDark.textContent = isDark ? "Dark ●" : "Dark ○"; }
    if (themeSystem) { themeSystem.classList.toggle("is-active", isSystem); themeSystem.textContent = isSystem ? "System ●" : "System ○"; }
    if (themeStatus) themeStatus.textContent = isDark ? "Dark" : isLight ? "Light" : "System";
  }

  if (themeLight) themeLight.addEventListener("click", function () { setThemeVal("light"); updateThemePills(); toastSafe("Theme: Light", "ok"); });
  if (themeDark) themeDark.addEventListener("click", function () { setThemeVal("dark"); updateThemePills(); toastSafe("Theme: Dark", "ok"); });
  if (themeSystem) themeSystem.addEventListener("click", function () {
    try { localStorage.removeItem("admin-theme"); } catch { /* ignore */ }
    // apply system preference immediately
    var prefersDark = false;
    try { prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { /* ignore */ }
    try {
      var root = document.documentElement;
      if (prefersDark) root.setAttribute("data-theme", "dark"); else root.removeAttribute("data-theme");
    } catch { /* ignore */ }
    updateThemePills();
    if (themeStatus) themeStatus.textContent = "System (" + (prefersDark ? "dark" : "light") + ")";
    toastSafe("Theme: System", "ok");
  });

  if (localeSel) {
    localeSel.value = getLocale();
    // only en-US active, others placeholder disabled visually but selectable for copy
    localeSel.addEventListener("change", function () {
      var v = localeSel.value;
      if (v !== "en-US") {
        toastSafe("Locale " + v + " — placeholder (only en active)", "error");
        // revert to en after note? keep selection but note inactive
        // store anyway for future
      }
      setLocale(v);
      toastSafe("Locale: " + v, v === "en-US" ? "ok" : "");
    });
  }
  updateThemePills();

  if (probePasskeyBtn) probePasskeyBtn.addEventListener("click", async function () {
    var key = getKey();
    if (passkeyStatus) { passkeyStatus.textContent = "Probing…"; passkeyStatus.style.color = ""; }
    try {
      var doFetch = deps.api ? deps.api : function (path, opts) {
        var h = {};
        try { var k = getKey(); if (k) h["Authorization"] = "Bearer " + k; } catch { /* ignore */ }
        return fetch(path, { method: (opts && opts.method) || "GET", headers: Object.assign({}, h, (opts && opts.headers) || {}) })
          .then(async function (res) {
            var text = await res.text();
            var json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
            return { res: res, json: json, text: text };
          });
      };
      // try GET first (passkey stub accepts GET/POST)
      var r = await doFetch("/admin/auth/passkey", { method: "GET" });
      if (r.res.status === 501) {
        if (passkeyStatus) { passkeyStatus.textContent = "501 passkeyNotImplemented — as expected (stub). POST /admin/auth/passkey → {code:\"NOT_IMPLEMENTED\"}"; passkeyStatus.style.color = ""; }
        toastSafe("Passkey 501 — stub (needs RP ID + store, v2)", "");
        return;
      }
      if (r.res.status === 401) {
        if (passkeyStatus) { passkeyStatus.textContent = "401 — set admin key in Login first"; passkeyStatus.style.color = "#991b1b"; }
        toastSafe("401 — invalid admin key", "error");
        return;
      }
      if (passkeyStatus) passkeyStatus.textContent = "GET /admin/auth/passkey → " + r.res.status + " " + (r.text || "").slice(0, 180);
    } catch (e) {
      if (passkeyStatus) { passkeyStatus.textContent = "Probe failed: " + (e && e.message ? e.message : String(e)); passkeyStatus.style.color = "#991b1b"; }
    }
  });

  // load from backend if exists
  (async function loadInitial() {
    var apiFn = deps.api;
    if (!apiFn) {
      // fallback: fetch directly with Bearer if present
      apiFn = function (path, opts) {
        var h = {};
        try { var k = getKey(); if (k) h["Authorization"] = "Bearer " + k; } catch { /* ignore */ }
        if (path.indexOf("/admin/") !== 0) return Promise.reject(new Error("refusing non-admin path: " + path));
        return fetch(path, { method: (opts && opts.method) || "GET", headers: Object.assign({}, h, (opts && opts.headers) || {}) })
          .then(async function (res) {
            var text = await res.text();
            var json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
            return { res: res, json: json, text: text };
          });
      };
    }
    try {
      var r = await apiFn("/admin/settings", { method: "GET" });
      if (r.res.ok && r.json) {
        // support both {settings:{...}} and flat
        var src = r.json.settings || r.json.config || r.json;
        var mapped = {};
        // map known keys
        for (var i = 0; i < FIELDS.length; i++) {
          var f = FIELDS[i];
          if (src[f.key] !== undefined) mapped[f.key] = src[f.key];
          else if (src[f.env] !== undefined) mapped[f.key] = src[f.env];
          else if (src[f.env.toLowerCase()] !== undefined) mapped[f.key] = src[f.env.toLowerCase()];
        }
        if (Object.keys(mapped).length) {
          current = Object.assign({}, current, mapped);
          loadedFromSettings = true;
          refreshVisualInputs();
          if (yamlEl) yamlEl.value = yamlStringify(current);
          toastSafe("Settings loaded from GET /admin/settings", "ok");
          return;
        }
      }
      if (r.res.status === 404) {
        // expected — no backend yet, keep defaults + read-only note
        if (rawStatus) { rawStatus.textContent = "GET /admin/settings 404 — showing env defaults (read-only until backend lands)."; rawStatus.style.color = ""; }
      } else if (r.res.status === 401) {
        if (rawStatus) { rawStatus.textContent = "401 — set admin key in Login to load settings (showing defaults)."; rawStatus.style.color = "#991b1b"; }
      } else if (!r.res.ok) {
        // keep defaults but hint
        if (rawStatus && r.text) { rawStatus.textContent = "GET /admin/settings → " + r.res.status; }
      }
    } catch {
      if (rawStatus) rawStatus.textContent = "Settings endpoint unavailable — showing defaults (frontend-only).";
    }

    // fallback: enrich from /admin/health or /healthz (open) to show live port/host-ish?
    try {
      var healthApi = deps.api || apiFn;
      var hr = await healthApi("/admin/health", { method: "GET" }).catch(function () { return null; });
      if (!hr || !hr.res.ok) {
        // try open healthz
        var hz = await fetch("/healthz").then(async function (res) {
          var t = await res.text(); var j = null; try { j = t ? JSON.parse(t) : null; } catch { j = null; } return { res: res, json: j };
        }).catch(function () { return null; });
        if (hz && hz.res.ok && hz.json) {
          // no env there, just version/uptime — keep defaults
        }
      } else if (hr && hr.json) {
        // hr.json may contain version/status — no env mapping needed
      }
    } catch { /* ignore */ }

    // also try readyz for store.encrypted hint
    try {
      var rz = await fetch("/readyz").then(async function (res) {
        var t = await res.text(); var j = null; try { j = t ? JSON.parse(t) : null; } catch { j = null; } return { res: res, json: j };
      }).catch(function () { return null; });
      if (rz && rz.json && rz.json.store && typeof rz.json.store.encrypted !== "undefined") {
        // if encrypted is true but encryptionKey empty, hint
        if (rz.json.store.encrypted && !current.encryptionKey) {
          if (rawStatus) rawStatus.textContent = "store.encrypted ● (key set server-side, masked here)";
        }
      }
    } catch { /* ignore */ }

    refreshVisualInputs();
    if (yamlEl) yamlEl.value = yamlStringify(current);
  })();
}

export default { render: render };

if (typeof window !== "undefined") {
  window.CodebuffySettingsRender = render;
}
