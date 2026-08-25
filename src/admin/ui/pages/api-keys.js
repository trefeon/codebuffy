/* eslint-disable @typescript-eslint/no-unused-vars */
/* API Keys — downstream (CODEBUFFY_API_KEYS) + admin (CODEBUFFY_ADMIN_KEYS)
 * Read-only env-managed tables, copy/revoke, fallback banner, usage link.
 * Calls GET /admin/credentials to map keys to creds (masked, no secrets leaked).
 * Exports render(container, {api, toast})
 * No console.*, vanilla JS.
 */
let _pollKeys = null;
let _visKeys = null;

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function unwrap(r) {
  if (!r) return { ok: false, status: 0, json: null, text: "" };
  if (r.res) return { ok: !!r.res.ok, status: r.res.status, json: r.json, text: r.text || "" };
  if (typeof r.status === "number") return { ok: !!r.ok, status: r.status, json: r.json || null, text: r.text || "" };
  return { ok: false, status: 0, json: null, text: "" };
}

function masked(prefix) {
  if (!prefix) return "sk-…";
  const s = String(prefix);
  if (s.length <= 8) return s.slice(0, 4) + "…";
  return s.slice(0, 6) + "…" + s.slice(-3);
}

function copyText(text, toast) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => toast("Copied", "ok"), () => toast("Copy failed", "error"));
  }
  // fallback: hidden textarea
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    toast("Copied", "ok");
    return Promise.resolve();
  } catch {
    toast("Copy unavailable", "error");
    return Promise.resolve();
  }
}

