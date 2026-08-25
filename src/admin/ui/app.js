/* Codebuffy Admin shell — hash router + auth + theme + toast + drawer + page loader.
 * Vanilla ES module, no bundle, no external deps, no console.* — use toast().
 * Serves GET /admin/ (index.html public) + GET /admin/ui/* before adminAuth.
 */
const LS_KEY = "codebuffy_admin_key";
const THEME_KEY = "admin-theme";
const RAIL_KEY = "codebuffy_rail_collapsed";

const PAGES = ["dashboard", "credentials", "api-keys", "console", "usage", "debug", "settings", "login"];
const PAGE_FILES = {
  dashboard: "dashboard.js",
  credentials: "credentials.js",
  "api-keys": "api-keys.js",
  console: "console.js",
  usage: "usage.js",
  debug: "debug.js",
  settings: "settings.js",
  login: "login.js",
};
const TITLES = {
  dashboard: ["Dashboard", "Operator console · health, pool, latency"],
  credentials: ["Credentials", "Pool members · health chips · bulk"],
  "api-keys": ["API Keys", "Downstream + admin · copy / revoke"],
  console: ["Console", "Playground · SSE trace"],
  usage: ["Usage", "Stats · 1h–7d · by model / credential"],
  debug: ["Debug", "4-step trace · pino tail"],
  settings: ["Settings", "15 CODEBUFFY_* · visual ↔ YAML"],
  login: ["Login", "Bearer gate · localStorage"],
};

function normalizeHash(raw) {
  const h = (raw || "").trim();
  // accept "#/dashboard", "#dashboard", "/dashboard", "dashboard", "#/api-keys", "#apikeys"
  let id = h.replace(/^#\/?/, "").replace(/^\//, "").trim();
  if (!id) return "dashboard";
  // aliases
  if (id === "apikeys" || id === "apiKeys" || id === "apikey") id = "api-keys";
  if (id === "apikeys") id = "api-keys";
  // allow "credentials" etc with query? strip ? and /
  id = id.split("?")[0].split("/")[0].toLowerCase();
  if (PAGES.indexOf(id) === -1) return "dashboard";
  return id;
}

function getKey() {
  try {
    return localStorage.getItem(LS_KEY) || "";
  } catch {
    return "";
  }
}
function setKey(val) {
  try {
    localStorage.setItem(LS_KEY, val);
  } catch {}
}
function clearKey() {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {}
}
function headers() {
  const k = getKey();
  return k ? { Authorization: "Bearer " + k } : {};
}

let toastHost = null;
function ensureToastHost() {
  if (toastHost) return toastHost;
  toastHost = document.getElementById("toast") || document.getElementById("toasts");
  return toastHost;
}
function toast(msg, kind) {
  const host = ensureToastHost();
  if (!host) return;
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = String(msg);
  el.setAttribute("role", "status");
  host.appendChild(el);
  const ms = kind === "error" ? 4200 : 2600;
  const t = setTimeout(function () {
    el.classList.add("out");
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 200);
  }, ms);
  el.addEventListener("click", function () {
    clearTimeout(t);
    if (el.parentNode) el.parentNode.removeChild(el);
  });
}

function getTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {}
  try {
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  } catch {}
  return "light";
}
function applyTheme(next, opts) {
  const persist = !(opts && opts.persist === false);
  const animate = !(opts && opts.animate === false);
  const theme = next === "dark" ? "dark" : "light";
  if (animate) {
    const existing = document.getElementById("theme-progress");
    if (existing) existing.remove();
    const s = document.createElement("style");
    s.id = "theme-progress";
    s.textContent = "*{transition:background 520ms ease,color 520ms ease,border-color 520ms ease !important}";
    document.head.appendChild(s);
    document.documentElement.classList.add("theme-transition");
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.setProperty("--theme-progress", theme === "dark" ? "1" : "0");
    try {
      document.documentElement.style.colorScheme = theme;
    } catch {}
    setTimeout(function () {
      const n = document.getElementById("theme-progress");
      if (n) n.remove();
      document.documentElement.classList.remove("theme-transition");
    }, 560);
  } else {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.setProperty("--theme-progress", theme === "dark" ? "1" : "0");
    try {
      document.documentElement.style.colorScheme = theme;
    } catch {}
  }
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
  }
  const btn = document.getElementById("themeBtn");
  if (btn) btn.textContent = theme === "dark" ? "◑" : "◐";
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || getTheme();
  applyTheme(cur === "dark" ? "light" : "dark");
}
const theme = { get: getTheme, set: applyTheme, toggle: toggleTheme };

