// Hamaro control API — single Lambda behind API Gateway (HTTP API, payload v2).
// Deliberately zero npm dependencies: only the AWS SDK v3 bundled in the Lambda
// runtime and node:crypto. See docs/RUNBOOK.md ("Why no frameworks").
//
// Public:  GET /status, POST /start
// Auth:    POST /login {password} -> bearer token (24 h)
// Admin:   POST /stop | GET /profiles | GET/PUT /profiles/{name}
//          POST /profiles/{name}/activate | POST /command {command}
//          POST /backup | GET /backups | POST /restore {key, profile}
//          GET /ops/{commandId}
import { EC2Client, DescribeInstancesCommand, StartInstancesCommand } from "@aws-sdk/client-ec2";
import { SSMClient, GetParameterCommand, PutParameterCommand, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { scrypt, createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const ec2 = new EC2Client({});
const ssm = new SSMClient({});
const s3 = new S3Client({});
const ses = new SESv2Client({});

const { INSTANCE_ID, BUCKET, GAME_DOMAIN, ALLOWED_ORIGIN, SENDER_EMAIL, DAILY_START_CAP = "20" } = process.env;

const CORS = {
  "access-control-allow-origin": ALLOWED_ORIGIN || "*",
  "content-type": "application/json",
};
const reply = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

// ---------- small helpers ----------

async function param(name, decrypt = false) {
  const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: decrypt }));
  return r.Parameter.Value;
}

async function instanceState() {
  const r = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
  const i = r.Reservations[0].Instances[0];
  return { state: i.State.Name, launchTime: i.LaunchTime };
}

async function heartbeat() {
  try { return JSON.parse(await param("/hamaro/heartbeat")); } catch { return null; }
}

async function runCommand(script) {
  const r = await ssm.send(new SendCommandCommand({
    DocumentName: "AWS-RunShellScript",
    InstanceIds: [INSTANCE_ID],
    Parameters: { commands: [script], executionTimeout: ["1800"] },
  }));
  return r.Command.CommandId;
}

// Run a script and wait for its output (for quick rcon round-trips; the admin
// panel needs synchronous answers for players/positions/inventory).
async function runCommandSync(script, timeoutMs = 20000) {
  const id = await runCommand(script);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 700));
    try {
      const r = await ssm.send(new GetCommandInvocationCommand({ CommandId: id, InstanceId: INSTANCE_ID }));
      if (r.Status === "Success") return r.StandardOutputContent || "";
      if (["Failed", "Cancelled", "TimedOut"].includes(r.Status)) {
        throw new Error((r.StandardErrorContent || r.Status).slice(0, 300));
      }
    } catch (e) {
      if (e.name !== "InvocationDoesNotExist") throw e; // not registered yet — keep polling
    }
  }
  throw new Error("command timed out");
}

