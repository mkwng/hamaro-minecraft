// Hamaro Minecraft control panel. Plain JS, no build step.
// API URL is stable forever (custom domain), so this file never needs regenerating.
const API = "https://api.mc.rowan.wang";

const $ = (id) => document.getElementById(id);
let token = localStorage.getItem("hamaro-token") || "";
let whoami = localStorage.getItem("hamaro-email") || "";
let lastStatus = null;
let startedAt = 0;
let warps = {};

// ---------- tiny api helper ----------
async function api(path, opts = {}) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(API + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && !path.startsWith("/login")) logout();
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- public status card ----------
function setCard(face, line) { $("status-face").textContent = face; $("status-line").textContent = line; }
function show(el, on) { $(el).classList.toggle("hidden", !on); }

async function refreshStatus() {
  try { lastStatus = await api("/status"); render(lastStatus); }
  catch { setCard("📡", "Can't reach the control API right now — try refreshing."); }
}

function render(s) {
  const srv = s.server;
  show("start-btn", false); show("progress", false); show("online-info", false);
  if (s.instance === "stopped") {
    setCard("😴", "The server is asleep");
    show("start-btn", true);
    $("start-btn").disabled = false;
  } else if (s.instance === "pending" || (s.instance === "running" && (!srv || srv.state === "starting" || srv.state === "unknown"))) {
    setCard("🌅", "Waking up…");
    show("progress", true);
    const pct = Math.min(95, ((Date.now() - (startedAt || Date.now() - 30000)) / 120000) * 100);
    $("bar-fill").style.width = pct + "%";
  } else if (s.instance === "running" && srv && srv.state === "running") {
    setCard("🟢", "The server is ON — come play!");
    show("online-info", true);
    $("addr").textContent = s.address;
    const n = srv.players ?? 0;
    $("players-line").textContent =
      n === 0 ? `Nobody on yet — world "${srv.profile}" is waiting (sleeps in ${Math.max(1, 15 - (srv.idleMinutes || 0))} min if empty)`
              : `🎮 ${n} player${n === 1 ? "" : "s"} on right now in "${srv.profile}"`;
  } else if (s.instance === "stopping") {
    setCard("🌙", "Going to sleep… (world is being saved and backed up)");
  } else {
    setCard("🤔", `Server machine is ${s.instance}`);
  }
}

$("start-btn").addEventListener("click", async () => {
  $("start-btn").disabled = true;
  try {
    await api("/start", { method: "POST", body: "{}" });
    startedAt = Date.now();
    setCard("🌅", "Waking up…"); show("start-btn", false); show("progress", true);
  } catch (e) { setCard("😵", e.message); $("start-btn").disabled = false; }
});

$("copy-btn").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("addr").textContent);
  $("copy-btn").textContent = "Copied!";
  setTimeout(() => ($("copy-btn").textContent = "Copy"), 1500);
});

// ---------- public: ask to join ----------
$("join-btn").addEventListener("click", async () => {
  try {
    const r = await api("/join-request", { method: "POST", body: JSON.stringify({ username: $("join-username").value, email: $("join-email").value }) });
    $("join-msg").textContent = r.note;
    $("join-username").value = ""; $("join-email").value = "";
  } catch (e) { $("join-msg").textContent = e.message; }
});

// ---------- admin login (magic link, password fallback) ----------
function logout() {
  token = ""; whoami = "";
  localStorage.removeItem("hamaro-token"); localStorage.removeItem("hamaro-email");
  show("admin-panel", false); show("login-box", true);
}
$("logout-btn").addEventListener("click", logout);

$("login-btn").addEventListener("click", async () => {
  $("login-err").textContent = "";
  try {
    const r = await api("/login-request", { method: "POST", body: JSON.stringify({ email: $("login-email").value }) });
    $("login-msg").textContent = r.note;
  } catch (e) { $("login-err").textContent = e.message; }
});

$("pw-login-btn").addEventListener("click", async () => {
  $("login-err").textContent = "";
  try {
    const r = await api("/login", { method: "POST", body: JSON.stringify({ password: $("password").value }) });
    token = r.token; whoami = "password login";
    localStorage.setItem("hamaro-token", token); localStorage.setItem("hamaro-email", whoami);
    $("password").value = "";
    enterAdmin();
  } catch (e) { $("login-err").textContent = e.message; }
});
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("pw-login-btn").click(); });