let lastAuthState = "unknown";
function setAuthChip(state, msg) {
  const chip = document.getElementById("authChip");
  const badge = document.getElementById("navLoginBadge");
  if (!chip) return;
  lastAuthState = state;
  if (state === "authed") {
    chip.className = "chip ok";
    chip.innerHTML = '<span class="dot" aria-hidden="true"></span> authed';
    if (badge) badge.textContent = "●";
  } else if (state === "error") {
    chip.className = "chip err";
    chip.innerHTML = '<span class="dot err" aria-hidden="true"></span> 401 invalid';
    if (badge) badge.textContent = "✕";
  } else if (state === "open") {
    chip.className = "chip warn";
    chip.innerHTML = '<span class="dot warn" aria-hidden="true"></span> no key — open mode';
    if (badge) badge.textContent = "○";
  } else if (state === "checking") {
    chip.className = "chip";
    chip.innerHTML = '<span class="dot" aria-hidden="true" style="background:var(--muted)"></span> ' + (msg || "checking…");
  } else {
    chip.className = "chip warn";
    chip.innerHTML = '<span class="dot warn" aria-hidden="true"></span> no key';
    if (badge) badge.textContent = "○";
  }
}
function refreshAuthChip() {
  const k = getKey();
  if (!k) {
    setAuthChip("open");
    return;
  }
  if (lastAuthState === "error") return;
  setAuthChip("authed");
}

async function api(path, opts) {
  const o = opts || {};
  if (path.indexOf("/admin/") !== 0) throw new Error("refusing non-admin path: " + path);
  const h = headers();
  const res = await fetch(path, {
    method: o.method || "GET",
    headers: Object.assign({}, h, o.headers || {}),
    body: o.body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.status === 401) {
    setAuthChip("error");
    toast("401 — invalid admin key", "error");
    // keep user on current page but hint login; don't force redirect if already on login
    const cur = normalizeHash(window.location.hash);
    if (cur !== "login") {
      // soft redirect after toast — user can stay, but hash hint helps
      // do not auto-replace if user just saved a bad key; they should see error
    }
  } else if (res.status === 503) {
    toast("Store not configured (503)", "error");
  }
  return { res, json, text };
}

let currentPage = "dashboard";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let loadingPage = null;

function setActiveNav(id) {
  const navs = document.querySelectorAll("[data-nav]");
  for (let i = 0; i < navs.length; i++) {
    const is = navs[i].getAttribute("data-nav") === id;
    navs[i].classList.toggle("is-active", is);
    if (is) navs[i].setAttribute("aria-current", "page");
    else navs[i].removeAttribute("aria-current");
  }
}

function showPage(id) {
  const target = normalizeHash(id);
  currentPage = target;
  const pages = document.querySelectorAll(".page");
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const pid = p.getAttribute("data-page") || p.id.replace(/^page-/, "");
    const is = pid === target;
    if (is) {
      p.hidden = false;
      p.classList.add("is-active");
    } else {
      p.hidden = true;
      p.classList.remove("is-active");
    }
  }
  setActiveNav(target);
  const t = TITLES[target];
  const titleEl = document.getElementById("pageTitle");
  const bcEl = document.getElementById("breadcrumb");
  if (t) {
    if (titleEl) titleEl.textContent = t[0];
    if (bcEl) bcEl.textContent = t[1];
  }
  try {
    const desired = "#/" + target;
    if (window.location.hash !== desired) history.replaceState(null, "", desired);
  } catch {}
  closeDrawer();
  const main = document.getElementById("main");
  if (main) main.scrollTop = 0;
  window.scrollTo(0, 0);
  loadPage(target);
}