const rcon = (cmd) => `docker exec hamaro-mc rcon-cli '${cmd.replace(/'/g, `'\\''`)}' 2>&1`;

// ---------- profile.env editing (whitelist/ops persist to S3) ----------

async function activeProfileEnv() {
  const name = await param("/hamaro/active-profile");
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `profiles/${name}/profile.env` }));
  return { name, env: await r.Body.transformToString() };
}

function envSetList(env, key, list) {
  const line = `${key}=${list.join(",")}`;
  return new RegExp(`^${key}=`, "m").test(env) ? env.replace(new RegExp(`^${key}=.*$`, "m"), line) : env + "\n" + line;
}

function envGetList(env, key) {
  const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
}

const NAME_RE = /^[A-Za-z0-9_]{1,16}$/; // Minecraft usernames

const b64u = (buf) => buf.toString("base64url");

function scryptAsync(password, salt, len, opts) {
  return new Promise((res, rej) => scrypt(password, salt, len, opts, (e, k) => (e ? rej(e) : res(k))));
}

// Stored hash format: scrypt:N:r:p:<salt b64url>:<hash b64url>
async function verifyPassword(password) {
  const stored = await param("/hamaro/admin-password-hash", true);
  const [scheme, N, r, p, salt, hash] = stored.split(":");
  if (scheme !== "scrypt") throw new Error("bad hash scheme");
  const expected = Buffer.from(hash, "base64url");
  const got = await scryptAsync(password, Buffer.from(salt, "base64url"), expected.length,
    { N: +N, r: +r, p: +p, maxmem: 128 * 1024 * 1024 });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// Session tokens: "<exp>.<who-b64url>.<hmac>". `who` is the admin's email, or
// "password" for the break-glass password login.
async function signToken(who, ttlSeconds) {
  const key = await param("/hamaro/session-key", true);
  const exp = String(Math.floor(Date.now() / 1000) + ttlSeconds);
  const w = b64u(Buffer.from(who));
  const mac = b64u(createHmac("sha256", key).update(`hamaro:${exp}:${w}`).digest());
  return `${exp}.${w}.${mac}`;
}

async function verifySigned(token) {
  const [exp, w, mac] = (token || "").split(".");
  if (!exp || !w || !mac || +exp < Date.now() / 1000) return null;
  const key = await param("/hamaro/session-key", true);
  const want = b64u(createHmac("sha256", key).update(`hamaro:${exp}:${w}`).digest());
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Buffer.from(w, "base64url").toString();
}

async function checkToken(headers) {
  const auth = headers?.authorization || headers?.Authorization || "";
  const who = await verifySigned(auth.replace(/^Bearer\s+/i, ""));
  return who !== null && !who.startsWith("magic:");
}

// ---------- magic-link login ----------

const ADMINS_KEY = "config/admins.json";
async function readAdmins() {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: ADMINS_KEY }));
    return JSON.parse(await r.Body.transformToString());
  } catch { return []; }
}

async function postLoginRequest(body) {
  const email = (body?.email || "").trim().toLowerCase();
  const generic = reply(200, { sent: true, note: "If that address is an admin, a sign-in link is on its way. It's valid for 15 minutes." });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return generic;
  const admins = await readAdmins();
  if (!admins.map((a) => a.toLowerCase()).includes(email)) { console.warn("AUTH_FAIL magic-link for non-admin"); return generic; }
  const link = `${ALLOWED_ORIGIN}/?login=${encodeURIComponent(await signToken("magic:" + email, 15 * 60))}`;
  await ses.send(new SendEmailCommand({
    FromEmailAddress: SENDER_EMAIL,
    Destination: { ToAddresses: [email] },
    Content: { Simple: {
      Subject: { Data: "Your Hamaro Minecraft sign-in link" },
      Body: { Text: { Data:
`Click to sign in to the Hamaro Minecraft control panel (valid 15 minutes):

${link}

If you didn't request this, ignore it — nobody gets in without this email.` } },
    } },
  }));
  return generic;
}

async function postLoginVerify(body) {
  const who = await verifySigned(body?.token || "");
  if (!who || !who.startsWith("magic:")) return reply(401, { error: "that sign-in link is invalid or expired — request a fresh one" });
  const email = who.slice(6);
  const admins = await readAdmins(); // re-check: revocation works even for unexpired links
  if (!admins.map((a) => a.toLowerCase()).includes(email)) return reply(401, { error: "this email is no longer an admin" });
  return reply(200, { token: await signToken(email, 30 * 24 * 3600), email });
}

async function getAdmins() { return reply(200, { admins: await readAdmins() }); }

async function putAdmins(body) {
  const admins = body?.admins;
  if (!Array.isArray(admins) || admins.length < 1 || !admins.every((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) {
    return reply(400, { error: "admins must be a non-empty list of emails (keep yourself on it!)" });
  }
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: ADMINS_KEY, Body: JSON.stringify(admins.map((e) => e.toLowerCase()), null, 2), ContentType: "application/json" }));
  return reply(200, { admins });
}

const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// ---------- route handlers ----------

async function getStatus() {
  const [inst, hb, active] = await Promise.all([
    instanceState(), heartbeat(), param("/hamaro/active-profile").catch(() => ""),
  ]);
  let server = null;
  if (inst.state === "running" && hb) {
    const stale = Date.now() / 1000 - hb.ts > 180;
    server = stale ? { state: "unknown" } : hb;
  }
  return reply(200, { instance: inst.state, server, address: GAME_DOMAIN, activeProfile: active });
}

