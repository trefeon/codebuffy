/* Codebuffy Admin — Login
 * Like CLIProxy + XuanBoWu: adminKey input, apiBase display, rememberPassword,
 * languageSelect (en-US/ja-JP/zh-CN placeholder only en active), custom connection toggle,
 * sign-in → setKey + GET /admin/credentials 401/200, error banner, redirect to #/dashboard.
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

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function getKey() {
    if (deps.getKey) try { return deps.getKey() || ""; } catch { return ""; }
    try { return localStorage.getItem("codebuffy_admin_key") || ""; } catch { return ""; }
  }
  function setKey(v) {
    if (deps.setKey) { try { deps.setKey(v); return; } catch { /* fallthrough */ } }
    try { localStorage.setItem("codebuffy_admin_key", v); } catch { /* ignore */ }
  }
  function clearKey() {
    if (deps.clearKey) { try { deps.clearKey(); return; } catch { /* fallthrough */ } }
    try { localStorage.removeItem("codebuffy_admin_key"); } catch { /* ignore */ }
  }

  var REMEMBER_KEY = "codebuffy_remember_password";
  var CUSTOM_BASE_KEY = "codebuffy_custom_api_base";

  function getRemember() {
    try { return localStorage.getItem(REMEMBER_KEY) !== "0"; } catch { return true; }
  }
  function setRemember(v) {
    try { localStorage.setItem(REMEMBER_KEY, v ? "1" : "0"); } catch { /* ignore */ }
  }
  function getCustomBase() {
    try { return localStorage.getItem(CUSTOM_BASE_KEY) || ""; } catch { return ""; }
  }
  function setCustomBase(v) {
    try {
      if (v) localStorage.setItem(CUSTOM_BASE_KEY, v);
      else localStorage.removeItem(CUSTOM_BASE_KEY);
    } catch { /* ignore */ }
  }
  function getLocale() {
    try { return localStorage.getItem("localePreference") || localStorage.getItem("admin-locale") || "en-US"; } catch { return "en-US"; }
  }
  function setLocale(v) {
    try { localStorage.setItem("localePreference", v); localStorage.setItem("admin-locale", v); } catch { /* ignore */ }
  }

  container.innerHTML = ""
    + '<div style="max-width:520px; margin:0 auto; width:100%; display:grid; gap:14px; padding-top:8px" data-login-root>'
    + '  <div class="card">'
    + '    <div class="card-hd" style="flex-direction:column; align-items:flex-start; gap:4px">'
    + '      <h3 style="margin:0; font-size:16px; font-weight:750; letter-spacing:-.02em">Admin login</h3>'
    + '      <p style="margin:0; color:var(--muted, #6b7280); font-size:12px">Bearer gate — same as shipped <code>src/admin/ui/index.html</code>. No session cookie. Key stored in <code>localStorage codebuffy_admin_key</code> when Remember is on.</p>'
    + '    </div>'
    + '    <div class="card-bd" style="display:grid; gap:12px">'
    + '      <div class="row" id="l-modeRow" style="gap:6px">'
    + '        <span class="chip warn" id="l-openBadge" style="display:none">Open mode — no keys set</span>'
    + '        <span class="chip" id="l-fallbackBadge" style="display:none">Fallback — downstream keys act as admin</span>'
    + '        <span class="chip ok" id="l-adminBadge" style="display:none">Admin-only</span>'
    + '        <span class="hint" id="l-apiBase" style="margin-left:auto">apiBase: <span class="mono" id="l-apiBaseVal">—</span> · <span id="l-healthVal" class="mono">health: —</span></span>'
    + '      </div>'
    + '      <div id="l-error" role="alert" aria-live="assertive" style="display:none; border:1px solid #fecaca; background:#fef2f2; color:#991b1b; border-radius:8px; padding:10px 12px; font-size:13px; line-height:1.4"></div>'
    + '      <label class="hint" style="display:grid; gap:6px">Admin key'
    + '        <span class="row" style="gap:6px">'
    + '          <input class="input mono" id="loginKey" type="password" placeholder="Bearer token (CODEBUFFY_ADMIN_KEYS)" aria-label="Admin Bearer token" autocomplete="off" spellcheck="false" style="flex:1; min-width:0">'
    + '          <button class="btn small ghost" id="showKeyBtn" type="button" aria-label="Toggle visibility">Show</button>'
    + '        </span>'
    + '        <span class="hint">Hint: <code>Authorization: Bearer …</code> only to <code>/admin/*</code> on this host. Never logged, never in URL. Min 8 chars.</span>'
    + '      </label>'
    + '      <div class="row" style="gap:10px; align-items:center">'
    + '        <label class="chip" style="gap:6px"><input type="checkbox" id="rememberPassword" checked> Remember password</label>'
    + '        <select class="select" id="languageSelect" aria-label="Language" style="min-width:140px">'
    + '          <option value="en-US">en-US</option>'
    + '          <option value="ja-JP">ja-JP (placeholder)</option>'
    + '          <option value="zh-CN">zh-CN (placeholder)</option>'
    + '        </select>'
    + '        <span class="hint" id="rememberHint" style="margin-left:auto">localStorage</span>'
    + '      </div>'
    + '      <details id="customConn" style="border:1px solid var(--border, #e5e7eb); border-radius:8px; padding:8px 10px; background:var(--paper, #faf9f5)">'
    + '        <summary style="cursor:pointer; font-size:13px; font-weight:650; list-style:none; display:flex; align-items:center; gap:8px">Custom connection <span class="hint" style="margin-left:auto">apiBase override · localStorage ' + esc(CUSTOM_BASE_KEY) + '</span></summary>'
    + '        <div style="display:grid; gap:8px; margin-top:10px">'
    + '          <label class="hint" style="display:grid; gap:4px">Custom API base (optional)'
    + '            <input class="input mono" id="customApiBase" type="text" placeholder="https://your-host:3000" spellcheck="false" autocomplete="off" style="min-width:0">'
    + '          </label>'
    + '          <div class="hint">When set, probes use this origin for <code>/admin/*</code> (fetch respects same-origin CORS). Leave empty to use current origin (<code>' + esc((function () { try { return location.origin; } catch { return ""; } })()) + '</code>).</div>'
    + '          <div class="row"><button class="btn small ghost" id="saveCustomBase" type="button">Save custom base</button><button class="btn small ghost" id="clearCustomBase" type="button">Clear</button><span class="hint" id="customBaseStatus" role="status" aria-live="polite" style="margin-left:auto"></span></div>'
    + '        </div>'
    + '      </details>'
    + '      <div class="row" style="gap:8px">'
    + '        <button class="btn primary" id="loginSave" type="button" style="min-width:180px">Save &amp; continue → Dashboard</button>'
    + '        <button class="btn ghost" id="loginClear" type="button">Clear</button>'
    + '        <button class="btn ghost" id="loginProbe" type="button" title="GET /admin/credentials probe">Probe /admin/credentials</button>'
    + '        <span class="hint" id="loginStatus" role="status" aria-live="polite" style="margin-left:auto">—</span>'
    + '      </div>'
    + '      <div class="hint" style="border-top:1px solid var(--border, #e5e7eb); padding-top:10px; margin-top:2px">'
    + '        Stored in <code>localStorage</code> (<code>codebuffy_admin_key</code>) and sent as <code>Authorization: Bearer …</code> only to <code>/admin/*</code> on this host. Never logged. 401 → <code>Invalid admin credentials</code> toast + red dot. Open mode when no admin keys configured — <code>[adminAuth] no admin keys configured — /admin/* is open</code> (server warn).'
    + '      </div>'
    + '      <div class="card" style="background:var(--paper, #faf9f5); box-shadow:none">'
    + '        <div class="card-bd" style="display:grid; gap:6px">'
    + '          <strong style="font-size:13px">How auth resolves (src/middleware/admin-auth.ts)</strong>'
    + '          <div class="hint">1. <code>CODEBUFFY_ADMIN_KEYS</code> non-empty → Bearer must match it (timingSafeEqual).<br>2. Else if <code>CODEBUFFY_API_KEYS</code> non-empty → downstream keys are the admin allowlist (fallback).<br>3. Else open mode — no key required, but banner warns.</div>'
    + '          <div class="hint">401 anywhere → toast “Invalid admin credentials” + redirect stays on Login. <code>GET /admin/</code> + <code>/admin/ui/*</code> stay reachable without a key so the shell can prompt.</div>'
    + '        </div>'
    + '      </div>'
    + '    </div>'
    + '  </div>'
    + '  <div class="empty" style="border:1px dashed var(--border, #e5e7eb); background:var(--paper, #faf9f5); border-radius:10px; padding:16px; text-align:center; display:grid; gap:8px; place-items:center">'
    + '    <div style="font-weight:750">Already have the shell?</div>'
    + '    <div class="hint">This Login page replaces the shipped header-bar key input with a centered card. Same localStorage key, same 401 handling. Use Passkey in Settings when WebAuthn ships (501 today).</div>'
    + '    <a class="btn small" href="#/dashboard">← Back to Dashboard</a>'
    + '  </div>'
    + '</div>';

  var els = {
    apiBaseVal: container.querySelector("#l-apiBaseVal"),
    healthVal: container.querySelector("#l-healthVal"),
    openBadge: container.querySelector("#l-openBadge"),
    fallbackBadge: container.querySelector("#l-fallbackBadge"),
    adminBadge: container.querySelector("#l-adminBadge"),
    error: container.querySelector("#l-error"),
    keyInput: container.querySelector("#loginKey"),
    showBtn: container.querySelector("#showKeyBtn"),
    remember: container.querySelector("#rememberPassword"),
    rememberHint: container.querySelector("#rememberHint"),
    lang: container.querySelector("#languageSelect"),
    customDetails: container.querySelector("#customConn"),
    customInput: container.querySelector("#customApiBase"),
    saveCustom: container.querySelector("#saveCustomBase"),
    clearCustom: container.querySelector("#clearCustomBase"),
    customStatus: container.querySelector("#customBaseStatus"),
    saveBtn: container.querySelector("#loginSave"),
    clearBtn: container.querySelector("#loginClear"),
    probeBtn: container.querySelector("#loginProbe"),
    status: container.querySelector("#loginStatus")
  };

  function setError(msg, is401) {
    if (!els.error) return;
    if (!msg) { els.error.style.display = "none"; els.error.textContent = ""; return; }
    els.error.textContent = msg;
    els.error.style.display = "block";
    els.error.style.borderColor = is401 ? "#fecaca" : "#fde68a";
    els.error.style.background = is401 ? "#fef2f2" : "#fffbeb";
    els.error.style.color = is401 ? "#991b1b" : "#92400e";
  }

  function setStatus(msg, isError) {
    if (!els.status) return;
    els.status.textContent = msg;
    els.status.style.color = isError ? "#991b1b" : "";
  }

  // init field values
  var initialKey = getKey();
  if (els.keyInput) {
    els.keyInput.value = initialKey;
    if (initialKey) setStatus("Key loaded from localStorage.", false);
    else setStatus("No key stored.", false);
  }
  if (els.remember) {
    els.remember.checked = getRemember();
    if (els.rememberHint) els.rememberHint.textContent = els.remember.checked ? "persisted" : "session-only";
    els.remember.addEventListener("change", function () {
      setRemember(els.remember.checked);
      if (els.rememberHint) els.rememberHint.textContent = els.remember.checked ? "persisted" : "session-only";
      toastSafe(els.remember.checked ? "Remember: on (localStorage)" : "Remember: off — key still saved until Clear (see patch)", els.remember.checked ? "ok" : "");
    });
  }
  if (els.lang) {
    els.lang.value = getLocale();
    els.lang.addEventListener("change", function () {
      var v = els.lang.value;
      if (v !== "en-US") {
        toastSafe("Language " + v + " — placeholder (only en active)", "error");
      } else {
        toastSafe("Language: en-US", "ok");
      }
      setLocale(v);
    });
  }
  if (els.customInput) {
    els.customInput.value = getCustomBase();
    if (els.customStatus) els.customStatus.textContent = els.customInput.value ? "Custom base active" : "Using current origin";
  }

  if (els.showBtn && els.keyInput) {
    els.showBtn.addEventListener("click", function () {
      var isPw = els.keyInput.type === "password";
      els.keyInput.type = isPw ? "text" : "password";
      els.showBtn.textContent = isPw ? "Hide" : "Show";
      els.keyInput.focus();
    });
  }

  if (els.saveCustom) els.saveCustom.addEventListener("click", function () {
    var v = els.customInput ? els.customInput.value.trim() : "";
    if (v && v.indexOf("http://") !== 0 && v.indexOf("https://") !== 0) {
      if (els.customStatus) { els.customStatus.textContent = "Must start with http:// or https://"; els.customStatus.style.color = "#991b1b"; }
      toastSafe("Custom base must be http(s) url", "error");
      return;
    }
    if (v && /\/$/.test(v)) v = v.replace(/\/+$/, "");
    if (els.customInput) els.customInput.value = v;
    setCustomBase(v);
    if (els.customStatus) { els.customStatus.textContent = v ? "Saved: " + v : "Cleared — using current origin"; els.customStatus.style.color = ""; }
    toastSafe(v ? "Custom base saved" : "Custom base cleared", "ok");
    loadApiBase();
  });
  if (els.clearCustom) els.clearCustom.addEventListener("click", function () {
    if (els.customInput) els.customInput.value = "";
    setCustomBase("");
    if (els.customStatus) { els.customStatus.textContent = "Cleared — using current origin"; els.customStatus.style.color = ""; }
    toastSafe("Custom base cleared", "ok");
    loadApiBase();
  });

  function customOrigin() {
    var v = getCustomBase();
    if (!v) return "";
    return v.replace(/\/+$/, "");
  }

  function buildUrl(path) {
    var base = customOrigin();
    if (!base) return path;
    // ensure path starts with /
    if (path.charAt(0) !== "/") path = "/" + path;
    return base + path;
  }

  async function loadApiBase() {
    // try open /healthz (no auth) for version, then /readyz for upstream/store, then /admin/health if key present
    var apiBaseFallback = "https://copilot.tencent.com";
    var origin = "";
    try { origin = location.origin; } catch { origin = ""; }

    // show origin immediately
    if (els.apiBaseVal) els.apiBaseVal.textContent = getCustomBase() || origin || apiBaseFallback;

    // fetch healthz (open)
    try {
      var hz = await fetch(buildUrl("/healthz"), { method: "GET" }).then(async function (res) {
        var t = await res.text(); var j = null; try { j = t ? JSON.parse(t) : null; } catch { j = null; } return { res: res, json: j, text: t };
      });
      if (hz.res.ok && hz.json) {
        var ver = hz.json.version ? "v" + hz.json.version : "";
        var up = typeof hz.json.uptimeSeconds === "number" ? Math.round(hz.json.uptimeSeconds) + "s" : "";
        if (els.healthVal) els.healthVal.textContent = "health: " + (ver || "ok") + (up ? " · up " + up : "");
      }
    } catch { /* ignore */ }

    // try readyz for configured flag
    try {
      var rz = await fetch(buildUrl("/readyz"), { method: "GET" }).then(async function (res) {
        var t = await res.text(); var j = null; try { j = t ? JSON.parse(t) : null; } catch { j = null; } return { res: res, json: j };
      });
      if (rz.res.ok && rz.json && rz.json.upstream && typeof rz.json.upstream.configured !== "undefined") {
        // show upstream configured in tooltip? use healthVal append
        if (els.healthVal && rz.json.upstream.configured === false) {
          els.healthVal.textContent += " · upstream not configured";
        }
      }
      // detect auth mode via /admin/auth/mode probe or via ready store? Use adminAuth inference:
      // open mode detection: if no admin key and GET /admin/credentials gives 200 without key, it's open
      // we probe best-effort
      try {
        var probeNoAuth = await fetch(buildUrl("/admin/credentials"), { method: "GET" }).then(async function (res) {
          var t = await res.text(); var j = null; try { j = t ? JSON.parse(t) : null; } catch { j = null; } return { res: res, json: j };
        });
        if (probeNoAuth.res.status === 200) {
          // open mode (or downstream fallback with no key but still 200? shouldn't — 401 expected if keys set)
          if (els.openBadge) els.openBadge.style.display = "inline-flex";
          if (els.fallbackBadge) els.fallbackBadge.style.display = "none";
          if (els.adminBadge) els.adminBadge.style.display = "none";
        } else if (probeNoAuth.res.status === 401) {
          // keys are set, need Bearer — decide fallback vs admin-only by trying downstream? Can't distinguish without key — show fallback hint
          // keep all hidden until signed in; show fallback as info
          if (els.openBadge) els.openBadge.style.display = "none";
          // don't show fallback yet — wait for auth
        }
      } catch { /* ignore */ }
    } catch { /* ignore */ }

    // if key present, try admin health for more detail
    var k = getKey();
    if (k) {
      try {
        var apiFn = deps.api || function (path2, opts) {
          var h = {};
          try { var kk = getKey(); if (kk) h["Authorization"] = "Bearer " + kk; } catch { /* ignore */ }
          if (path2.indexOf("/admin/") !== 0) return Promise.reject(new Error("refusing non-admin path: " + path2));
          return fetch(buildUrl(path2), { method: (opts && opts.method) || "GET", headers: Object.assign({}, h, (opts && opts.headers) || {}) })
            .then(async function (res2) { var t2 = await res2.text(); var j2 = null; try { j2 = t2 ? JSON.parse(t2) : null; } catch { j2 = null; } return { res: res2, json: j2, text: t2 }; });
        };
        var ah = await apiFn("/admin/health", { method: "GET" });
        if (ah.res.ok && ah.json) {
          if (els.healthVal) {
            var hv = "";
            if (ah.json.version) hv += "v" + ah.json.version;
            if (typeof ah.json.uptimeSeconds === "number") hv += (hv ? " · " : "") + "up " + Math.round(ah.json.uptimeSeconds) + "s";
            if (hv) els.healthVal.textContent = "health: " + hv;
          }
        }
        // mode badges update after auth
        if (ah.res.ok) {
          if (els.adminBadge) els.adminBadge.style.display = "inline-flex";
          if (els.openBadge) els.openBadge.style.display = "none";
          if (els.fallbackBadge) els.fallbackBadge.style.display = "none";
        }
      } catch { /* ignore */ }
    }
  }

  loadApiBase();

  async function doSignIn() {
    var v = els.keyInput ? els.keyInput.value.trim() : "";
    if (!v) { setError("Enter an admin key before saving.", false); toastSafe("Enter a key before saving", "error"); setStatus("Missing key.", true); return; }
    if (v.length < 8) { setError("Key too short (min 8 chars).", false); toastSafe("Key too short (min 8 chars)", "error"); setStatus("Key too short.", true); return; }

    var remember = els.remember ? !!els.remember.checked : true;
    setRemember(remember);
    // persist per spec: localStorage codebuffy_admin_key when remember on; when off, still set but note
    // Existing adminAuth flow uses localStorage regardless — we honor remember flag but still write so redirect works.
    // If remember is off, warn that Clear will be needed to remove; actual removal would be on next load if we cleared here — but we need key for probe.
    setKey(v);
    if (!remember) {
      // store a marker so shell could optionally clear on unload (future), but keep key for this session probe
      try { localStorage.setItem("codebuffy_session_key", "1"); } catch { /* ignore */ }
    } else {
      try { localStorage.removeItem("codebuffy_session_key"); } catch { /* ignore */ }
    }
    setError("", false);
    setStatus("Checking…", false);
    if (els.saveBtn) els.saveBtn.disabled = true;

    var apiFn = deps.api || function (path2, opts) {
      var h = {};
      try { var kk = getKey(); if (kk) h["Authorization"] = "Bearer " + kk; } catch { /* ignore */ }
      if (path2.indexOf("/admin/") !== 0) return Promise.reject(new Error("refusing non-admin path: " + path2));
      return fetch(buildUrl(path2), { method: (opts && opts.method) || "GET", headers: Object.assign({}, h, (opts && opts.headers) || {}) })
        .then(async function (res2) { var t2 = await res2.text(); var j2 = null; try { j2 = t2 ? JSON.parse(t2) : null; } catch { j2 = null; } return { res: res2, json: j2, text: t2 }; });
    };

    try {
      var r = await apiFn("/admin/credentials", { method: "GET" });
      if (r.res.status === 401) {
        var msg401 = (r.json && r.json.error && r.json.error.message) ? r.json.error.message : "Invalid admin credentials";
        setError("401 — " + msg401 + " (isUnauthorized). Check CODEBUFFY_ADMIN_KEYS or downstream fallback.", true);
        setStatus("401 — invalid admin key.", true);
        toastSafe("401 — invalid admin key", "error");
        // keep key entered but indicate invalid — do not redirect
        if (els.saveBtn) els.saveBtn.disabled = false;
        return;
      }
      if (r.res.status === 503) {
        setError("503 — store not configured (pool unavailable, but auth ok).", false);
        setStatus("Auth ok · store 503", false);
        toastSafe("Store not configured (503) — auth still ok", "");
        // still consider sign-in success for open mode with store missing — allow dashboard
      } else if (!r.res.ok) {
        var msg = (r.json && r.json.error && r.json.error.message) ? r.json.error.message : r.text || ("HTTP " + r.res.status);
        setError("Probe failed: " + msg + " (status " + r.res.status + ")", false);
        setStatus("Probe: HTTP " + r.res.status, true);
        toastSafe(msg, "error");
        if (els.saveBtn) els.saveBtn.disabled = false;
        return;
      } else {
        setStatus("Key saved — probe 200 · redirecting…", false);
        toastSafe("Key saved — probe ok", "ok");
        setError("", false);
        if (els.adminBadge) { els.adminBadge.style.display = "inline-flex"; els.openBadge.style.display = "none"; els.fallbackBadge.style.display = "none"; }
      }

      // success → redirect to dashboard
      // honor remember flag: if off, note session-only
      if (!remember) toastSafe("Signed in (session-only — Clear on next visit if Remember is off)", "");
      try { location.hash = "#/dashboard"; } catch { /* ignore */ }
      // shell hash router also accepts #dashboard
      if (location.hash !== "#/dashboard" && location.hash !== "#dashboard") {
        try { location.hash = "#dashboard"; } catch { /* ignore */ }
      }
      // also dispatch hashchange for shells listening to replaceState
      try { window.dispatchEvent(new HashChangeEvent("hashchange")); } catch { /* ignore */ }
    } catch (e) {
      var m = e && e.message ? e.message : String(e);
      // distinguish network vs 401 already handled
      if (m && m.indexOf("refusing non-admin path") !== -1) {
        setError("Internal: " + m, false);
      } else {
        setError("Network/error: " + m, false);
      }
      setStatus("Sign-in failed.", true);
      toastSafe("Sign-in failed: " + m, "error");
    } finally {
      if (els.saveBtn) els.saveBtn.disabled = false;
    }
  }

  async function doProbe() {
    var v = els.keyInput ? els.keyInput.value.trim() : "";
    if (!v) { toastSafe("Set admin key first", "error"); setError("Set admin key first", false); return; }
    // temporarily set but don't persist if remember off? probe uses current input regardless
    var prev = getKey();
    var needRestore = false;
    if (v !== prev) { setKey(v); needRestore = true; }
    setStatus("Probing…", false);
    setError("", false);
    var apiFn = deps.api || function (path2, opts) {
      var h = {};
      try { var kk = getKey(); if (kk) h["Authorization"] = "Bearer " + kk; } catch { /* ignore */ }
      if (path2.indexOf("/admin/") !== 0) return Promise.reject(new Error("refusing non-admin path: " + path2));
      return fetch(buildUrl(path2), { method: (opts && opts.method) || "GET", headers: Object.assign({}, h, (opts && opts.headers) || {}) })
        .then(async function (res2) { var t2 = await res2.text(); var j2 = null; try { j2 = t2 ? JSON.parse(t2) : null; } catch { j2 = null; } return { res: res2, json: j2, text: t2 }; });
    };
    try {
      var r = await apiFn("/admin/credentials", { method: "GET" });
      if (r.res.status === 401) {
        setError("401 — invalid admin key (isUnauthorized).", true);
        setStatus("Probe: 401", true);
        toastSafe("401 — invalid admin key", "error");
      } else if (r.res.status === 503) {
        setError("503 — store not configured (auth ok, pool 503).", false);
        setStatus("Probe: 503", false);
        toastSafe("Probe 503 — auth ok, store unavailable", "");
      } else if (!r.res.ok) {
        var msg = (r.json && r.json.error && r.json.error.message) ? r.json.error.message : r.text || ("HTTP " + r.res.status);
        setError("Probe: " + r.res.status + " " + msg, r.res.status === 401);
        setStatus("Probe: HTTP " + r.res.status, true);
        toastSafe(msg, "error");
      } else {
        var n = r.json && Array.isArray(r.json.credentials) ? r.json.credentials.length : 0;
        setError("", false);
        setStatus("Probe ok — " + n + " credentials · 200", false);
        toastSafe("Probe ok (200) — " + n + " credentials", "ok");
      }
    } catch (e) {
      setError("Probe failed: " + (e && e.message ? e.message : String(e)), false);
      setStatus("Probe failed", true);
      toastSafe("Probe failed", "error");
    } finally {
      if (needRestore && !getRemember()) {
        // if remember off and we probed with different key, keep entered key? Leave as-is for sign-in
      }
    }
  }

  if (els.saveBtn) els.saveBtn.addEventListener("click", doSignIn);
  if (els.probeBtn) els.probeBtn.addEventListener("click", doProbe);
  if (els.clearBtn) els.clearBtn.addEventListener("click", function () {
    clearKey();
    if (els.keyInput) els.keyInput.value = "";
    setError("", false);
    setStatus("Key cleared.", false);
    toastSafe("Key cleared", "ok");
    try { localStorage.removeItem("codebuffy_session_key"); } catch { /* ignore */ }
    // reset badges
    if (els.openBadge) els.openBadge.style.display = "none";
    if (els.fallbackBadge) els.fallbackBadge.style.display = "none";
    if (els.adminBadge) els.adminBadge.style.display = "none";
    loadApiBase();
  });
  if (els.keyInput) {
    els.keyInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") doSignIn();
    });
    els.keyInput.addEventListener("input", function () {
      setError("", false);
    });
  }

  // custom base enter
  if (els.customInput) els.customInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { if (els.saveCustom) els.saveCustom.click(); }
  });

  // expose for shell tests
  container._codebuffyLogin = { doSignIn: doSignIn, doProbe: doProbe };
}

export default { render: render };

if (typeof window !== "undefined") {
  window.CodebuffyLoginRender = render;
}