// Arriving via a magic link? (?login=<token>)
(async function magicArrival() {
  const t = new URLSearchParams(location.search).get("login");
  if (!t) return;
  history.replaceState(null, "", location.pathname);
  try {
    const r = await api("/login-verify", { method: "POST", body: JSON.stringify({ token: t }) });
    token = r.token; whoami = r.email;
    localStorage.setItem("hamaro-token", token); localStorage.setItem("hamaro-email", whoami);
    document.getElementById("admin").open = true;
    enterAdmin();
  } catch (e) {
    document.getElementById("admin").open = true;
    $("login-err").textContent = e.message;
  }
})();

function enterAdmin() {
  show("login-box", false); show("admin-panel", true);
  $("whoami").textContent = whoami ? `signed in as ${whoami}` : "";
  loadWorlds(); loadSettings(); loadBackups(); loadRequests(); loadAdmins(); loadWarps(); refreshOnline();
}
if (token) enterAdmin();

// ---------- tabs ----------
document.querySelectorAll(".tab").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tabpane").forEach((p) => p.classList.add("hidden"));
    show("tab-" + b.dataset.tab, true);
  })
);

// ---------- op progress ----------
async function watchOp(commandId, label) {
  const box = $("op-status");
  box.classList.remove("hidden");
  box.textContent = `${label}… `;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const r = await api("/ops/" + commandId);
      if (r.status === "Success") { box.textContent = `${label}: done ✔`; return r; }
      if (["Failed", "Cancelled", "TimedOut"].includes(r.status)) {
        box.textContent = `${label}: FAILED — ${r.error || r.output || r.status}`; return r;
      }
      box.textContent = `${label}… (${r.status.toLowerCase()})`;
    } catch { /* instance may be mid-restart; keep polling */ }
  }
  box.textContent = `${label}: still running — check back`;
}

// ---------- players: online list with give / tp / inventory ----------
async function refreshOnline() {
  if (!token) return;
  try {
    const r = await api("/players");
    const box = $("online-list");
    if (!r.serverUp) { box.textContent = "(server is asleep)"; return; }
    if (!r.online.length) { box.textContent = "(nobody on right now)"; return; }
    box.innerHTML = "";
    r.online.forEach((p) => {
      const div = document.createElement("div");
      div.className = "player-card";
      const warpOpts = Object.keys(warps).map((w) => `<option>${esc(w)}</option>`).join("");
      div.innerHTML = `
        <b>${esc(p.name)}</b>
        <span class="hint">${esc(p.dimension || "?")} · ${p.x ?? "?"}, ${p.y ?? "?"}, ${p.z ?? "?"}</span>
        <span class="spacer"></span>
        <button data-act="inv">Inventory</button>
        <button data-act="spot">Save spot as warp</button>
        <span class="giverow">
          <input data-role="item" list="item-ideas" placeholder="item (e.g. diamond)" style="max-width:170px">
          <input data-role="count" value="1" inputmode="numeric" style="max-width:50px">
          <button data-act="give">Give</button>
        </span>
        ${warpOpts ? `<span class="giverow"><select data-role="warp">${warpOpts}</select><button data-act="tp">TP</button></span>` : ""}
        <div class="inv hidden"></div>`;
      div.addEventListener("click", async (ev) => {
        const act = ev.target.dataset?.act;
        if (!act) return;
        try {
          if (act === "inv") {
            const inv = div.querySelector(".inv");
            inv.classList.toggle("hidden");
            if (!inv.classList.contains("hidden")) {
              inv.textContent = "peeking…";
              const r2 = await api(`/players/${p.name}/inventory`);
              inv.innerHTML = r2.items.length
                ? r2.items.map((it) => `<span class="invitem" title="${esc(it.item)} ×${it.count}">
                     <img src="/items/${esc(it.item)}.png" alt="" onerror="this.remove()"><i>${esc(it.item)}</i><em>×${it.count}</em></span>`).join("")
                : "(empty-handed!)";
            }
          } else if (act === "give") {
            const item = div.querySelector('[data-role="item"]').value.trim();
            const count = div.querySelector('[data-role="count"]').value;
            const r2 = await api("/give", { method: "POST", body: JSON.stringify({ player: p.name, item, count }) });
            flashOp(`✔ ${r2.gave}`);
          } else if (act === "tp") {
            const warp = div.querySelector('[data-role="warp"]').value;
            const r2 = await api("/tp", { method: "POST", body: JSON.stringify({ player: p.name, warp }) });
            flashOp(`✔ ${r2.teleported}`);
          } else if (act === "spot") {
            const name = prompt(`Name this warp (where ${p.name} is standing):`);
            if (!name) return;
            await api("/warps", { method: "POST", body: JSON.stringify({ name, player: p.name }) });
            loadWarps();
            flashOp(`✔ warp "${name}" saved`);
          }
        } catch (e) { flashOp("✖ " + e.message); }
      });
      box.appendChild(div);
    });
  } catch { /* transient */ }
}
setInterval(() => { if (token && !document.hidden && !$("tab-players").classList.contains("hidden")) refreshOnline(); }, 10000);

