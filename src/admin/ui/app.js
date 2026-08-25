/* Codebuffy Admin UI — vanilla JS, zero bundle.
 * Calls only /admin/* with Authorization: Bearer from localStorage.
 * No console.* — toasts + DOM status only.
 */
(function () {
  "use strict";

  var LS_KEY = "codebuffy_admin_key";
  var $ = function (sel) { return document.querySelector(sel); };
  var credsBody = $("#credsBody");
  var credsCount = $("#credsCount");
  var poolSummary = $("#poolSummary");
  var poolCards = $("#poolCards");
  var poolRaw = $("#poolRaw");
  var authStatus = $("#authStatus");
  var adminKeyInput = $("#adminKey");
  var toasts = $("#toasts");
  var pollTimer = null;

  function getKey() {
    try { return localStorage.getItem(LS_KEY) || ""; } catch { return ""; }
  }

  function setKey(val) {
    try { localStorage.setItem(LS_KEY, val); } catch { /* ignore */ }
  }

  function clearKey() {
    try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  }

  function headers() {
    var k = getKey();
    return k ? { "Authorization": "Bearer " + k } : {};
  }

  function setAuthStatus(msg, isError) {
    if (!authStatus) return;
    authStatus.textContent = msg;
    authStatus.style.color = isError ? "#991b1b" : "";
  }

  function toast(msg, kind) {
    if (!toasts) return;
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = msg;
    el.setAttribute("role", "status");
    toasts.appendChild(el);
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

  function fmtExpires(val) {
    if (!val) return "—";
    try {
      var d = new Date(val);
      if (isNaN(d.getTime())) return String(val);
      return d.toLocaleString();
    } catch {
      return String(val);
    }
  }

  function esc(str) {
    var d = document.createElement("div");
    d.textContent = str == null ? "" : String(str);
    return d.innerHTML;
  }

  async function api(path, opts) {
    var o = opts || {};
    var h = headers();
    // only attach auth to /admin/* — never leak to other origins
    if (path.indexOf("/admin/") !== 0) throw new Error("refusing non-admin path: " + path);
    var res = await fetch(path, {
      method: o.method || "GET",
      headers: Object.assign({}, h, o.headers || {}),
      body: o.body,
    });
    var text = await res.text();
    var json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { res: res, json: json, text: text };
  }

  function renderCreds(list) {
    if (!credsBody || !credsCount) return;
    credsCount.textContent = String(list.length);
    if (list.length === 0) {
      credsBody.innerHTML = '<tr><td colspan="7" class="empty">No credentials</td></tr>';
      return;
    }
    var html = "";
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var uid = c.uid || "";
      var label = c.label || "—";
      var domain = c.domain || "—";
      var expiresAt = fmtExpires(c.expiresAt);
      var state = c.state || "—";
      var checkin = c.checkinEnabled ? "yes" : "no";
      // uid is used as data attr and in closures — escape for HTML, encode for URL
      html += '<tr>'
        + '<td class="mono">' + esc(uid) + '</td>'
        + '<td>' + esc(label) + '</td>'
        + '<td>' + esc(domain) + '</td>'
        + '<td>' + esc(expiresAt) + '</td>'
        + '<td><span class="badge">' + esc(state) + '</span></td>'
        + '<td>' + esc(checkin) + '</td>'
        + '<td><div class="actions">'
        + '<button type="button" class="danger" data-del="' + esc(uid) + '">Delete</button>'
        + '<button type="button" data-checkin="' + esc(uid) + '">Check-in</button>'
        + '</div></td>'
        + '</tr>';
    }
    credsBody.innerHTML = html;

    // Wire buttons without inline handlers
    var delBtns = credsBody.querySelectorAll("[data-del]");
    for (var d = 0; d < delBtns.length; d++) {
      delBtns[d].addEventListener("click", onDelete);
    }
    var ckBtns = credsBody.querySelectorAll("[data-checkin]");
    for (var k = 0; k < ckBtns.length; k++) {
      ckBtns[k].addEventListener("click", onCheckin);
    }
  }

  function renderPool(data) {
    if (!poolSummary || !poolCards) return;
    // data is { pool: {...}, byUid?: {...} } per src/admin/routes.ts
    var pool = (data && data.pool) ? data.pool : data;
    var byUid = data && data.byUid ? data.byUid : null;

    // Summary KV
    var size = (pool && typeof pool.size === "number") ? pool.size : (pool && pool.size != null ? pool.size : "—");
    // byState may be flat on pool or nested — handle both shapes
    var byState = null;
    if (pool && typeof pool === "object") {
      // pool could be { active:1, cooling:0,... } or { size:1, byState:{...}}
      if (pool.byState && typeof pool.byState === "object") byState = pool.byState;
      else {
        // treat pool itself as byState if it has state keys
        var hasStateKeys = false;
        for (var key in pool) { if (Object.prototype.hasOwnProperty.call(pool, key) && key !== "size" && key !== "pool") { hasStateKeys = true; break; } }
        if (hasStateKeys) {
          byState = {};
          for (var kk in pool) { if (kk !== "size" && Object.prototype.hasOwnProperty.call(pool, kk)) byState[kk] = pool[kk]; }
        }
      }
    }
    // also merge byUid counts into cards if byState missing
    if (!byState && byUid) {
      byState = {};
      for (var uid2 in byUid) {
        var st = byUid[uid2];
        byState[st] = (byState[st] || 0) + 1;
      }
    }

    var sumHtml = '<dt>size</dt><dd>' + esc(String(size)) + '</dd>';
    if (byUid) {
      var uids = Object.keys(byUid);
      sumHtml += '<dt>tracked uids</dt><dd>' + esc(String(uids.length)) + '</dd>';
    }
    // expiringSoon etc if present
    if (pool && pool.expiringSoon != null) sumHtml += '<dt>expiringSoon</dt><dd>' + esc(String(pool.expiringSoon)) + '</dd>';
    poolSummary.innerHTML = sumHtml;

    // Cards for byState
    if (!byState || Object.keys(byState).length === 0) {
      poolCards.innerHTML = '<div class="pool-card"><div class="label">byState</div><div class="value" style="font-size:13px;color:var(--muted)">—</div></div>';
    } else {
      var cards = "";
      for (var s in byState) {
        if (!Object.prototype.hasOwnProperty.call(byState, s)) continue;
        cards += '<div class="pool-card"><div class="label">' + esc(s) + '</div><div class="value">' + esc(String(byState[s])) + '</div></div>';
      }
      poolCards.innerHTML = cards;
    }

    if (poolRaw) {
      try {
        poolRaw.textContent = JSON.stringify(data, null, 2);
        poolRaw.style.display = "block";
      } catch {
        poolRaw.style.display = "none";
      }
    }
  }

  async function loadCreds() {
    if (!getKey()) {
      setAuthStatus("Set admin key to load credentials.", true);
      if (credsBody) credsBody.innerHTML = '<tr><td colspan="7" class="empty">Set admin key above, then Reload.</td></tr>';
      return;
    }
    try {
      var r = await api("/admin/credentials");
      if (r.res.status === 401) {
        setAuthStatus("401 — invalid admin key.", true);
        toast("401 — invalid admin key", "error");
        return;
      }
      if (r.res.status === 503) {
        setAuthStatus("503 — store not configured.", true);
        toast("Store not configured (503)", "error");
        if (credsBody) credsBody.innerHTML = '<tr><td colspan="7" class="empty">Store unavailable (503)</td></tr>';
        return;
      }
      if (!r.res.ok) {
        var msg = (r.json && r.json.error && r.json.error.message) ? r.json.error.message : r.text || ("HTTP " + r.res.status);
        toast(msg, "error");
        return;
      }
      setAuthStatus("Credentials loaded.", false);
      var list = (r.json && r.json.credentials) ? r.json.credentials : [];
      renderCreds(list);
    } catch (e) {
      var m = e && e.message ? e.message : String(e);
      toast("Load failed: " + m, "error");
    }
  }

  async function loadPool() {
    if (!getKey()) {
      if (poolSummary) poolSummary.innerHTML = '<dt>pool</dt><dd>Set admin key to load</dd>';
      return;
    }
    try {
      var r = await api("/admin/pool/state");
      if (r.res.status === 401) {
        setAuthStatus("401 — invalid admin key.", true);
        return;
      }
      if (r.res.status === 503) {
        toast("Pool unavailable (503)", "error");
        return;
      }
      if (!r.res.ok) {
        var msg2 = (r.json && r.json.error && r.json.error.message) ? r.json.error.message : r.text || ("HTTP " + r.res.status);
        toast(msg2, "error");
        return;
      }
      renderPool(r.json);
    } catch (e2) {
      var m2 = e2 && e2.message ? e2.message : String(e2);
      toast("Pool load failed: " + m2, "error");
    }
  }

  async function onDelete(ev) {
    var btn = ev.currentTarget;
    var uid = btn.getAttribute("data-del") || "";
    if (!uid) return;
    var ok = window.confirm('Delete credential "' + uid + '"? This cannot be undone.');
    if (!ok) return;
    btn.disabled = true;
    try {
      var r = await api("/admin/credentials/" + encodeURIComponent(uid), { method: "DELETE" });
      if (!r.res.ok) {
        var msg = (r.json && r.json.error && r.json.error.message) ? r.json.error.message : r.text || ("HTTP " + r.res.status);
        toast(msg, "error");
        return;
      }
      toast("Deleted " + uid, "ok");
      await loadCreds();
      await loadPool();
    } catch (e) {
      toast("Delete failed: " + (e && e.message ? e.message : String(e)), "error");
    } finally {
      btn.disabled = false;
    }
  }

  function startPoll() {
    clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      if (!getKey() || document.hidden) return;
      loadPool();
    }, 10000);
  }

  async function onCheckin(ev) {
    var btn = ev.currentTarget;
    var uid = btn.getAttribute("data-checkin") || "";
    if (!uid) return;
    var ok = window.confirm('Trigger check-in for "' + uid + '"?');
    if (!ok) return;
    btn.disabled = true;
    var orig = btn.textContent;
    btn.textContent = "Running…";
    try {
      var r = await api("/admin/checkin/" + encodeURIComponent(uid), { method: "POST" });
      if (r.res.status === 401) { toast("401 — invalid admin key", "error"); return; }
      if (r.res.status === 404) { toast("Not found: " + uid, "error"); return; }
      if (r.res.status === 501) { toast("Check-in not enabled (501) — set CODEBUFFY_CHECKIN_ENABLED=true", "error"); return; }
      if (!r.res.ok) {
        var msg = (r.json && r.json.error && r.json.error.message) ? r.json.error.message : r.text || ("HTTP " + r.res.status);
        toast(msg, "error");
        return;
      }
      toast("Check-in triggered: " + uid, "ok");
    } catch (e) {
      toast("Check-in failed: " + (e && e.message ? e.message : String(e)), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }


  function initAuthUI() {
    if (!adminKeyInput) return;
    adminKeyInput.value = getKey();
    if (getKey()) setAuthStatus("Key loaded from localStorage.", false);
    else setAuthStatus("No key stored.", false);

    var saveBtn = $("#saveKey");
    var clearBtn = $("#clearKey");
    var reloadBtn = $("#reload");

    if (saveBtn) saveBtn.addEventListener("click", function () {
      var v = adminKeyInput.value.trim();
      if (!v) { toast("Enter a key before saving", "error"); return; }
      if (v.length < 8) { toast("Key too short (min 8 chars)", "error"); return; }
      setKey(v);
      setAuthStatus("Key saved.", false);
      toast("Key saved", "ok");
      loadCreds();
      loadPool();
    });

    if (clearBtn) clearBtn.addEventListener("click", function () {
      clearKey();
      adminKeyInput.value = "";
      setAuthStatus("Key cleared.", false);
      toast("Key cleared", "ok");
    });

    if (reloadBtn) reloadBtn.addEventListener("click", function () {
      loadCreds();
      loadPool();
    });

    adminKeyInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        var vv = adminKeyInput.value.trim();
        if (!vv) return;
        setKey(vv);
        setAuthStatus("Key saved.", false);
        toast("Key saved", "ok");
        loadCreds();
        loadPool();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initAuthUI();
    loadCreds();
    loadPool();
    startPoll();
    // Re-load pool when tab becomes visible again
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && getKey()) loadPool();
    });
  });
})();