async function postStart() {
  const inst = await instanceState();
  if (inst.state === "running" || inst.state === "pending") {
    return reply(200, { started: false, reason: "already " + inst.state });
  }
  if (inst.state !== "stopped") {
    return reply(409, { error: `instance is ${inst.state}; try again in a minute` });
  }
  // Daily start cap — the button is public, the bill is not.
  const today = new Date().toISOString().slice(0, 10);
  let log = { date: today, count: 0 };
  try { const cur = JSON.parse(await param("/hamaro/start-log")); if (cur.date === today) log = cur; } catch {}
  if (log.count >= +DAILY_START_CAP) return reply(429, { error: "daily start limit reached — try tomorrow" });
  log.count++;
  await ssm.send(new PutParameterCommand({ Name: "/hamaro/start-log", Type: "String", Overwrite: true, Value: JSON.stringify(log) }));
  await ec2.send(new StartInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
  return reply(200, { started: true, etaSeconds: 120 });
}

async function postLogin(body) {
  if (!body?.password || typeof body.password !== "string") return reply(400, { error: "password required" });
  if (!(await verifyPassword(body.password))) {
    console.warn("AUTH_FAIL"); // CloudWatch metric filter alarms on spikes of this
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 500));
    return reply(401, { error: "wrong password" });
  }
  return reply(200, { token: await signToken("password", 24 * 3600) });
}

async function requireRunning() {
  const inst = await instanceState();
  if (inst.state !== "running") throw reply(409, { error: `server machine is ${inst.state} — start it first` });
}

async function postStop() {
  await requireRunning();
  return reply(202, { commandId: await runCommand("/opt/hamaro/stop-server.sh poweroff") });
}

async function listProfiles() {
  const [r, active] = await Promise.all([
    s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "profiles/", Delimiter: "/" })),
    param("/hamaro/active-profile").catch(() => ""),
  ]);
  const names = (r.CommonPrefixes || []).map((p) => p.Prefix.split("/")[1]);
  return reply(200, { active, profiles: names });
}

async function getProfile(name) {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `profiles/${name}/profile.env` }));
  return reply(200, { name, env: await r.Body.transformToString() });
}

async function putProfile(name, body) {
  const env = body?.env;
  if (typeof env !== "string" || env.length > 16384) return reply(400, { error: "env text required" });
  const version = env.match(/^VERSION=(.+)$/m)?.[1]?.trim();
  if (!version || /^(LATEST|SNAPSHOT)$/i.test(version)) {
    return reply(400, { error: "profile.env must pin an explicit VERSION (never LATEST) — world upgrades are one-way" });
  }
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `profiles/${name}/profile.env`, Body: env, ContentType: "text/plain" }));
  // Applying is a separate explicit action (activate / apply), so edits are cheap.
  return reply(200, { saved: true, note: "activate/apply the profile to make it live" });
}

async function activateProfile(name) {
  // Ensure the profile exists before pointing the server at it.
  await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `profiles/${name}/profile.env` }));
  await ssm.send(new PutParameterCommand({ Name: "/hamaro/active-profile", Type: "String", Overwrite: true, Value: name }));
  const inst = await instanceState();
  if (inst.state === "running") {
    return reply(202, { active: name, commandId: await runCommand("/opt/hamaro/apply-config.sh") });
  }
  return reply(200, { active: name, note: "will take effect on next start" });
}