async function loadPage(id) {
  const file = PAGE_FILES[id];
  if (!file) return;
  const container = document.getElementById("page-" + id);
  if (!container) return;
  // already rendered by page module? skip re-import if marked
  if (container.dataset.loaded === "1" && id !== "login") return;
  // try dynamic import; allowlist must include pages/* — if 404, keep placeholder + gentle hint
  const url = "/admin/ui/pages/" + file;
  try {
    // Use dynamic import with variable — bundler-free
    const mod = await import(url);
    const fn = (mod && mod.render) || (mod && mod.default && mod.default.render) || mod.default;
    if (typeof fn === "function") {
      const deps = { api, toast, getKey, setKey, clearKey, theme, headers, setAuthChip };
      // clear placeholder empty if still there
      // let page own container; pass container directly
      await fn(container, deps);
      container.dataset.loaded = "1";
    } else if (mod && typeof mod.mount === "function") {
      const deps = { api, toast, getKey, setKey, clearKey, theme, headers, setAuthChip };
      await mod.mount(container, deps);
      container.dataset.loaded = "1";
    }
  } catch {
    // module not yet available (allowlist not patched or page not yet shipped) — keep shell placeholder
    // add one-time hint in footer or chip? keep silent to avoid noise; other slices will populate.
    // If file is login or dashboard and missing, ensure placeholder stays visible (already there).
  }
}

function openDrawer() {
  const rail = document.getElementById("rail");
  const scrim = document.getElementById("scrim");
  const drawerScrim = document.getElementById("drawerScrim");
  if (rail) rail.classList.add("is-open");
  if (scrim) scrim.hidden = false;
  if (drawerScrim) drawerScrim.hidden = false;
  const b = document.getElementById("burger");
  if (b) b.setAttribute("aria-expanded", "true");
}
function closeDrawer() {
  const rail = document.getElementById("rail");
  const scrim = document.getElementById("scrim");
  const drawerScrim = document.getElementById("drawerScrim");
  if (rail) rail.classList.remove("is-open");
  if (scrim) scrim.hidden = true;
  if (drawerScrim) drawerScrim.hidden = true;
  const b = document.getElementById("burger");
  if (b) b.setAttribute("aria-expanded", "false");
}

function toggleRailCollapse() {
  const app = document.getElementById("app");
  const btn = document.getElementById("railCollapse");
  if (!app) return;
  const is = app.classList.toggle("is-collapsed");
  if (btn) {
    btn.textContent = is ? "›" : "‹";
    btn.setAttribute("aria-label", is ? "Expand navigation" : "Collapse navigation");
    btn.title = is ? "Expand" : "Collapse";
  }
  try {
    localStorage.setItem(RAIL_KEY, is ? "1" : "0");
  } catch {}
}

function restoreRailCollapse() {
  try {
    if (localStorage.getItem(RAIL_KEY) === "1") {
      const app = document.getElementById("app");
      if (app) app.classList.add("is-collapsed");
      const btn = document.getElementById("railCollapse");
      if (btn) {
        btn.textContent = "›";
        btn.setAttribute("aria-label", "Expand navigation");
      }
    }
  } catch {}
}

