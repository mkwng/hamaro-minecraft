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
import { scrypt, createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const ec2 = new EC2Client({});
const ssm = new SSMClient({});
const s3 = new S3Client({});

const { INSTANCE_ID, BUCKET, GAME_DOMAIN, ALLOWED_ORIGIN, DAILY_START_CAP = "20" } = process.env;

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

async function signToken(ttlSeconds = 24 * 3600) {
  const key = await param("/hamaro/session-key", true);
  const exp = String(Math.floor(Date.now() / 1000) + ttlSeconds);
  const mac = b64u(createHmac("sha256", key).update("hamaro:" + exp).digest());
  return exp + "." + mac;
}

async function checkToken(headers) {
  const auth = headers?.authorization || headers?.Authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const [exp, mac] = token.split(".");
  if (!exp || !mac) return false;
  if (+exp < Date.now() / 1000) return false;
  const key = await param("/hamaro/session-key", true);
  const want = b64u(createHmac("sha256", key).update("hamaro:" + exp).digest());
  const a = Buffer.from(mac), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
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
  return reply(200, { token: await signToken() });
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
  return reply(202, { commandId: await runCommand("/opt/hamaro/backup.sh") });
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
  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body); }
    catch { return reply(400, { error: "invalid JSON" }); }
  }

  try {
    if (method === "GET" && path === "/status") return await getStatus();
    if (method === "POST" && path === "/start") return await postStart();
    if (method === "POST" && path === "/login") return await postLogin(body);

    // Everything below requires the admin token.
    if (!(await checkToken(event.headers))) return reply(401, { error: "admin login required" });

    if (method === "POST" && path === "/stop") return await postStop();
    if (method === "GET" && path === "/profiles") return await listProfiles();
    if (method === "POST" && path === "/backup") return await postBackup();
    if (method === "GET" && path === "/backups") return await listBackups();
    if (method === "POST" && path === "/restore") return await postRestore(body);
    if (method === "POST" && path === "/command") return await postCommand(body);

    let m;
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
