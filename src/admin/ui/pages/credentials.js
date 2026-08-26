/* eslint-disable @typescript-eslint/no-unused-vars */
/* Credentials — cards + table toggle, health chips, bulk, modals
 * GET /admin/credentials → cards/table
 * DELETE /admin/credentials/:uid  POST /admin/checkin/:uid
 * Poll GET /admin/pool/state every 10s for byUid enrichment
 * Exports render(container, {api, toast})
 * No console.*, vanilla JS.
 */
let _poll = null;
let _vis = null;

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function fmtExpires(val) {
  if (!val) return "—";
  try {
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) return String(val);
    return d.toLocaleString();
  } catch {
    return String(val);
  }
}

function fmtRelative(val) {
  if (!val) return "";
  try {
    const d = new Date(val);
    const ms = d.getTime() - Date.now();
    const days = Math.round(ms / 86400000);
    if (Number.isNaN(days)) return "";
    if (days === 0) return "today";
    if (days === 1) return "in 1d";
    if (days > 1) return `in ${days}d`;
    if (days === -1) return "1d ago";
    if (days < 0) return `${Math.abs(days)}d ago · expired`;
    return "";
  } catch {
    return "";
  }
}

function badgeForState(state) {
  const s = String(state || "").toLowerCase();
  if (s === "active") return `<span class="badge active">active ●</span>`;
  if (s === "cooldown") return `<span class="badge cooldown">cooldown ◐</span>`;
  if (s === "banned") return `<span class="badge banned">banned</span>`;
  if (s === "quota") return `<span class="badge quota">quota ◑</span>`;
  if (!s || s === "—" || s === "null") return `<span class="badge">—</span>`;
  return `<span class="badge">${esc(s)}</span>`;
}

function unwrap(r) {
  if (!r) return { ok: false, status: 0, json: null, text: "" };
  if (r.res) return { ok: !!r.res.ok, status: r.res.status, json: r.json, text: r.text || "" };
  if (typeof r.status === "number") return { ok: !!r.ok, status: r.status, json: r.json || null, text: r.text || "" };
  return { ok: false, status: 0, json: null, text: "" };
}