async function postCommand(body) {
  const cmd = body?.command;
  if (typeof cmd !== "string" || !cmd.trim() || cmd.length > 200 || /[\n\r]/.test(cmd)) {
    return reply(400, { error: "command required (single line, <200 chars)" });
  }
  await requireRunning();
  const safe = cmd.replace(/'/g, `'\\''`);
  return reply(202, { commandId: await runCommand(`docker exec hamaro-mc rcon-cli '${safe}'`) });
}

async function postBackup() {
  await requireRunning();
  // The admin button is an explicit ask — bypass the players-since-last-backup skip.
  return reply(202, { commandId: await runCommand("/opt/hamaro/backup.sh --force") });
}

async function listBackups() {
  const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "backups/" }));
  const items = (r.Contents || [])
    .map((o) => ({ key: o.Key, size: o.Size, lastModified: o.LastModified }))
    .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified))
    .slice(0, 200);
  return reply(200, { backups: items });
}

async function postRestore(body) {
  const { key, profile } = body || {};
  if (!key?.startsWith("backups/") || !PROFILE_RE.test(profile || "")) {
    return reply(400, { error: "need backup key and target profile name" });
  }
  await requireRunning();
  const safeKey = key.replace(/'/g, "");
  return reply(202, { commandId: await runCommand(`/opt/hamaro/restore.sh '${safeKey}' '${profile}'`) });
}

// ---------- Admin v2: players, items, warps, map ----------

// Instant whitelist/op management: persists to profile.env in S3 (survives
// forever) AND applies live over rcon when the server is up (no restart).
async function postPlayerRole(body, role /* "whitelist" | "op" */) {
  const { name, action } = body || {};
  if (!NAME_RE.test(name || "") || !["add", "remove"].includes(action)) {
    return reply(400, { error: "need a valid Minecraft username and action add|remove" });
  }
  const key = role === "op" ? "OPS" : "WHITELIST";
  const { name: profile, env } = await activeProfileEnv();
  let list = envGetList(env, key).filter((n) => n.toLowerCase() !== name.toLowerCase());
  if (action === "add") list.push(name);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: `profiles/${profile}/profile.env`,
    Body: envSetList(env, key, list), ContentType: "text/plain",
  }));

  let applied = "on next start";
  if ((await instanceState()).state === "running") {
    const verb = role === "op" ? (action === "add" ? "op" : "deop") : `whitelist ${action}`;
    try { await runCommandSync(rcon(`${verb} ${name}`)); applied = "live"; } catch { applied = "saved; live apply failed"; }
  }
  return reply(200, { [key.toLowerCase()]: list, applied });
}

// Online players with position + dimension, one SSM round-trip for all.
async function getPlayers() {
  if ((await instanceState()).state !== "running") return reply(200, { online: [], serverUp: false });
  // rcon-cli joins its arguments, and usernames are [A-Za-z0-9_] — no quoting games needed.
  const script = `
LIST=$(docker exec hamaro-mc rcon-cli list 2>&1)
echo "LIST|$LIST"
NAMES=$(echo "$LIST" | sed 's/.*online://' | tr ',' '\\n' | tr -cd 'A-Za-z0-9_\\n')
for P in $NAMES; do
  [ -z "$P" ] && continue
  echo "POS|$P|$(docker exec hamaro-mc rcon-cli data get entity $P Pos 2>&1)"
  echo "DIM|$P|$(docker exec hamaro-mc rcon-cli data get entity $P Dimension 2>&1)"
done`;
  const out = await runCommandSync(script);
  const online = [];
  const byName = {};
  for (const line of out.split("\n")) {
    const [tag, ...rest] = line.split("|");
    if (tag === "POS") {
      const [p, data] = [rest[0], rest.slice(1).join("|")];
      const m = data.match(/\[(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/);
      byName[p] = byName[p] || { name: p };
      if (m) Object.assign(byName[p], { x: Math.round(+m[1]), y: Math.round(+m[2]), z: Math.round(+m[3]) });
    } else if (tag === "DIM") {
      const [p, data] = [rest[0], rest.slice(1).join("|")];
      byName[p] = byName[p] || { name: p };
      byName[p].dimension = (data.match(/minecraft:(\w+)/) || [])[1] || "overworld";
    }
  }
  for (const p of Object.values(byName)) online.push(p);
  return reply(200, { online, serverUp: true });
}

async function postGive(body) {
  const { player, item, count } = body || {};
  const n = Math.min(Math.max(parseInt(count || 1, 10) || 1, 1), 64);
  if (!NAME_RE.test(player || "") || !/^[a-z0-9_]+(:[a-z0-9_/]+)?$/.test(item || "")) {
    return reply(400, { error: "need player and a plain item id like diamond or minecraft:oak_boat" });
  }
  await requireRunning();
  const out = await runCommandSync(rcon(`give ${player} ${item} ${n}`));
  if (/Unknown item|No player was found|Incorrect argument/i.test(out)) return reply(400, { error: out.trim().slice(0, 200) });
  return reply(200, { gave: `${n}x ${item} to ${player}`, raw: out.trim().slice(0, 200) });
}

// Warps: named points per profile, stored next to the profile config in S3.
async function warpsKey() { return `profiles/${await param("/hamaro/active-profile")}/warps.json`; }
async function readWarps() {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: await warpsKey() }));
    return JSON.parse(await r.Body.transformToString());
  } catch { return {}; }
}

async function getWarps() { return reply(200, { warps: await readWarps() }); }

async function postWarp(body) {
  const { name, player, x, y, z, dimension } = body || {};
  if (!/^[a-z0-9][a-z0-9-_ ]{0,30}$/i.test(name || "")) return reply(400, { error: "warp name required" });
  let point;
  if (NAME_RE.test(player || "")) {
    await requireRunning(); // "save where <player> is standing"
    const out = await runCommandSync(rcon(`data get entity ${player} Pos`) + " && " + rcon(`data get entity ${player} Dimension`));
    const m = out.match(/\[(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/);
    if (!m) return reply(400, { error: `${player} doesn't seem to be online` });
    point = {
      x: Math.round(+m[1]), y: Math.round(+m[2]), z: Math.round(+m[3]),
      dimension: "minecraft:" + ((out.match(/minecraft:(\w+)"?\s*$/m) || [])[1] || "overworld"),
    };
  } else if ([x, y, z].every((v) => Number.isFinite(+v))) {
    point = { x: +x, y: +y, z: +z, dimension: dimension || "minecraft:overworld" };
  } else {
    return reply(400, { error: "give a player to snapshot, or x/y/z coordinates" });
  }
  const warps = await readWarps();
  warps[name] = point;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: await warpsKey(), Body: JSON.stringify(warps, null, 2), ContentType: "application/json" }));
  return reply(200, { warps });
}

