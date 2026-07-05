// Hamaro Minecraft control panel. Plain JS, no build step.
// API URL is stable forever (custom domain), so this file never needs regenerating.
const API = "https://api.mc.rowan.wang";

const $ = (id) => document.getElementById(id);
let token = localStorage.getItem("hamaro-token") || "";
let lastStatus = null;
let startedAt = 0; // when we pressed Start (for the progress bar)

// ---------- tiny api helper ----------
async function api(path, opts = {}) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(API + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && path !== "/login") logout();
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

// ---------- public status card ----------
function setCard(face, line) { $("status-face").textContent = face; $("status-line").textContent = line; }
function show(el, on) { $(el).classList.toggle("hidden", !on); }

async function refreshStatus() {
  try {
    const s = await api("/status");
    lastStatus = s;
    render(s);
  } catch {
    setCard("📡", "Can't reach the control API right now — try refreshing.");
  }
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
    setCard("🌅", "Waking up…");
    show("start-btn", false); show("progress", true);
  } catch (e) {
    setCard("😵", e.message);
    $("start-btn").disabled = false;
  }
});

$("copy-btn").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("addr").textContent);
  $("copy-btn").textContent = "Copied!";
  setTimeout(() => ($("copy-btn").textContent = "Copy"), 1500);
});

// ---------- admin: login ----------
function logout() {
  token = ""; localStorage.removeItem("hamaro-token");
  show("admin-panel", false); show("login-box", true);
}
$("logout-btn").addEventListener("click", logout);

$("login-btn").addEventListener("click", async () => {
  $("login-err").textContent = "";
  try {
    const r = await api("/login", { method: "POST", body: JSON.stringify({ password: $("password").value }) });
    token = r.token; localStorage.setItem("hamaro-token", token);
    $("password").value = "";
    enterAdmin();
  } catch (e) { $("login-err").textContent = e.message; }
});
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("login-btn").click(); });

function enterAdmin() {
  show("login-box", false); show("admin-panel", true);
  loadWorlds(); loadSettings(); loadBackups();
}
if (token) enterAdmin();

// ---------- admin: tabs ----------
document.querySelectorAll(".tab").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tabpane").forEach((p) => p.classList.add("hidden"));
    show("tab-" + b.dataset.tab, true);
  })
);

// ---------- op progress (SSM command polling) ----------
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

// ---------- worlds ----------
const DEFAULT_ENV = (base) => (base || `TYPE=PAPER
VERSION=26.2
MEMORY=6G
MOTD=New Hamaro world
DIFFICULTY=easy
MODE=survival
ENABLE_WHITELIST=TRUE
ENFORCE_WHITELIST=TRUE
EXISTING_WHITELIST_FILE=SYNCHRONIZE
WHITELIST=
EXISTING_OPS_FILE=SYNCHRONIZE
OPS=
`);