function flashOp(msg) {
  const box = $("op-status");
  box.classList.remove("hidden");
  box.textContent = msg;
}

// ---------- warps ----------
async function loadWarps() {
  if (!token) return;
  warps = (await api("/warps")).warps;
  const ul = $("warp-list"); ul.innerHTML = "";
  Object.entries(warps).forEach(([name, w]) => {
    const li = document.createElement("li");
    li.innerHTML = `<b>${esc(name)}</b> <span class="hint">${esc(w.dimension.replace("minecraft:", ""))} · ${w.x}, ${w.y}, ${w.z}</span><span class="spacer"></span>`;
    const rm = document.createElement("button");
    rm.textContent = "Delete";
    rm.onclick = async () => { await api("/warps/" + encodeURIComponent(name), { method: "DELETE" }); loadWarps(); };
    li.appendChild(rm);
    ul.appendChild(li);
  });
}
$("warp-add").addEventListener("click", async () => {
  try {
    await api("/warps", { method: "POST", body: JSON.stringify({ name: $("warp-name").value.trim(), x: $("warp-x").value, y: $("warp-y").value, z: $("warp-z").value }) });
    ["warp-name", "warp-x", "warp-y", "warp-z"].forEach((i) => ($(i).value = ""));
    loadWarps();
  } catch (e) { alert(e.message); }
});

// ---------- whitelist / ops (instant) ----------
function renderRoleList(ulId, names, role) {
  const ul = $(ulId); ul.innerHTML = "";
  names.forEach((name) => {
    const li = document.createElement("li");
    li.innerHTML = `${esc(name)}<span class="spacer"></span>`;
    const rm = document.createElement("button");
    rm.textContent = "Remove";
    rm.onclick = async () => {
      const r = await api("/players/" + role, { method: "POST", body: JSON.stringify({ name, action: "remove" }) });
      renderRoleList(ulId, r[role === "op" ? "ops" : "whitelist"], role);
      flashOp(`✔ removed ${name} (${r.applied})`);
    };
    li.appendChild(rm);
    ul.appendChild(li);
  });
}
async function addRole(inputId, role) {
  const name = $(inputId).value.trim();
  if (!name) return;
  const r = await api("/players/" + role, { method: "POST", body: JSON.stringify({ name, action: "add" }) });
  $(inputId).value = "";
  renderRoleList(role === "op" ? "opslist" : "whitelist", r[role === "op" ? "ops" : "whitelist"], role);
  flashOp(`✔ added ${name} (${r.applied})`);
  loadSettings(); // keep the settings textarea in sync
}
$("wl-add").addEventListener("click", () => addRole("wl-name", "whitelist").catch((e) => flashOp("✖ " + e.message)));
$("op-add").addEventListener("click", () => addRole("op-name", "op").catch((e) => flashOp("✖ " + e.message)));