async function deleteWarp(name) {
  const warps = await readWarps();
  delete warps[name];
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: await warpsKey(), Body: JSON.stringify(warps, null, 2), ContentType: "application/json" }));
  return reply(200, { warps });
}

async function postTp(body) {
  const { player, warp } = body || {};
  if (!NAME_RE.test(player || "")) return reply(400, { error: "player required" });
  const warps = await readWarps();
  const w = warps[warp];
  if (!w) return reply(404, { error: `no warp named "${warp}"` });
  await requireRunning();
  const out = await runCommandSync(rcon(`execute in ${w.dimension} run tp ${player} ${w.x} ${w.y} ${w.z}`));
  if (/No player was found/i.test(out)) return reply(400, { error: `${player} is not online` });
  return reply(200, { teleported: `${player} → ${warp}`, raw: out.trim().slice(0, 200) });
}

// Inventory peek: parse the SNBT well enough to list items and counts.
async function getInventory(name) {
  await requireRunning();
  const out = await runCommandSync(rcon(`data get entity ${name} Inventory`));
  if (/No entity was found|No player was found/i.test(out)) return reply(404, { error: `${name} is not online` });
  const items = [];
  // Matches entries like: {count: 3, Slot: 0b, id: "minecraft:oak_log", ...}
  const re = /Slot:\s*(\d+)b[^}]*?id:\s*"([a-z0-9_:]+)"|id:\s*"([a-z0-9_:]+)"[^}]*?Slot:\s*(\d+)b/g;
  const counts = [...out.matchAll(/(?:count|Count):\s*(\d+)/g)].map((m) => +m[1]);
  let i = 0, m;
  while ((m = re.exec(out))) {
    items.push({ slot: +(m[1] ?? m[4]), item: (m[2] ?? m[3]).replace("minecraft:", ""), count: counts[i++] ?? 1 });
  }
  items.sort((a, b) => a.slot - b.slot);
  return reply(200, { player: name, items, raw: items.length ? undefined : out.trim().slice(0, 500) });
}