async function refreshPoolMini() {
  const k = getKey();
  const sizeEl = document.getElementById("miniSize");
  const activeEl = document.getElementById("miniActive");
  const coolEl = document.getElementById("miniCooldown");
  const banEl = document.getElementById("miniBanned");
  const metaEl = document.getElementById("miniMeta");
  const noteEl = document.getElementById("poolNote");
  const dotEl = document.getElementById("poolDot");
  const badgeCreds = document.getElementById("badge-credentials");
  const badgeDash = document.getElementById("badge-dashboard");
  if (!k) {
    if (sizeEl) sizeEl.textContent = "—";
    if (activeEl) activeEl.textContent = "—";
    if (coolEl) coolEl.textContent = "—";
    if (banEl) banEl.textContent = "—";
    if (metaEl) metaEl.textContent = "no key — open mode";
    if (noteEl) noteEl.textContent = "pool — · store —";
    if (badgeCreds) badgeCreds.textContent = "—";
    if (badgeDash) badgeDash.textContent = "—";
    return;
  }
  try {
    const r = await api("/admin/pool/state");
    if (!r.res.ok) return;
    const data = r.json || {};
    const pool = data.pool || data;
    // pool may be {size, byState, expiringSoon} or flat stats
    const size = typeof pool.size === "number" ? pool.size : (typeof data.size === "number" ? data.size : "—");
    let byState = null;
    if (pool && pool.byState && typeof pool.byState === "object") byState = pool.byState;
    else if (data.byState) byState = data.byState;
    else if (pool && typeof pool === "object" && pool.active != null) byState = pool;
    const active = byState && byState.active != null ? byState.active : "—";
    const cooldown = byState && (byState.cooldown != null ? byState.cooldown : byState.cool != null ? byState.cool : "—");
    const banned = byState && byState.banned != null ? byState.banned : "—";
    const exp = pool.expiringSoon != null ? pool.expiringSoon : (data.expiringSoon != null ? data.expiringSoon : "—");
    if (sizeEl) sizeEl.textContent = String(size);
    if (activeEl) activeEl.textContent = String(active);
    if (coolEl) coolEl.textContent = String(cooldown);
    if (banEl) banEl.textContent = String(banned);
    if (metaEl) metaEl.textContent = "expiringSoon " + String(exp) + " · " + (data.byUid ? Object.keys(data.byUid).length + " uids" : "byState");
    if (noteEl) {
      const enc = data.store ? "enc ●" : (pool && pool.store ? "enc ●" : "store —");
      noteEl.textContent = "pool " + String(size) + " · " + enc;
    }
    if (dotEl) dotEl.className = "dot" + (active !== "—" && Number(active) > 0 ? "" : " warn");
    // badges
    try {
      const credsR = await api("/admin/credentials");
      if (credsR.res.ok && credsR.json && Array.isArray(credsR.json.credentials)) {
        const n = credsR.json.credentials.length;
        if (badgeCreds) badgeCreds.textContent = String(n);
        if (badgeDash) badgeDash.textContent = String(size !== "—" ? size : n);
      }
    } catch {}
  } catch {}
}

async function refreshFooter() {
  const vEl = document.getElementById("footVersion");
  const uEl = document.getElementById("footUptime");
  const pEl = document.getElementById("footPool");
  try {
    const res = await fetch("/healthz");
    if (!res.ok) return;
    const j = await res.json();
    if (vEl && j.version) vEl.textContent = "v" + String(j.version);
    if (uEl && typeof j.uptimeSeconds === "number") {
      const s = j.uptimeSeconds;
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      uEl.textContent = "uptime " + (h ? h + "h " : "") + m + "m";
    }
  } catch {}
  try {
    const res2 = await fetch("/readyz");
    if (!res2.ok) return;
    const j2 = await res2.json();
    if (pEl && j2.pool) {
      const sz = j2.pool.size != null ? j2.pool.size : "—";
      const bs = j2.pool.byState ? Object.entries(j2.pool.byState).map(function (kv) { return kv[0] + " " + kv[1]; }).join(" · ") : "";
      pEl.textContent = "pool " + String(sz) + (bs ? " · " + bs : "");
    }
    // also enrich mini meta with expiringSoon if available
    const metaEl = document.getElementById("miniMeta");
    if (metaEl && j2.pool && j2.pool.expiringSoon != null) {
      const cur = metaEl.textContent || "";
      if (cur.indexOf("expiringSoon") === -1) metaEl.textContent = cur + " · expiringSoon " + String(j2.pool.expiringSoon);
    }
    const noteEl = document.getElementById("poolNote");
    if (noteEl && j2.store) {
      const enc = j2.store.encrypted ? "enc ●" : "store ○";
      const base = noteEl.textContent || "";
      if (base.indexOf("enc") === -1 && base.indexOf("store") !== -1) {
        // keep pool part, update store part
        const poolPart = base.split("·")[0] || "pool —";
        noteEl.textContent = poolPart.trim() + " · " + enc;
      }
    }
  } catch {}
}