// ---------- join requests ----------
async function loadRequests() {
  if (!token) return;
  const r = await api("/join-requests");
  const ul = $("request-list"); ul.innerHTML = "";
  const badge = $("req-badge");
  badge.classList.toggle("hidden", !r.requests.length);
  badge.textContent = r.requests.length || "";
  if (!r.requests.length) ul.innerHTML = "<li class='hint'>No pending requests.</li>";
  r.requests.forEach((req) => {
    const li = document.createElement("li");
    li.innerHTML = `<b>${esc(req.username)}</b> <span class="hint">${esc(req.email)} · ${new Date(req.at).toLocaleDateString()}</span><span class="spacer"></span>`;
    for (const action of ["approve", "deny"]) {
      const b = document.createElement("button");
      b.textContent = action === "approve" ? "Approve ✔" : "Deny";
      if (action === "deny") b.className = "danger";
      b.onclick = async () => {
        const res = await api("/join-requests/decide", { method: "POST", body: JSON.stringify({ username: req.username, action }) });
        if (res.approved) flashOp(res.emailNotified ? `✔ ${req.username} whitelisted + emailed` : `✔ ${req.username} whitelisted (email couldn't be sent)`);
        loadRequests(); loadSettings();
        const r2 = await api("/profiles/" + (lastStatus?.activeProfile || "survival"));
        renderPlayersFromEnv(r2.env);
      };
      li.appendChild(b);
    }
    ul.appendChild(li);
  });
}

// ---------- admins ----------
async function loadAdmins() {
  if (!token) return;
  const r = await api("/admins");
  const ul = $("admin-list"); ul.innerHTML = "";
  r.admins.forEach((email) => {
    const li = document.createElement("li");
    li.innerHTML = `${esc(email)}<span class="spacer"></span>`;
    const rm = document.createElement("button");
    rm.textContent = "Remove";
    rm.onclick = async () => {
      if (!confirm(`Remove ${email} from admins?`)) return;
      await api("/admins", { method: "PUT", body: JSON.stringify({ admins: r.admins.filter((e) => e !== email) }) });
      loadAdmins();
    };
    li.appendChild(rm);
    ul.appendChild(li);
  });
}
$("admin-add").addEventListener("click", async () => {
  const email = $("admin-email").value.trim();
  if (!email) return;
  const cur = (await api("/admins")).admins;
  await api("/admins", { method: "PUT", body: JSON.stringify({ admins: [...cur, email] }) });
  $("admin-email").value = "";
  loadAdmins();
});

// ---------- worlds ----------
async function loadWorlds() {
  const r = await api("/profiles");
  const ul = $("world-list"); ul.innerHTML = "";
  r.profiles.forEach((name) => {
    const li = document.createElement("li");
    const active = name === r.active;
    li.innerHTML = `<b>${esc(name)}</b> ${active ? '<span class="badge">active</span>' : ""}<span class="spacer"></span>`;
    if (!active) {
      const btn = document.createElement("button");
      btn.textContent = "Switch to this world";
      btn.onclick = async () => {
        if (!confirm(`Switch the server to "${name}"? The current world is backed up first.`)) return;
        const res = await api(`/profiles/${name}/activate`, { method: "POST", body: "{}" });
        if (res.commandId) watchOp(res.commandId, `Switching to ${name}`);
        else flashOp(res.note);
        loadWorlds(); loadSettings();
      };
      li.appendChild(btn);
    }
    ul.appendChild(li);
  });
}
$("new-world-btn").addEventListener("click", async () => {
  const name = $("new-world-name").value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) return alert("Name: lowercase letters, numbers, dashes.");
  let base = "";
  try { base = (await api("/profiles/" + (lastStatus?.activeProfile || "survival"))).env; } catch {}
  const env = base || "TYPE=PAPER\nVERSION=26.2\nMEMORY=6G\nENABLE_WHITELIST=TRUE\nENFORCE_WHITELIST=TRUE\nEXISTING_WHITELIST_FILE=SYNCHRONIZE\nWHITELIST=\nEXISTING_OPS_FILE=SYNCHRONIZE\nOPS=\n";
  await api("/profiles/" + name, { method: "PUT", body: JSON.stringify({ env }) });
  $("new-world-name").value = "";
  loadWorlds();
});