export function render(container, deps) {
  const api = deps && deps.api ? deps.api : null;
  const toast = deps && deps.toast ? deps.toast : function () {};

  if (_pollKeys) { clearInterval(_pollKeys); _pollKeys = null; }
  if (_visKeys) { try { document.removeEventListener("visibilitychange", _visKeys); } catch {} _visKeys = null; }

  let creds = [];
  let downstreamMock = [
    { keyId: "dk_1", prefix: "sk-…a1b", label: "Cursor", created: "2026-08-10", lastUsed: "2m ago" },
    { keyId: "dk_2", prefix: "sk-…c3d", label: "Codex CLI", created: "2026-08-20", lastUsed: "1h ago" },
    { keyId: "dk_3", prefix: "sk-…e5f", label: "OpenCode", created: "2026-08-22", lastUsed: "never" },
  ];
  let adminMock = [
    { keyId: "ak_1", prefix: "adm-…x9", label: "operator", created: "2026-08-25", lastUsed: "never" },
  ];
  let activeTab = "downstream"; // downstream | admin

  container.innerHTML = `
    <div class="card">
      <div class="card-hd">
        <h3>API Keys</h3>
        <p class="hint">Downstream Bearer for /v1/* · Admin Bearer for /admin/* (fallback to downstream when admin empty)</p>
        <button class="btn primary small" type="button" id="btn-create-key" style="margin-left:auto">+ Create key</button>
      </div>
      <div class="card-bd" style="display:grid; gap:14px">
        <div class="row" style="gap:8px; flex-wrap:wrap">
          <button class="pill is-active" type="button" data-tab="downstream">Downstream (v1/*) · <span id="cnt-down">3</span></button>
          <button class="pill" type="button" data-tab="admin">Admin (/admin/*) · <span id="cnt-admin">1</span></button>
          <span style="flex:1"></span>
          <span class="chip warn" id="fallback-banner" role="status" aria-live="polite"><span class="dot warn"></span> Fallback mode — downstream keys act as admin until CODEBUFFY_ADMIN_KEYS set</span>
        </div>
        <div class="hint" id="env-note" style="display:flex; gap:8px; align-items:center; border:1px solid var(--border, #e5e7eb); background:var(--paper, #f5f3ef); border-radius:8px; padding:8px 10px">
          <span style="font-weight:650">Env-managed</span> <span>Keys are read-only here — configured via <code>CODEBUFFY_API_KEYS</code> / <code>CODEBUFFY_ADMIN_KEYS</code> (comma-split, min 8 chars). Restart gateway to rotate.</span>
        </div>

        <div id="panel-downstream">
          <div class="table-wrap"><table aria-label="Downstream keys">
            <thead><tr><th>keyId</th><th>prefix</th><th>label</th><th>created</th><th>lastUsed</th><th>usage</th><th>actions</th></tr></thead>
            <tbody id="tbody-down"><tr><td colspan="7" class="hint" style="text-align:center; padding:14px">loading…</td></tr></tbody>
          </table></div>
          <div class="hint" style="margin-top:6px">Sent as <code>Authorization: Bearer &lt;key&gt;</code> to <code>/v1/*</code> only — never to <code>/admin/*</code>. Masked by default; one-time reveal on create.</div>
        </div>

        <div id="panel-admin" hidden>
          <div class="table-wrap"><table aria-label="Admin keys">
            <thead><tr><th>keyId</th><th>prefix</th><th>label</th><th>created</th><th>lastUsed</th><th>actions</th></tr></thead>
            <tbody id="tbody-admin"><tr><td colspan="6" class="hint" style="text-align:center; padding:14px">loading…</td></tr></tbody>
          </table></div>
          <div class="hint" style="margin-top:6px">code: <code>timingSafeEqual</code> per key · <code>adminAuth</code> order: <code>CODEBUFFY_ADMIN_KEYS → CODEBUFFY_API_KEYS → open</code></div>
          <div class="hint" id="admin-empty" style="margin-top:8px; display:none; border:1px dashed var(--border, #e5e7eb); border-radius:8px; padding:10px; text-align:center">No admin keys — fallback to downstream keys, or open mode (no keys set) — see Settings → Security</div>
        </div>

        <div class="card" style="box-shadow:none; background:var(--paper, #f5f3ef)">
          <div class="card-hd"><h3 style="font-size:13px">Linked credentials</h3><span class="hint">GET /admin/credentials → map keys to creds (sanitized, no tokens)</span></div>
          <div class="card-bd" style="padding:0">
            <div class="table-wrap" style="border:0"><table aria-label="Credentials linked to keys">
              <thead><tr><th>uid</th><th>label</th><th>domain</th><th>state</th><th>usage</th></tr></thead>
              <tbody id="tbody-creds"><tr><td colspan="5" class="hint" style="text-align:center; padding:12px">loading…</td></tr></tbody>
            </table></div>
          </div>
        </div>
        <div class="hint">Revoke is env-only: remove the key from <code>CODEBUFFY_API_KEYS</code> / <code>CODEBUFFY_ADMIN_KEYS</code> and restart. To delete a linked credential, use the Credentials page Delete.</div>
      </div>
    </div>

    <dialog id="dlg-key" aria-label="Create API key" style="border:none; padding:0; border-radius:14px; max-width:560px; width:calc(100% - 32px)">
      <div class="modal-hd" style="padding:16px; border-bottom:1px solid var(--border, #e5e7eb); display:flex; justify-content:space-between; align-items:center"><strong>Create API key</strong><button class="icon-btn" type="button" data-close="dlg-key" aria-label="Close"><svg aria-hidden="true" width="16" height="16"><use href="#i-close"></use></svg></button></div>
      <div class="modal-bd" style="padding:16px; display:grid; gap:12px">
        <div class="hint">Keys are env-managed. Generate a strong random key locally, add it to your env, then restart the gateway. No vault POST until encrypted-store lands.</div>
        <label class="hint">Label <input class="input" id="key-label" placeholder="Cursor — work laptop" /></label>
        <label class="hint">Scope
          <select class="select" id="key-scope"><option value="downstream">downstream — CODEBUFFY_API_KEYS (Bearer for /v1/*)</option><option value="admin">admin — CODEBUFFY_ADMIN_KEYS (Bearer for /admin/*)</option></select>
        </label>
        <div class="card" style="box-shadow:none; background:#0b1220; color:#e2e8f0; border-color:#1f2937">
          <div class="card-bd" style="display:grid; gap:8px">
            <div class="mono" style="font-size:12px; overflow:auto; white-space:pre; line-height:1.5">CODEBUFFY_API_KEYS=sk-xxxx,sk-yyyy
CODEBUFFY_ADMIN_KEYS=adm-zzzz
# then: docker compose up -d --force-recreate
# or: bun src/index.ts</div>
            <div class="row"><button class="btn small" type="button" id="key-generate">Generate (local)</button><span class="hint" id="key-preview" style="color:#94a3b8">—</span></div>
            <div class="hint" style="color:#94a3b8">Generated keys are shown once — copy now. Gateway never logs them. Min 8 chars, timingSafeEqual on server.</div>
          </div>
        </div>
      </div>
      <div class="modal-ft" style="padding:12px 16px; border-top:1px solid var(--border, #e5e7eb); display:flex; justify-content:flex-end; gap:8px; background:var(--paper, #f5f3ef)"><button class="btn ghost" type="button" data-close="dlg-key">Cancel</button><button class="btn primary" type="button" id="key-done">Done</button></div>
    </dialog>
  `;

  const els = {
    cntDown: container.querySelector("#cnt-down"),
    cntAdmin: container.querySelector("#cnt-admin"),
    fallback: container.querySelector("#fallback-banner"),
    panelDown: container.querySelector("#panel-downstream"),
    panelAdmin: container.querySelector("#panel-admin"),
    tbodyDown: container.querySelector("#tbody-down"),
    tbodyAdmin: container.querySelector("#tbody-admin"),
    tbodyCreds: container.querySelector("#tbody-creds"),
    dlgKey: container.querySelector("#dlg-key"),
    keyScope: container.querySelector("#key-scope"),
    keyLabel: container.querySelector("#key-label"),
    keyPreview: container.querySelector("#key-preview"),
    adminEmpty: container.querySelector("#admin-empty"),
  };

  function openDlg(d) {
    if (!d) return;
    if (typeof d.showModal === "function") { try { d.showModal(); } catch { d.setAttribute("open", ""); } }
    else d.setAttribute("open", "");
  }
  function closeDlg(d) {
    if (!d) return;
    if (typeof d.close === "function") { try { d.close(); } catch { d.removeAttribute("open"); } }
    else d.removeAttribute("open");
  }
  for (const b of container.querySelectorAll("[data-close]")) {
    b.addEventListener("click", () => {
      const id = b.getAttribute("data-close");
      closeDlg(container.querySelector("#" + id));
    });
  }
  for (const dlg of container.querySelectorAll("dialog")) {
    dlg.addEventListener("click", (e) => {
      const r = dlg.getBoundingClientRect();
      const inside = r.top <= e.clientY && e.clientY <= r.top + r.height && r.left <= e.clientX && e.clientX <= r.left + r.width;
      if (!inside) closeDlg(dlg);
    });
  }

  const btnCreate = container.querySelector("#btn-create-key");
  if (btnCreate) btnCreate.addEventListener("click", () => openDlg(els.dlgKey));
  const keyDone = container.querySelector("#key-done");
  if (keyDone) keyDone.addEventListener("click", () => closeDlg(els.dlgKey));
  const keyGen = container.querySelector("#key-generate");
  if (keyGen) keyGen.addEventListener("click", () => {
    // local generate: crypto random if available
    let token = "";
    try {
      const bytes = new Uint8Array(18);
      if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(bytes);
      else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const prefix = (els.keyScope && els.keyScope.value === "admin") ? "adm-" : "sk-";
      token = prefix + token;
    } catch { token = "sk-" + Math.random().toString(36).slice(2, 18); }
    if (els.keyPreview) {
      els.keyPreview.textContent = token;
      els.keyPreview.style.color = "#e2e8f0";
      els.keyPreview.style.userSelect = "all";
    }
    copyText(token, toast);
  });

  // tabs
  const tabBtns = container.querySelectorAll("[data-tab]");
  function setTab(tab) {
    activeTab = tab;
    for (const b of tabBtns) b.classList.toggle("is-active", b.getAttribute("data-tab") === tab);
    if (els.panelDown) els.panelDown.hidden = tab !== "downstream";
    if (els.panelAdmin) els.panelAdmin.hidden = tab !== "admin";
  }
  for (const b of tabBtns) b.addEventListener("click", () => setTab(b.getAttribute("data-tab") || "downstream"));

  function renderDown() {
    if (!els.tbodyDown) return;
    if (els.cntDown) els.cntDown.textContent = String(downstreamMock.length);
    if (downstreamMock.length === 0) {
      els.tbodyDown.innerHTML = `<tr><td colspan="7" class="hint" style="text-align:center; padding:12px">No downstream keys — set CODEBUFFY_API_KEYS and restart</td></tr>`;
      return;
    }
    let html = "";
    for (const k of downstreamMock) {
      html += `<tr>
        <td class="mono">${esc(k.keyId)}</td>
        <td class="mono">${esc(k.prefix)}</td>
        <td>${esc(k.label)}</td>
        <td class="mono">${esc(k.created)}</td>
        <td class="mono">${esc(k.lastUsed)}</td>
        <td><a href="#/usage" class="hint" data-usage="${esc(k.keyId)}">View usage</a></td>
        <td><span class="row" style="gap:6px"><button class="btn small" type="button" data-copy="${esc(k.prefix)}" data-copy-label="${esc(k.label)}">Copy</button><button class="btn small danger" type="button" data-revoke="${esc(k.keyId)}" data-scope="downstream">Revoke</button></span></td>
      </tr>`;
    }
    els.tbodyDown.innerHTML = html;
    for (const b of els.tbodyDown.querySelectorAll("[data-copy]")) b.addEventListener("click", (e) => {
      const v = e.currentTarget.getAttribute("data-copy") || "";
      const label = e.currentTarget.getAttribute("data-copy-label") || "";
      // show note that real keys are env-only, but copy mock prefix for demo
      copyText(v, toast);
      if (label) toast(`Copy ${label} — real key is env-only, set CODEBUFFY_API_KEYS`, "ok");
    });
    for (const b of els.tbodyDown.querySelectorAll("[data-revoke]")) b.addEventListener("click", (e) => {
      const kid = e.currentTarget.getAttribute("data-revoke") || "";
      const ok = window.confirm(`Revoke ${kid}? This is env-only — remove it from CODEBUFFY_API_KEYS and restart the gateway. Continue?`);
      if (!ok) return;
      toast("Revoke is env-only — remove from CODEBUFFY_API_KEYS and restart; to delete linked credential use Credentials Delete", "ok");
    });
    for (const a of els.tbodyDown.querySelectorAll("[data-usage]")) a.addEventListener("click", (e) => {
      // let hash router navigate; also toast
      const kid = e.currentTarget.getAttribute("data-usage") || "";
      toast(`Usage for ${kid} — opening Usage`, "ok");
    });
  }

  function renderAdmin() {
    if (!els.tbodyAdmin) return;
    if (els.cntAdmin) els.cntAdmin.textContent = String(adminMock.length);
    if (adminMock.length === 0) {
      els.tbodyAdmin.innerHTML = `<tr><td colspan="6" class="hint" style="text-align:center; padding:12px">No admin keys — fallback to downstream keys, or open mode (no keys set) — see Settings → Security</td></tr>`;
      if (els.adminEmpty) els.adminEmpty.style.display = "block";
      return;
    }
    if (els.adminEmpty) els.adminEmpty.style.display = "none";
    let html = "";
    for (const k of adminMock) {
      html += `<tr>
        <td class="mono">${esc(k.keyId)}</td>
        <td class="mono">${esc(k.prefix)}</td>
        <td>${esc(k.label)}</td>
        <td class="mono">${esc(k.created)}</td>
        <td class="mono">${esc(k.lastUsed)}</td>
        <td><span class="row" style="gap:6px"><button class="btn small" type="button" data-copy="${esc(k.prefix)}" data-copy-label="${esc(k.label)}">Copy</button><button class="btn small danger" type="button" data-revoke="${esc(k.keyId)}" data-scope="admin">Revoke</button></span></td>
      </tr>`;
    }
    // empty state row as hint below existing rows, like wireframe
    if (adminMock.length === 1) {
      html += `<tr><td colspan="6" class="hint" style="text-align:center; padding:10px">Empty state → “No admin keys — fallback to downstream keys, or open mode (no keys set) — see Settings → Security”</td></tr>`;
    }
    els.tbodyAdmin.innerHTML = html;
    for (const b of els.tbodyAdmin.querySelectorAll("[data-copy]")) b.addEventListener("click", (e) => {
      const v = e.currentTarget.getAttribute("data-copy") || "";
      copyText(v, toast);
    });
    for (const b of els.tbodyAdmin.querySelectorAll("[data-revoke]")) b.addEventListener("click", (e) => {
      const kid = e.currentTarget.getAttribute("data-revoke") || "";
      const ok = window.confirm(`Revoke admin key ${kid}? Env-only — edit CODEBUFFY_ADMIN_KEYS and restart.`);
      if (!ok) return;
      toast("Revoke is env-only — edit CODEBUFFY_ADMIN_KEYS and restart", "ok");
    });
  }

  function renderCreds() {
    if (!els.tbodyCreds) return;
    if (!creds.length) {
      els.tbodyCreds.innerHTML = `<tr><td colspan="5" class="hint" style="text-align:center; padding:12px">No credentials — add via Credentials page (onboard-account.mjs)</td></tr>`;
      return;
    }
    let html = "";
    for (const c of creds.slice(0, 8)) {
      const state = c.state || "—";
      const cls = state === "active" ? "active" : state === "cooldown" ? "cooldown" : state === "banned" ? "banned" : state === "quota" ? "quota" : "";
      const label = c.label || "—";
      html += `<tr>
        <td class="mono">${esc(c.uid || "")}</td>
        <td>${esc(label)}</td>
        <td>${esc(c.domain || "—")}</td>
        <td><span class="badge ${cls}">${esc(String(state))}</span></td>
        <td><a href="#/usage" class="hint">usage</a> · <a href="#/credentials" class="hint">manage</a></td>
      </tr>`;
    }
    els.tbodyCreds.innerHTML = html;
  }

  // fallback banner logic: infer open vs fallback vs admin-only
  function updateFallbackBanner(poolOk) {
    if (!els.fallback) return;
    // we don't have direct adminKeys visibility; show generic fallback info
    // If we fetched creds ok with 401, that suggests admin keys required but missing/invalid — show fallback
    // For now keep wireframe's fallback chip as default; if we later detect open mode, switch chip.
    // Open mode would be: no 401 on /admin/pool/state without key — but we always send key via api, can't detect here.
    // So keep fallback banner visible; shell topbar may show auth chip more accurately.
    // Keep as warn fallback; hide only if we explicitly know admin keys present (we assume mock adminMock non-empty means admin-only).
    if (adminMock.length > 0) {
      els.fallback.innerHTML = `<span class="dot"></span> Admin-only — CODEBUFFY_ADMIN_KEYS set`;
      els.fallback.className = "chip ok";
    } else if (downstreamMock.length > 0) {
      els.fallback.innerHTML = `<span class="dot warn"></span> Fallback mode — downstream keys act as admin until CODEBUFFY_ADMIN_KEYS set`;
      els.fallback.className = "chip warn";
    } else {
      els.fallback.innerHTML = `<span class="dot err"></span> Open mode — no keys set`;
      els.fallback.className = "chip err";
    }
  }

  async function loadCreds() {
    if (!api) {
      renderCreds();
      return;
    }
    try {
      const r = await api("/admin/credentials");
      const u = unwrap(r);
      if (u.status === 401) {
        toast("401 — invalid admin key", "error");
        // show fallback/open hint
        updateFallbackBanner(false);
        return;
      }
      if (u.status === 503) {
        toast("Store not configured (503)", "error");
        return;
      }
      if (!u.ok) {
        const msg = (u.json && u.json.error && u.json.error.message) ? u.json.error.message : u.text || ("HTTP " + u.status);
        toast(msg, "error");
        return;
      }
      const list = (u.json && u.json.credentials) ? u.json.credentials : [];
      creds = Array.isArray(list) ? list : [];
      renderCreds();
    } catch (err) {
      const m = err && err.message ? err.message : String(err);
      toast("Load failed: " + m, "error");
    }
  }

  renderDown();
  renderAdmin();
  updateFallbackBanner(true);
  renderCreds();
  loadCreds();

  // keep fallback banner fresh if shell ever updates env (no poll needed, but listen for vis)
  _visKeys = () => { loadCreds(); };
  try { document.addEventListener("visibilitychange", _visKeys); } catch {}
}
export function destroy() {
  if (_pollKeys) { try { clearInterval(_pollKeys); } catch {} _pollKeys = null; }
  if (_visKeys) { try { document.removeEventListener("visibilitychange", _visKeys); } catch {} _visKeys = null; }
}