export function render(container, deps) {
  const api = deps && deps.api ? deps.api : null;
  const toast = deps && deps.toast ? deps.toast : function () {};

  if (_poll) { clearInterval(_poll); _poll = null; }
  if (_vis) { try { document.removeEventListener("visibilitychange", _vis); } catch {} _vis = null; }

  let creds = [];
  let byUid = null;
  let poolJson = null;
  let view = "cards"; // cards | table
  let selected = new Set();
  let search = "";
  let domainFilter = "";
  let stateFilter = "";
  let expirySort = "none"; // none | soon

  container.innerHTML = `
    <div class="card">
      <div class="card-hd">
        <h3>Credentials</h3>
        <p class="hint">GET /admin/credentials · DELETE /admin/credentials/:uid · POST /admin/checkin/:uid</p>
        <span class="hint" id="cred-count" style="margin-left:auto">—</span>
      </div>
      <div class="card-bd" style="display:grid; gap:12px">
        <div class="filterbar" role="search" aria-label="Filter credentials">
          <input class="input" id="cred-search" placeholder="Search uid / label…" aria-label="Search credentials" style="max-width:260px" />
          <select class="select" id="cred-domain" aria-label="Domain"><option value="">All domains</option><option value="copilot.tencent.com">copilot.tencent.com</option></select>
          <select class="select" id="cred-state" aria-label="State"><option value="">All states</option><option value="active">active</option><option value="cooldown">cooldown</option><option value="banned">banned</option><option value="quota">quota</option></select>
          <select class="select" id="cred-expiry" aria-label="Expiry"><option value="none">Expiry: any</option><option value="soon">Expiring soon first</option></select>
          <span style="flex:1"></span>
          <span class="row">
            <button class="btn small" type="button" id="btn-bulk">Bulk ▾</button>
            <button class="btn small" type="button" id="btn-env">Add env file</button>
            <button class="btn primary small" type="button" id="btn-add">+ Add account</button>
          </span>
        </div>
        <div class="row" style="justify-content:space-between">
          <span class="row">
            <span class="hint">Group by:</span>
            <button class="pill is-active" type="button" data-group="none">none</button>
            <button class="pill" type="button" data-group="domain">domain</button>
            <button class="pill" type="button" data-group="state">state</button>
          </span>
          <span class="row">
            <span class="hint">View:</span>
            <button class="pill is-active" type="button" id="view-cards">Cards ■</button>
            <button class="pill" type="button" id="view-table">Table ▭</button>
          </span>
        </div>

        <div id="cred-bulkbar" class="card" style="display:none; padding:10px 12px; background:var(--paper, #f5f3ef); box-shadow:none; border-style:dashed">
          <div class="row" style="justify-content:space-between">
            <label class="hint" style="display:flex; gap:8px; align-items:center"><input type="checkbox" id="bulk-select-all" /> <span id="bulk-count">0 selected</span></label>
            <span class="row">
              <button class="btn small danger" type="button" id="bulk-delete">Delete</button>
              <button class="btn small" type="button" id="bulk-checkin">Check-in</button>
              <button class="btn small ghost" type="button" id="bulk-export">Export JSON</button>
              <button class="btn small ghost" type="button" id="bulk-clear">Clear</button>
            </span>
          </div>
        </div>

        <div id="cred-cards" class="grid-cards" aria-live="polite"></div>
        <div id="cred-table-wrap" class="table-wrap" hidden>
          <table aria-label="Credentials table">
            <thead><tr><th><input type="checkbox" aria-label="Select all" id="tbl-select-all" /></th><th>uid</th><th>label</th><th>domain</th><th>expiresAt</th><th>state</th><th>checkin</th><th>actions</th></tr></thead>
            <tbody id="cred-tbody"><tr><td colspan="8" class="hint" style="text-align:center; padding:16px">loading…</td></tr></tbody>
          </table>
        </div>
        <div class="row hint" style="justify-content:space-between">
          <span id="cred-hint">Delete is immediate and needs confirm · Check-in posts to POST /admin/checkin/:uid · poll 10s</span>
          <span id="cred-pool-note" class="hint"></span>
        </div>
      </div>
    </div>

    <dialog id="dlg-add" aria-label="Add account" style="border:none; padding:0; border-radius:14px; max-width:560px; width:calc(100% - 32px)">
      <div class="modal-hd" style="padding:16px; border-bottom:1px solid var(--border, #e5e7eb); display:flex; justify-content:space-between; align-items:center"><strong>Add account</strong><button class="icon-btn" type="button" data-close="dlg-add" aria-label="Close"><svg aria-hidden="true" width="16" height="16"><use href="#i-close"></use></svg></button></div>
      <div class="modal-bd" style="padding:16px; display:grid; gap:12px">
        <div class="hint">No raw paste endpoint until encrypted-store lands. Use the onboarding script below — it writes one pool file per account via official flows.</div>
        <div class="card" style="box-shadow:none; background:var(--paper, #f5f3ef); border:1px dashed var(--border, #e5e7eb); padding:10px 12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap">
          <span class="hint" style="font-weight:650">Site</span>
          <button class="pill is-active" type="button" data-cred-site="cn">CN · copilot.tencent.com</button>
          <button class="pill" type="button" data-cred-site="intl">Intl · www.codebuddy.ai</button>
          <span class="hint" style="margin-left:auto">Indo → Intl</span>
        </div>
        <div class="card" style="box-shadow:none; background:var(--paper, #f5f3ef)">
          <div class="card-bd" style="display:grid; gap:8px">
            <div class="mono" id="cred-onboard-cmd" style="font-size:12px; background:#0b1220; color:#e2e8f0; padding:10px; border-radius:8px; overflow:auto">
bun scripts/onboard-account.mjs --label "work-buddy-3" --provision-key --verify<br/>
bun scripts/onboard-account.mjs --from-auth-file ~/Library/Application\\ Support/CodeBuddy/auth.json --label acc-1<br/>
bun scripts/onboard-account.mjs --pool-file data/pool/a1b2.json --verify
            </div>
            <div class="hint">Legal posture: human-per-account registration only; script automates only official device-flow / console validation / API-key management.</div>
          </div>
        </div>
        <label class="hint">Docs <span class="row"><a href="#" class="hint" data-doc>research/08-account-onboarding-guide.md</a> <span class="hint">·</span> <span class="hint">research/02-auth-and-token-lifecycle.md §3.2, §5, §7</span></span></label>
      </div>
      <div class="modal-ft" style="padding:12px 16px; border-top:1px solid var(--border, #e5e7eb); display:flex; justify-content:flex-end; gap:8px; background:var(--paper, #f5f3ef)"><button class="btn ghost" type="button" data-close="dlg-add">Close</button><button class="btn primary" type="button" id="btn-copy-onboard">Copy command</button></div>
    </dialog>

    <dialog id="dlg-env" aria-label="Add environment file" style="border:none; padding:0; border-radius:14px; max-width:560px; width:calc(100% - 32px)">
      <div class="modal-hd" style="padding:16px; border-bottom:1px solid var(--border, #e5e7eb); display:flex; justify-content:space-between; align-items:center"><strong>Add environment file</strong><button class="icon-btn" type="button" data-close="dlg-env" aria-label="Close"><svg aria-hidden="true" width="16" height="16"><use href="#i-close"></use></svg></button></div>
      <div class="modal-bd" style="padding:16px; display:grid; gap:12px">
        <div class="hint">Paste a <code>.env</code> snippet to import pool files. Wireframe only — real import validates via <code>POST /admin/credentials</code> (future) or writes to <code>data/pool/</code> then restart gateway.</div>
        <textarea class="textarea mono" id="env-text" rows="6" placeholder="CODEBUFFY_DB_PATH=data/codebuffy.db&#10;CODEBUFFY_ENCRYPTION_KEY=...&#10;# pool files live in data/pool/*.json (one per uid)" spellcheck="false"></textarea>
        <div class="hint">Existing creds: <span id="env-existing">—</span></div>
      </div>
      <div class="modal-ft" style="padding:12px 16px; border-top:1px solid var(--border, #e5e7eb); display:flex; justify-content:flex-end; gap:8px; background:var(--paper, #f5f3ef)"><button class="btn ghost" type="button" data-close="dlg-env">Cancel</button><button class="btn primary" type="button" id="btn-env-import">Import (mock)</button></div>
    </dialog>

    <dialog id="dlg-bulk" aria-label="Bulk actions" style="border:none; padding:0; border-radius:14px; max-width:560px; width:calc(100% - 32px)">
      <div class="modal-hd" style="padding:16px; border-bottom:1px solid var(--border, #e5e7eb); display:flex; justify-content:space-between; align-items:center"><strong>Bulk</strong><button class="icon-btn" type="button" data-close="dlg-bulk" aria-label="Close"><svg aria-hidden="true" width="16" height="16"><use href="#i-close"></use></svg></button></div>
      <div class="modal-bd" style="padding:16px; display:grid; gap:12px">
        <div class="hint">Select via cards/table checkboxes, then act on all selected. Mirrors olay panel bulkKey/bulkDelete.</div>
        <label class="hint">Paste JSON array to import (future POST /admin/credentials)<textarea class="textarea mono" id="bulk-json" rows="6" placeholder='[{"uid":"a1b2...","label":"acc-1","domain":"copilot.tencent.com"}]' spellcheck="false"></textarea></label>
        <div class="row"><span class="hint" id="bulk-hint">0 selected</span><span style="flex:1"></span><button class="btn small ghost" type="button" id="bulk-copy-json">Copy selected JSON</button></div>
      </div>
      <div class="modal-ft" style="padding:12px 16px; border-top:1px solid var(--border, #e5e7eb); display:flex; justify-content:flex-end; gap:8px; background:var(--paper, #f5f3ef)"><button class="btn ghost" type="button" data-close="dlg-bulk">Close</button><button class="btn primary" type="button" id="bulk-import-json">Import (mock)</button></div>
    </dialog>

    <dialog id="dlg-detail" aria-label="Credential detail" style="border:none; padding:0; border-radius:14px; max-width:560px; width:calc(100% - 32px)">
      <div class="modal-hd" style="padding:16px; border-bottom:1px solid var(--border, #e5e7eb); display:flex; justify-content:space-between; align-items:center"><strong>Details</strong><button class="icon-btn" type="button" data-close="dlg-detail" aria-label="Close"><svg aria-hidden="true" width="16" height="16"><use href="#i-close"></use></svg></button></div>
      <div class="modal-bd" style="padding:16px; display:grid; gap:10px">
        <pre id="detail-pre" style="margin:0; padding:12px; background:#0b1220; color:#e2e8f0; border-radius:8px; overflow:auto; font-size:12px; line-height:1.5; max-height:320px"></pre>
        <div class="hint">Source: GET /admin/credentials/:uid + byUid state from pool</div>
      </div>
      <div class="modal-ft" style="padding:12px 16px; border-top:1px solid var(--border, #e5e7eb); display:flex; justify-content:flex-end; gap:8px; background:var(--paper, #f5f3ef)"><button class="btn ghost" type="button" data-close="dlg-detail">Close</button></div>
    </dialog>
  `;

  const els = {
    count: container.querySelector("#cred-count"),
    search: container.querySelector("#cred-search"),
    domain: container.querySelector("#cred-domain"),
    stateSel: container.querySelector("#cred-state"),
    expiry: container.querySelector("#cred-expiry"),
    cards: container.querySelector("#cred-cards"),
    tableWrap: container.querySelector("#cred-table-wrap"),
    tbody: container.querySelector("#cred-tbody"),
    bulkBar: container.querySelector("#cred-bulkbar"),
    bulkCount: container.querySelector("#bulk-count"),
    bulkHint: container.querySelector("#bulk-hint"),
    poolNote: container.querySelector("#cred-pool-note"),
    viewCardsBtn: container.querySelector("#view-cards"),
    viewTableBtn: container.querySelector("#view-table"),
    dlgAdd: container.querySelector("#dlg-add"),
    dlgEnv: container.querySelector("#dlg-env"),
    dlgBulk: container.querySelector("#dlg-bulk"),
    dlgDetail: container.querySelector("#dlg-detail"),
    detailPre: container.querySelector("#detail-pre"),
    envExisting: container.querySelector("#env-existing"),
  };

  function openDlg(dlg) {
    if (!dlg) return;
    if (typeof dlg.showModal === "function") {
      try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); }
    } else dlg.setAttribute("open", "");
  }
  function closeDlg(dlg) {
    if (!dlg) return;
    if (typeof dlg.close === "function") {
      try { dlg.close(); } catch { dlg.removeAttribute("open"); }
    } else dlg.removeAttribute("open");
  }

  // close buttons
  for (const btn of container.querySelectorAll("[data-close]")) {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-close");
      const d = container.querySelector("#" + id);
      closeDlg(d);
    });
  }
  // backdrop click to close
  for (const dlg of container.querySelectorAll("dialog")) {
    dlg.addEventListener("click", (e) => {
      const rect = dlg.getBoundingClientRect();
      const inDialog = rect.top <= e.clientY && e.clientY <= rect.top + rect.height && rect.left <= e.clientX && e.clientX <= rect.left + rect.width;
      if (!inDialog) closeDlg(dlg);
    });
  }

  // header actions
  const btnAdd = container.querySelector("#btn-add");
  const btnEnv = container.querySelector("#btn-env");
  const btnBulk = container.querySelector("#btn-bulk");
  if (btnAdd) btnAdd.addEventListener("click", () => openDlg(els.dlgAdd));
  if (btnEnv) btnEnv.addEventListener("click", () => openDlg(els.dlgEnv));
  if (btnBulk) btnBulk.addEventListener("click", () => {
    if (els.bulkHint) els.bulkHint.textContent = `${selected.size} selected`;
    openDlg(els.dlgBulk);
  });
  const copyOnboard = container.querySelector("#btn-copy-onboard");
  let credSite = "cn";
  function onboardCmdFor(site) {
    if (site === "intl") {
      return `bun scripts/onboard-account.mjs --label "work-buddy-3" --api-base https://www.codebuddy.ai --console-base https://www.codebuddy.ai --provision-key --verify`;
    }
    return `bun scripts/onboard-account.mjs --label "work-buddy-3" --provision-key --verify`;
  }
  function refreshCredSitePills() {
    for (const b of container.querySelectorAll("[data-cred-site]")) b.classList.toggle("is-active", b.getAttribute("data-cred-site") === credSite);
    const el = container.querySelector("#cred-onboard-cmd");
    if (el) {
      if (credSite === "intl") {
        el.innerHTML = `bun scripts/onboard-account.mjs --label "work-buddy-3" --api-base https://www.codebuddy.ai --console-base https://www.codebuddy.ai --provision-key --verify<br/>bun scripts/onboard-account.mjs --from-auth-file ~/Library/Application\\ Support/CodeBuddy/auth.json --label acc-1 --api-base https://www.codebuddy.ai<br/>bun scripts/onboard-account.mjs --pool-file data/pool/a1b2.json --verify --api-base https://www.codebuddy.ai`;
      } else {
        el.innerHTML = `bun scripts/onboard-account.mjs --label "work-buddy-3" --provision-key --verify<br/>bun scripts/onboard-account.mjs --from-auth-file ~/Library/Application\\ Support/CodeBuddy/auth.json --label acc-1<br/>bun scripts/onboard-account.mjs --pool-file data/pool/a1b2.json --verify`;
      }
    }
  }
  container.addEventListener("click", (e) => {
    const s = e.target.closest("[data-cred-site]");
    if (!s) return;
    credSite = s.getAttribute("data-cred-site") || "cn";
    refreshCredSitePills();
  });
  if (copyOnboard) copyOnboard.addEventListener("click", async () => {
    const cmd = onboardCmdFor(credSite);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(cmd);
        toast("Copied", "ok");
      } else {
        toast(cmd, "ok");
      }
    } catch { toast(cmd, "ok"); }
  });
  if (btnEnvImport) btnEnvImport.addEventListener("click", () => {
    toast("Env parsed (mock) — write pool files to data/pool/ and restart", "ok");
    closeDlg(els.dlgEnv);
  });
  const bulkImportBtn = container.querySelector("#bulk-import-json");
  if (bulkImportBtn) bulkImportBtn.addEventListener("click", () => {
    toast("Bulk import is mock until POST /admin/credentials lands", "ok");
    closeDlg(els.dlgBulk);
  });
  const bulkCopyJson = container.querySelector("#bulk-copy-json");
  if (bulkCopyJson) bulkCopyJson.addEventListener("click", async () => {
    const list = getFiltered().filter((c) => selected.has(c.uid));
    const text = JSON.stringify(list, null, 2);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      toast("Copied JSON", "ok");
    } catch { toast("Copy failed", "error"); }
  });

  // filters
  if (els.search) els.search.addEventListener("input", () => { search = els.search.value.trim().toLowerCase(); selected.clear(); renderAll(); });
  if (els.domain) els.domain.addEventListener("change", () => { domainFilter = els.domain.value; selected.clear(); renderAll(); });
  if (els.stateSel) els.stateSel.addEventListener("change", () => { stateFilter = els.stateSel.value; selected.clear(); renderAll(); });
  if (els.expiry) els.expiry.addEventListener("change", () => { expirySort = els.expiry.value; renderAll(); });

  // view toggle
  function setView(v) {
    view = v;
    if (els.viewCardsBtn) els.viewCardsBtn.classList.toggle("is-active", v === "cards");
    if (els.viewTableBtn) els.viewTableBtn.classList.toggle("is-active", v === "table");
    if (els.cards) els.cards.style.display = v === "cards" ? "grid" : "none";
    if (els.tableWrap) els.tableWrap.hidden = v !== "table";
  }
  if (els.viewCardsBtn) els.viewCardsBtn.addEventListener("click", () => setView("cards"));
  if (els.viewTableBtn) els.viewTableBtn.addEventListener("click", () => setView("table"));
  // group pills are visual only for now (wireframe parity)
  for (const p of container.querySelectorAll("[data-group]")) {
    p.addEventListener("click", () => {
      for (const x of container.querySelectorAll("[data-group]")) x.classList.remove("is-active");
      p.classList.add("is-active");
      toast("Group by " + p.getAttribute("data-group") + " — visual only in v1", "ok");
    });
  }

  function getStateFor(uid, fallback) {
    if (byUid && byUid[uid] != null) return byUid[uid];
    return fallback || "—";
  }

  function getFiltered() {
    let list = creds.slice();
    if (search) {
      list = list.filter((c) => {
        const hay = `${c.uid || ""} ${c.label || ""}`.toLowerCase();
        return hay.includes(search);
      });
    }
    if (domainFilter) list = list.filter((c) => c.domain === domainFilter);
    if (stateFilter) {
      list = list.filter((c) => {
        const st = getStateFor(c.uid, c.state);
        return String(st).toLowerCase() === stateFilter;
      });
    }
    if (expirySort === "soon") {
      list.sort((a, b) => {
        const da = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
        const db = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
        return da - db;
      });
    }
    return list;
  }

  function renderAll() {
    const filtered = getFiltered();
    const expSoon = poolJson && poolJson.pool && poolJson.pool.expiringSoon != null ? poolJson.pool.expiringSoon : null;
    if (els.count) els.count.textContent = `${filtered.length} credentials${filtered.length !== creds.length ? ` · filtered from ${creds.length}` : ""}${expSoon != null ? ` · expiringSoon ${expSoon}` : ""}`;
    if (els.envExisting) els.envExisting.textContent = String(creds.length);
    if (els.poolNote) els.poolNote.textContent = byUid ? `byUid ${Object.keys(byUid).length} · poll 10s` : "";

    // bulk bar visibility
    const hasSel = selected.size > 0;
    if (els.bulkBar) els.bulkBar.style.display = hasSel ? "block" : "none";
    if (els.bulkCount) els.bulkCount.textContent = `${selected.size} selected`;
    const bulkAll = container.querySelector("#bulk-select-all");
    const tblAll = container.querySelector("#tbl-select-all");
    // keep header checkboxes in sync
    if (bulkAll) {
      const filteredUids = new Set(filtered.map((c) => c.uid));
      const selInFilter = [...selected].filter((uid) => filteredUids.has(uid)).length;
      bulkAll.checked = selInFilter > 0 && selInFilter === filtered.length && filtered.length > 0;
      bulkAll.indeterminate = selInFilter > 0 && selInFilter < filtered.length;
    }
    if (tblAll) {
      const filteredUids = new Set(filtered.map((c) => c.uid));
      const selInFilter = [...selected].filter((uid) => filteredUids.has(uid)).length;
      tblAll.checked = selInFilter > 0 && selInFilter === filtered.length && filtered.length > 0;
      tblAll.indeterminate = selInFilter > 0 && selInFilter < filtered.length;
    }
    if (els.bulkHint) els.bulkHint.textContent = `${selected.size} selected`;

    renderCards(filtered);
    renderTable(filtered);
  }

  function renderCards(list) {
    if (!els.cards) return;
    if (list.length === 0) {
      els.cards.innerHTML = `<div class="empty" style="grid-column:1/-1; border:1px dashed var(--border, #e5e7eb); background:var(--paper, #f5f3ef); border-radius:10px; padding:22px; text-align:center; display:grid; gap:8px; place-items:center"><div style="font-weight:750">No credentials — Add your first account</div><div class="hint">Use the Add account button for onboarding instructions</div><button class="btn primary small" type="button" id="empty-add">+ Add account</button></div>`;
      const ea = els.cards.querySelector("#empty-add");
      if (ea) ea.addEventListener("click", () => openDlg(els.dlgAdd));
      return;
    }
    let html = "";
    for (const c of list) {
      const uid = c.uid || "";
      const uidShort = uid.length > 8 ? uid.slice(0, 4) + "…" + uid.slice(-3) : uid;
      const state = getStateFor(uid, c.state);
      const checked = selected.has(uid) ? "checked" : "";
      const expAbs = fmtExpires(c.expiresAt);
      const expRel = fmtRelative(c.expiresAt);
      const expSoonMark = c.expiresAt && (new Date(c.expiresAt).getTime() - Date.now() < 3 * 86400000) ? " · expiring soon!" : "";
      const isChecked = selected.has(uid);
      html += `<div class="card cred-card" style="padding:14px; display:grid; gap:10px; ${isChecked ? "border-color:var(--indigo-500, #6366f1)" : ""}">
        <div class="cred-top" style="display:flex; align-items:center; gap:8px">
          <label style="display:flex; gap:6px; align-items:center"><input type="checkbox" data-sel="${esc(uid)}" ${checked} aria-label="Select ${esc(uid)}" /></label>
          <strong class="mono" style="font-size:13px">${esc(uidShort)}</strong>${badgeForState(state)}<span class="hint" style="margin-left:auto; font-size:12px">${esc(c.label || "—")}</span>
        </div>
        <div class="kv-mini" style="display:grid; grid-template-columns:110px 1fr; gap:4px 10px; font-size:12px">
          <dt style="color:var(--muted, #6b7280)">uid</dt><dd class="mono">${esc(uid)}</dd>
          <dt style="color:var(--muted, #6b7280)">domain</dt><dd class="mono">${esc(c.domain || "—")}</dd>
          <dt style="color:var(--muted, #6b7280)">expires</dt><dd class="mono">${esc(expAbs)}${expRel ? ` · ${esc(expRel)}` : ""}${esc(expSoonMark)}</dd>
          <dt style="color:var(--muted, #6b7280)">check-in</dt><dd><label style="display:inline-flex; gap:6px; align-items:center"><input type="checkbox" ${c.checkinEnabled ? "checked" : ""} disabled /> ${c.checkinEnabled ? "on" : "off"}</label></dd>
        </div>
        <div class="row">
          <button class="btn small ghost" type="button" data-detail="${esc(uid)}">Details</button>
          <button class="btn small accent" type="button" data-checkin="${esc(uid)}">Check-in</button>
          <button class="btn small danger" type="button" data-del="${esc(uid)}">Delete</button>
        </div>
      </div>`;
    }
    els.cards.innerHTML = html;
    for (const cb of els.cards.querySelectorAll("[data-sel]")) {
      cb.addEventListener("change", (e) => {
        const uid = e.currentTarget.getAttribute("data-sel") || "";
        if (e.currentTarget.checked) selected.add(uid); else selected.delete(uid);
        renderAll();
      });
    }
    for (const b of els.cards.querySelectorAll("[data-del]")) b.addEventListener("click", onDelete);
    for (const b of els.cards.querySelectorAll("[data-checkin]")) b.addEventListener("click", onCheckin);
    for (const b of els.cards.querySelectorAll("[data-detail]")) b.addEventListener("click", onDetail);
  }

  function renderTable(list) {
    if (!els.tbody) return;
    if (list.length === 0) {
      els.tbody.innerHTML = `<tr><td colspan="8" class="hint" style="text-align:center; padding:16px">No credentials</td></tr>`;
      return;
    }
    let html = "";
    for (const c of list) {
      const uid = c.uid || "";
      const state = getStateFor(uid, c.state);
      const checked = selected.has(uid) ? "checked" : "";
      html += `<tr>
        <td><input type="checkbox" data-sel="${esc(uid)}" ${checked} aria-label="Select ${esc(uid)}" /></td>
        <td class="mono">${esc(uid)}</td>
        <td>${esc(c.label || "—")}</td>
        <td>${esc(c.domain || "—")}</td>
        <td class="mono">${esc(fmtExpires(c.expiresAt))}</td>
        <td>${badgeForState(state)}</td>
        <td>${c.checkinEnabled ? "yes" : "no"}</td>
        <td><span class="row" style="gap:6px"><button class="btn small danger" type="button" data-del="${esc(uid)}">Delete</button><button class="btn small" type="button" data-checkin="${esc(uid)}">Check-in</button><button class="btn small ghost" type="button" data-detail="${esc(uid)}">Details</button></span></td>
      </tr>`;
    }
    els.tbody.innerHTML = html;
    for (const cb of els.tbody.querySelectorAll("[data-sel]")) {
      cb.addEventListener("change", (e) => {
        const uid = e.currentTarget.getAttribute("data-sel") || "";
        if (e.currentTarget.checked) selected.add(uid); else selected.delete(uid);
        renderAll();
      });
    }
    for (const b of els.tbody.querySelectorAll("[data-del]")) b.addEventListener("click", onDelete);
    for (const b of els.tbody.querySelectorAll("[data-checkin]")) b.addEventListener("click", onCheckin);
    for (const b of els.tbody.querySelectorAll("[data-detail]")) b.addEventListener("click", onDetail);
  }

  async function onDelete(e) {
    const uid = e.currentTarget.getAttribute("data-del") || e.currentTarget.getAttribute("data-sel") || "";
    if (!uid) return;
    const ok = window.confirm(`Delete credential "${uid}"? This cannot be undone.`);
    if (!ok) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      if (!api) { toast("API not available", "error"); return; }
      const r = await api("/admin/credentials/" + encodeURIComponent(uid), { method: "DELETE" });
      const u = unwrap(r);
      if (u.status === 401) { toast("401 — invalid admin key", "error"); return; }
      if (u.status === 503) { toast("Store not configured (503)", "error"); return; }
      if (u.status === 404) { toast("Not found: " + uid, "error"); return; }
      if (!u.ok) {
        const msg = (u.json && u.json.error && u.json.error.message) ? u.json.error.message : u.text || ("HTTP " + u.status);
        toast(msg, "error");
        return;
      }
      toast("Deleted " + uid, "ok");
      selected.delete(uid);
      await loadCreds();
      await loadPool();
    } catch (err) {
      const m = err && err.message ? err.message : String(err);
      toast("Delete failed: " + m, "error");
    } finally {
      btn.disabled = false;
    }
  }

  async function onCheckin(e) {
    const uid = e.currentTarget.getAttribute("data-checkin") || "";
    if (!uid) return;
    const ok = window.confirm(`Trigger check-in for "${uid}"?`);
    if (!ok) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = "Running…";
    try {
      if (!api) { toast("API not available", "error"); return; }
      const r = await api("/admin/checkin/" + encodeURIComponent(uid), { method: "POST" });
      const u = unwrap(r);
      if (u.status === 401) { toast("401 — invalid admin key", "error"); return; }
      if (u.status === 404) { toast("Not found: " + uid, "error"); return; }
      if (u.status === 501) { toast("Check-in not enabled (501) — set CODEBUFFY_CHECKIN_ENABLED=true", "error"); return; }
      if (u.status === 503) { toast("Store not configured (503)", "error"); return; }
      if (!u.ok) {
        const msg = (u.json && u.json.error && u.json.error.message) ? u.json.error.message : u.text || ("HTTP " + u.status);
        toast(msg, "error");
        return;
      }
      toast("Check-in triggered: " + uid, "ok");
      await loadPool();
    } catch (err) {
      const m = err && err.message ? err.message : String(err);
      toast("Check-in failed: " + m, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  async function onDetail(e) {
    const uid = e.currentTarget.getAttribute("data-detail") || "";
    if (!uid) return;
    let detail = null;
    try {
      if (api) {
        const r = await api("/admin/credentials/" + encodeURIComponent(uid));
        const u = unwrap(r);
        if (u.ok && u.json) detail = u.json.credential || u.json;
        else if (u.json) detail = u.json;
      }
    } catch {}
    if (!detail) {
      detail = creds.find((c) => c.uid === uid) || { uid, note: "not found in local list" };
      if (byUid && byUid[uid]) detail.poolState = byUid[uid];
    } else if (byUid && byUid[uid] && !detail.state) {
      detail.state = byUid[uid];
    }
    if (els.detailPre) {
      try { els.detailPre.textContent = JSON.stringify(detail, null, 2); } catch { els.detailPre.textContent = String(detail); }
    }
    openDlg(els.dlgDetail);
  }

  // bulk header checkboxes
  const bulkAll = container.querySelector("#bulk-select-all");
  const tblAll = container.querySelector("#tbl-select-all");
  function toggleAllForFilter(checked) {
    const filtered = getFiltered();
    for (const c of filtered) {
      if (checked) selected.add(c.uid);
      else selected.delete(c.uid);
    }
    renderAll();
  }
  if (bulkAll) bulkAll.addEventListener("change", (e) => toggleAllForFilter(e.currentTarget.checked));
  if (tblAll) tblAll.addEventListener("change", (e) => toggleAllForFilter(e.currentTarget.checked));

  const bulkDelete = container.querySelector("#bulk-delete");
  const bulkCheckin = container.querySelector("#bulk-checkin");
  const bulkExport = container.querySelector("#bulk-export");
  const bulkClear = container.querySelector("#bulk-clear");
  if (bulkDelete) bulkDelete.addEventListener("click", async () => {
    if (selected.size === 0) { toast("No selection", "error"); return; }
    const list = [...selected];
    const ok = window.confirm(`Delete ${list.length} credential(s)? This cannot be undone.`);
    if (!ok) return;
    bulkDelete.disabled = true;
    let okCount = 0;
    for (const uid of list) {
      try {
        const r = await api("/admin/credentials/" + encodeURIComponent(uid), { method: "DELETE" });
        const u = unwrap(r);
        if (u.ok) { okCount++; selected.delete(uid); }
        else if (u.status === 401) { toast("401 — invalid admin key", "error"); break; }
        else { toast((u.json && u.json.error && u.json.error.message) || u.text || ("Delete failed: " + uid), "error"); }
      } catch (err) { toast("Delete failed: " + uid, "error"); }
    }
    bulkDelete.disabled = false;
    toast(`Deleted ${okCount}/${list.length}`, okCount ? "ok" : "error");
    await loadCreds();
    await loadPool();
  });
  if (bulkCheckin) bulkCheckin.addEventListener("click", async () => {
    if (selected.size === 0) { toast("No selection", "error"); return; }
    const list = [...selected];
    bulkCheckin.disabled = true;
    let okCount = 0;
    for (const uid of list) {
      try {
        const r = await api("/admin/checkin/" + encodeURIComponent(uid), { method: "POST" });
        const u = unwrap(r);
        if (u.ok) okCount++;
        else if (u.status === 501) { toast("Check-in not enabled (501)", "error"); break; }
        else if (u.status === 401) { toast("401 — invalid admin key", "error"); break; }
        else { toast((u.json && u.json.error && u.json.error.message) || u.text || ("Check-in failed: " + uid), "error"); }
      } catch { toast("Check-in failed: " + uid, "error"); }
    }
    bulkCheckin.disabled = false;
    toast(`Check-in triggered ${okCount}/${list.length}`, okCount ? "ok" : "error");
    await loadPool();
  });
  if (bulkExport) bulkExport.addEventListener("click", async () => {
    const list = getFiltered().filter((c) => selected.has(c.uid));
    const text = JSON.stringify(list, null, 2);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        toast("Copied JSON", "ok");
      } else {
        toast(text.slice(0, 120) + "…", "ok");
      }
    } catch { toast("Copy failed", "error"); }
  });
  if (bulkClear) bulkClear.addEventListener("click", () => { selected.clear(); renderAll(); });

  async function loadCreds() {
    if (!api) {
      if (els.count) els.count.textContent = "API not available";
      if (els.cards) els.cards.innerHTML = `<div class="hint" style="padding:16px; text-align:center">API not wired — shell must pass {api, toast}</div>`;
      return;
    }
    // guard: if getKey exists and no key stored, prompt
    try {
      const r = await api("/admin/credentials");
      const u = unwrap(r);
      if (u.status === 401) {
        toast("401 — invalid admin key", "error");
        if (els.count) els.count.textContent = "401 — invalid admin key";
        // keep existing creds empty view with hint
        if (creds.length === 0 && els.cards) {
          els.cards.innerHTML = `<div class="empty" style="border:1px dashed var(--border, #e5e7eb); padding:22px; text-align:center; display:grid; gap:8px; place-items:center"><div style="font-weight:750">401 — invalid admin key</div><div class="hint">Save a valid CODEBUFFY_ADMIN_KEYS bearer in Login, then Reload.</div></div>`;
        }
        return;
      }
      if (u.status === 503) {
        toast("Store not configured (503)", "error");
        if (els.count) els.count.textContent = "503 — store not configured";
        if (els.cards) els.cards.innerHTML = `<div class="empty" style="border:1px dashed var(--border, #e5e7eb); padding:22px; text-align:center; display:grid; gap:8px; place-items:center"><div style="font-weight:750">Store unavailable (503)</div><div class="hint">Set CODEBUFFY_DB_PATH and ensure store is configured.</div></div>`;
        return;
      }
      if (!u.ok) {
        const msg = (u.json && u.json.error && u.json.error.message) ? u.json.error.message : u.text || ("HTTP " + u.status);
        toast(msg, "error");
        return;
      }
      const list = (u.json && u.json.credentials) ? u.json.credentials : [];
      creds = Array.isArray(list) ? list : [];
      renderAll();
    } catch (err) {
      const m = err && err.message ? err.message : String(err);
      toast("Load failed: " + m, "error");
    }
  }

  async function loadPool() {
    if (!api) return;
    try {
      const r = await api("/admin/pool/state");
      const u = unwrap(r);
      if (u.status === 401) return;
      if (u.status === 503) return;
      if (!u.ok) return;
      poolJson = u.json;
      byUid = u.json && u.json.byUid ? u.json.byUid : null;
      // re-render to update badges without full creds reload
      renderAll();
    } catch {}
  }

  // initial loads
  loadCreds();
  loadPool();
  _poll = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    loadPool();
  }, 10000);
  _vis = () => { if (!document.hidden) loadPool(); };
  try { document.addEventListener("visibilitychange", _vis); } catch {}
}
export function destroy() {
  if (_poll) { try { clearInterval(_poll); } catch {} _poll = null; }
  if (_vis) { try { document.removeEventListener("visibilitychange", _vis); } catch {} _vis = null; }
}