// ---------- settings ----------
let settingsProfile = "";
function envGetList(env, key) {
  const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
}
function renderPlayersFromEnv(env) {
  renderRoleList("whitelist", envGetList(env, "WHITELIST"), "whitelist");
  renderRoleList("opslist", envGetList(env, "OPS"), "op");
}
async function loadSettings() {
  const r = await api("/profiles");
  settingsProfile = r.active;
  $("settings-profile").textContent = settingsProfile;
  const p = await api("/profiles/" + settingsProfile);
  $("settings-env").value = p.env;
  renderPlayersFromEnv(p.env);
}
async function saveSettings(apply) {
  await api("/profiles/" + settingsProfile, { method: "PUT", body: JSON.stringify({ env: $("settings-env").value }) });
  if (apply) {
    const res = await api(`/profiles/${settingsProfile}/activate`, { method: "POST", body: "{}" });
    if (res.commandId) watchOp(res.commandId, "Applying settings");
  }
  renderPlayersFromEnv($("settings-env").value);
}
$("settings-save").addEventListener("click", () => saveSettings(false).catch((e) => alert(e.message)));
$("settings-apply").addEventListener("click", () => saveSettings(true).catch((e) => alert(e.message)));

// ---------- backups ----------
let selectedBackup = "";
async function loadBackups() {
  const r = await api("/backups");
  const ul = $("backup-list"); ul.innerHTML = "";
  r.backups.forEach((b) => {
    const li = document.createElement("li");
    const when = new Date(b.lastModified).toLocaleString();
    const mb = (b.size / 1048576).toFixed(1);
    li.innerHTML = `<code>${esc(b.key.split("/").pop())}</code> <span class="spacer"></span> ${when} · ${mb} MB`;
    li.onclick = () => {
      selectedBackup = b.key;
      document.querySelectorAll("#backup-list li").forEach((x) => x.classList.toggle("selected", x === li));
      $("restore-btn").disabled = false;
      if (!$("restore-target").value) $("restore-target").value = b.key.split("/")[1];
    };
    ul.appendChild(li);
  });
}
$("backup-now").addEventListener("click", async () => {
  try {
    const r = await api("/backup", { method: "POST", body: "{}" });
    await watchOp(r.commandId, "Backing up");
    loadBackups();
  } catch (e) { alert(e.message); }
});
$("restore-btn").addEventListener("click", async () => {
  const profile = $("restore-target").value.trim();
  if (!selectedBackup || !profile) return;
  if (!confirm(`Restore ${selectedBackup.split("/").pop()} into profile "${profile}"?\nIts current world data is kept as one-level undo (data.pre-restore).`)) return;
  try {
    const r = await api("/restore", { method: "POST", body: JSON.stringify({ key: selectedBackup, profile }) });
    watchOp(r.commandId, "Restoring");
  } catch (e) { alert(e.message); }
});

// ---------- console + map ----------
$("cmd-run").addEventListener("click", async () => {
  const command = $("cmd").value.trim();
  if (!command) return;
  $("cmd-out").textContent = "> " + command + "\n…";
  try {
    const r = await api("/command", { method: "POST", body: JSON.stringify({ command }) });
    const res = await watchOp(r.commandId, "Running command");
    $("cmd-out").textContent = "> " + command + "\n" + (res?.output || res?.error || "(no output)");
  } catch (e) { $("cmd-out").textContent = "> " + command + "\nERROR: " + e.message; }
});
$("cmd").addEventListener("keydown", (e) => { if (e.key === "Enter") $("cmd-run").click(); });

$("map-render").addEventListener("click", async () => {
  try {
    const r = await api("/map/render", { method: "POST", body: "{}" });
    watchOp(r.commandId, "Rendering world map");
  } catch (e) { alert(e.message); }
});

$("stop-btn").addEventListener("click", async () => {
  if (!confirm("Stop the server now? It saves and backs up first.")) return;
  try {
    const r = await api("/stop", { method: "POST", body: "{}" });
    watchOp(r.commandId, "Stopping");
  } catch (e) { alert(e.message); }
});

// ---------- item ideas for the Give box ----------
const ideas = ["diamond", "emerald", "golden_apple", "enchanted_golden_apple", "elytra", "netherite_ingot",
  "saddle", "name_tag", "cake", "cookie", "trident", "shield", "bow", "arrow", "oak_boat", "minecart",
  "diamond_sword", "diamond_pickaxe", "torch", "ender_pearl", "map", "compass", "spyglass", "firework_rocket"];
const dl = document.createElement("datalist");
dl.id = "item-ideas";
dl.innerHTML = ideas.map((i) => `<option value="${i}">`).join("");
document.body.appendChild(dl);

// ---------- poll loop ----------
refreshStatus();
setInterval(() => { if (!document.hidden) refreshStatus(); }, 5000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshStatus(); });