// ---------- join requests (public ask → admin approve → whitelist + email) ----------

const JOIN_KEY = "config/join-requests.json";
async function readJoinRequests() {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: JOIN_KEY }));
    return JSON.parse(await r.Body.transformToString());
  } catch { return []; }
}
async function writeJoinRequests(list) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: JOIN_KEY, Body: JSON.stringify(list, null, 2), ContentType: "application/json" }));
}

async function sendMail(to, subject, text) {
  try {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: SENDER_EMAIL,
      Destination: { ToAddresses: Array.isArray(to) ? to : [to] },
      Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
    }));
    return true;
  } catch (e) { console.warn("mail failed:", e.message); return false; } // sandbox / unverified recipient
}

async function postJoinRequest(body) {
  const username = (body?.username || "").trim();
  const email = (body?.email || "").trim().toLowerCase();
  if (!NAME_RE.test(username)) return reply(400, { error: "that doesn't look like a Minecraft username" });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply(400, { error: "a valid email is needed so we can tell you when you're approved" });

  const { env } = await activeProfileEnv();
  if (envGetList(env, "WHITELIST").some((n) => n.toLowerCase() === username.toLowerCase())) {
    return reply(200, { ok: true, note: "Good news — that player is already whitelisted! Just join at " + GAME_DOMAIN });
  }
  const list = await readJoinRequests();
  if (list.length >= 50) return reply(429, { error: "too many pending requests — ask a grown-up admin directly" });
  if (!list.some((r) => r.username.toLowerCase() === username.toLowerCase())) {
    list.push({ username, email, at: new Date().toISOString() });
    await writeJoinRequests(list);
    const admins = await readAdmins();
    if (admins.length) {
      await sendMail(admins, `Hamaro Minecraft: "${username}" asked to join`,
        `${username} (${email}) asked to join the server.\n\nApprove or deny in the Grown-ups panel:\n${ALLOWED_ORIGIN}\n`);
    }
  }
  return reply(200, { ok: true, note: "Request sent! A grown-up will approve it and you'll get an email." });
}

async function getJoinRequests() { return reply(200, { requests: await readJoinRequests() }); }

async function decideJoinRequest(body) {
  const { username, action } = body || {};
  if (!NAME_RE.test(username || "") || !["approve", "deny"].includes(action)) {
    return reply(400, { error: "need username and action approve|deny" });
  }
  const list = await readJoinRequests();
  const req = list.find((r) => r.username.toLowerCase() === username.toLowerCase());
  if (!req) return reply(404, { error: "no such pending request" });
  await writeJoinRequests(list.filter((r) => r !== req));

  if (action === "approve") {
    await postPlayerRole({ name: req.username, action: "add" }, "whitelist");
    const mailed = await sendMail(req.email, "You're in! Hamaro Minecraft whitelist approved",
      `Hi ${req.username},\n\nYou've been approved to play on the Hamaro family Minecraft server!\n\n` +
      `Server address (Minecraft Java Edition):  ${GAME_DOMAIN}\n\n` +
      `If the server is asleep, anyone can wake it at ${ALLOWED_ORIGIN} — it starts in about two minutes.\n\nHave fun!`);
    return reply(200, { approved: req.username, emailNotified: mailed });
  }
  return reply(200, { denied: req.username });
}

// Server log tail for the console pane.
async function getLogs(query) {
  const lines = Math.min(Math.max(parseInt(query?.lines || "80", 10) || 80, 10), 400);
  if ((await instanceState()).state !== "running") return reply(200, { serverUp: false, log: "" });
  const out = await runCommandSync(`docker logs hamaro-mc --tail ${lines} 2>&1 | cut -c1-400`);
  return reply(200, { serverUp: true, log: out });
}