async function loadWorlds() {
  const r = await api("/profiles");
  const ul = $("world-list");
  ul.innerHTML = "";
  r.profiles.forEach((name) => {
    const li = document.createElement("li");
    const active = name === r.active;
    li.innerHTML = `<b>${name}</b> ${active ? '<span class="badge">active</span>' : ""}<span class="spacer"></span>`;
    if (!active) {
      const btn = document.createElement("button");
      btn.textContent = "Switch to this world";
      btn.onclick = async () => {
        if (!confirm(`Switch the server to "${name}"? The current world is backed up first.`)) return;
        const res = await api(`/profiles/${name}/activate`, { method: "POST", body: "{}" });
        if (res.commandId) watchOp(res.commandId, `Switching to ${name}`);
        else alert(res.note);
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
  // Copy the active profile's env as a starting point, keeping worlds consistent.
  let base = "";
  try { base = (await api("/profiles/" + (lastStatus?.activeProfile || ""))).env; } catch {}
  await api("/profiles/" + name, { method: "PUT", body: JSON.stringify({ env: DEFAULT_ENV(base) }) });
  $("new-world-name").value = "";
  loadWorlds();
});

// ---------- settings (edits the ACTIVE profile) ----------
let settingsProfile = "";
async function loadSettings() {
  const r = await api("/profiles");
  settingsProfile = r.active;
  $("settings-profile").textContent = settingsProfile;
  const p = await api("/profiles/" + settingsProfile);
  $("settings-env").value = p.env;
  renderPlayers(p.env);
}
async function saveSettings(apply) {
  await api("/profiles/" + settingsProfile, { method: "PUT", body: JSON.stringify({ env: $("settings-env").value }) });
  if (apply) {
    const res = await api(`/profiles/${settingsProfile}/activate`, { method: "POST", body: "{}" });
    if (res.commandId) watchOp(res.commandId, "Applying settings");
  }
  renderPlayers($("settings-env").value);
}
$("settings-save").addEventListener("click", () => saveSettings(false).catch((e) => alert(e.message)));
$("settings-apply").addEventListener("click", () => saveSettings(true).catch((e) => alert(e.message)));

// ---------- players (WHITELIST / OPS lines of the active profile) ----------
function envGetList(env, key) {
  const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
}
function envSetList(env, key, list) {
  const line = `${key}=${list.join(",")}`;
  return env.match(new RegExp(`^${key}=`, "m")) ? env.replace(new RegExp(`^${key}=.*$`, "m"), line) : env + "\n" + line;
}
let wl = [], ops = [];
function renderPlayers(env) {
  wl = envGetList(env, "WHITELIST"); ops = envGetList(env, "OPS");
  for (const [ulId, list, arr] of [["whitelist", wl, wl], ["opslist", ops, ops]]) {
    const ul = $(ulId); ul.innerHTML = "";
    list.forEach((name, i) => {
      const li = document.createElement("li");
      li.innerHTML = `${name}<span class="spacer"></span>`;
      const rm = document.createElement("button");
      rm.textContent = "Remove";
      rm.onclick = () => { arr.splice(i, 1); syncPlayersToEnv(); };
      li.appendChild(rm);
      ul.appendChild(li);
    });
  }
}
function syncPlayersToEnv() {
  let env = $("settings-env").value;
  env = envSetList(env, "WHITELIST", wl);
  env = envSetList(env, "OPS", ops);
  $("settings-env").value = env;
  renderPlayers(env);
}
$("wl-add").addEventListener("click", () => { const v = $("wl-name").value.trim(); if (v) { wl.push(v); $("wl-name").value = ""; syncPlayersToEnv(); } });
$("op-add").addEventListener("click", () => { const v = $("op-name").value.trim(); if (v) { ops.push(v); $("op-name").value = ""; syncPlayersToEnv(); } });
$("players-save").addEventListener("click", () => saveSettings(true).catch((e) => alert(e.message)));

// ---------- backups ----------
let selectedBackup = "";
async function loadBackups() {
  const r = await api("/backups");
  const ul = $("backup-list"); ul.innerHTML = "";
  r.backups.forEach((b) => {
    const li = document.createElement("li");
    const when = new Date(b.lastModified).toLocaleString();
    const mb = (b.size / 1048576).toFixed(1);
    li.innerHTML = `<code>${b.key.split("/").pop()}</code> <span class="spacer"></span> ${when} · ${mb} MB`;
    li.onclick = () => {
      selectedBackup = b.key;
      document.querySelectorAll("#backup-list li").forEach((x) => x.classList.toggle("selected", x === li));
      $("restore-btn").disabled = false;
      const guess = b.key.split("/")[1];
      if (!$("restore-target").value) $("restore-target").value = guess;
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

// ---------- console ----------
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

$("stop-btn").addEventListener("click", async () => {
  if (!confirm("Stop the server now? It saves and backs up first.")) return;
  try {
    const r = await api("/stop", { method: "POST", body: "{}" });
    watchOp(r.commandId, "Stopping");
  } catch (e) { alert(e.message); }
});

// ---------- poll loop ----------
refreshStatus();
setInterval(() => { if (!document.hidden) refreshStatus(); }, 5000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshStatus(); });