function bindShell() {
  const burger = document.getElementById("burger");
  const scrim = document.getElementById("scrim");
  const drawerScrim = document.getElementById("drawerScrim");
  const themeBtn = document.getElementById("themeBtn");
  const railCollapse = document.getElementById("railCollapse");

  if (burger) burger.addEventListener("click", function () {
    const rail = document.getElementById("rail");
    if (rail && rail.classList.contains("is-open")) closeDrawer();
    else openDrawer();
  });
  if (scrim) scrim.addEventListener("click", closeDrawer);
  if (drawerScrim) drawerScrim.addEventListener("click", closeDrawer);
  if (themeBtn) themeBtn.addEventListener("click", toggleTheme);
  if (railCollapse) railCollapse.addEventListener("click", toggleRailCollapse);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeDrawer();
  });

  // nav clicks are native <a href="#/…"> — no JS needed, but enhance for active + close
  document.addEventListener("click", function (e) {
    const nav = e.target.closest("[data-nav]");
    if (nav) {
      const id = nav.getAttribute("data-nav");
      if (id) {
        // allow default hash change, but ensure showPage sync if hash same
        const normalized = normalizeHash(id);
        if (normalizeHash(window.location.hash) === normalized) {
          e.preventDefault();
          showPage(normalized);
        }
      }
    }
    const jump = e.target.closest("[data-jump]");
    if (jump) {
      const id2 = jump.getAttribute("data-jump");
      if (id2) showPage(id2);
    }
  });

  window.addEventListener("hashchange", function () {
    const h = normalizeHash(window.location.hash);
    if (h !== currentPage) showPage(h);
  });
}

function init() {
  // theme early
  const t = getTheme();
  applyTheme(t, { animate: false, persist: false });
  try {
    if (!localStorage.getItem(THEME_KEY)) {
      // honor system on first load without persisting until user toggles
      document.documentElement.setAttribute("data-theme", t);
      document.documentElement.style.setProperty("--theme-progress", t === "dark" ? "1" : "0");
    }
  } catch {}

  restoreRailCollapse();
  bindShell();
  refreshAuthChip();
  refreshFooter();
  refreshPoolMini();

  const initial = normalizeHash(window.location.hash);
  showPage(initial);

  // keep pool mini fresh every 10s like old app.js, but only when visible and key present
  let pollTimer = null;
  function startPoll() {
    clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      if (!getKey() || document.hidden) return;
      refreshPoolMini();
    }, 10000);
  }
  startPoll();
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && getKey()) refreshPoolMini();
  });
  window.addEventListener("storage", function (e) {
    if (e.key === LS_KEY) {
      refreshAuthChip();
      refreshPoolMini();
    }
    if (e.key === THEME_KEY && e.newValue) {
      const v = e.newValue === "dark" ? "dark" : "light";
      applyTheme(v, { animate: true, persist: false });
    }
  });
}

// expose for pages
const Codebuffy = { api, toast, getKey, setKey, clearKey, theme, headers, setAuthChip, showPage, refreshPoolMini };
try {
  window.Codebuffy = Codebuffy;
} catch {}
try {
  globalThis.Codebuffy = Codebuffy;
} catch {}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

export { api, toast, getKey, setKey, clearKey, theme, headers, showPage };
export default Codebuffy;