async function getOp(commandId) {
  try {
    const r = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: INSTANCE_ID }));
    return reply(200, {
      status: r.Status, // Pending | InProgress | Success | Failed | ...
      output: (r.StandardOutputContent || "").slice(-2000),
      error: (r.StandardErrorContent || "").slice(-2000),
    });
  } catch {
    return reply(404, { error: "unknown command id" });
  }
}

// ---------- router ----------

export async function handler(event) {
  const method = event.requestContext?.http?.method || "GET";
  const path = (event.rawPath || "/").replace(/\/+$/, "") || "/";

  // The $default route catches OPTIONS before API Gateway's CORS shortcut can,
  // so answer preflights here (a 401 preflight blocks every browser request).
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        ...CORS,
        "access-control-allow-methods": "GET,POST,PUT,DELETE",
        "access-control-allow-headers": "authorization,content-type",
        "access-control-max-age": "3600",
      },
    };
  }
  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body); }
    catch { return reply(400, { error: "invalid JSON" }); }
  }

  try {
    if (method === "GET" && path === "/status") return await getStatus();
    if (method === "POST" && path === "/start") return await postStart();
    if (method === "POST" && path === "/login") return await postLogin(body);          // break-glass password
    if (method === "POST" && path === "/login-request") return await postLoginRequest(body); // magic link
    if (method === "POST" && path === "/login-verify") return await postLoginVerify(body);
    if (method === "POST" && path === "/join-request") return await postJoinRequest(body);   // public ask-to-join

    // Everything below requires the admin token.
    if (!(await checkToken(event.headers))) return reply(401, { error: "admin login required" });

    if (method === "POST" && path === "/stop") return await postStop();
    if (method === "GET" && path === "/profiles") return await listProfiles();
    if (method === "POST" && path === "/backup") return await postBackup();
    if (method === "GET" && path === "/backups") return await listBackups();
    if (method === "POST" && path === "/restore") return await postRestore(body);
    if (method === "POST" && path === "/command") return await postCommand(body);
    if (method === "GET" && path === "/admins") return await getAdmins();
    if (method === "PUT" && path === "/admins") return await putAdmins(body);
    if (method === "GET" && path === "/join-requests") return await getJoinRequests();
    if (method === "POST" && path === "/join-requests/decide") return await decideJoinRequest(body);
    if (method === "GET" && path === "/players") return await getPlayers();
    if (method === "GET" && path === "/logs") return await getLogs(event.queryStringParameters);
    if (method === "POST" && path === "/players/whitelist") return await postPlayerRole(body, "whitelist");
    if (method === "POST" && path === "/players/op") return await postPlayerRole(body, "op");
    if (method === "POST" && path === "/give") return await postGive(body);
    if (method === "GET" && path === "/warps") return await getWarps();
    if (method === "POST" && path === "/warps") return await postWarp(body);
    if (method === "POST" && path === "/tp") return await postTp(body);
    if (method === "POST" && path === "/map/render") { await requireRunning(); return reply(202, { commandId: await runCommand("/opt/hamaro/render-map.sh") }); }

    let m;
    if ((m = path.match(/^\/warps\/([a-z0-9][a-z0-9-_ ]{0,30})$/i)) && method === "DELETE") return await deleteWarp(m[1]);
    if ((m = path.match(/^\/players\/([A-Za-z0-9_]{1,16})\/inventory$/)) && method === "GET") return await getInventory(m[1]);
    if ((m = path.match(/^\/profiles\/([^/]+)$/)) && PROFILE_RE.test(m[1])) {
      if (method === "GET") return await getProfile(m[1]);
      if (method === "PUT") return await putProfile(m[1], body);
    }
    if ((m = path.match(/^\/profiles\/([^/]+)\/activate$/)) && PROFILE_RE.test(m[1]) && method === "POST") {
      return await activateProfile(m[1]);
    }
    if ((m = path.match(/^\/ops\/([\w-]+)$/)) && method === "GET") return await getOp(m[1]);

    return reply(404, { error: "no such route" });
  } catch (err) {
    if (err?.statusCode && err?.body) return err; // thrown reply() (e.g. requireRunning)
    console.error(err);
    return reply(500, { error: "internal error" });
  }
}
