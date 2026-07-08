// Hamaro smart maintenance — runs once nightly, during a fixed off-hours UTC
// window (see infra: ~3-4am Pacific). Zero npm dependencies.
//
// The ONLY thing that makes an update "safe to touch automatically" here is:
// the instance must be STOPPED. That's a stronger guarantee than "no players" —
// it means nobody can possibly be connected, mid-session or otherwise. If the
// instance is running for any reason (someone's playing, or between sessions),
// this does nothing and simply tries again tomorrow night.
//
// Update policy (matches the AMI incident's lesson: automate DETECTION freely,
// keep APPLICATION as deliberate as the risk warrants):
//   - Minecraft/Paper PATCH release within the same version family (26.2 -> 26.2.1):
//     low risk, no new content to miss out on — back up, apply, verify healthy,
//     auto-rollback + loud alert on any failure.
//   - A newer version FAMILY (26.2 -> 26.3) — likely means new content (a new
//     biome, etc.) the kids would want to be there for — NOTIFY ONLY, never
//     silently applied.
//   - A newer itzg server-image release — requires a code change + CI deploy
//     (MC_IMAGE_TAG is a stack-level constant), so this can only ever notify.
//   - The EC2 AMI is NEVER touched here. That stays fully manual, forever —
//     see the CI guard in .github/workflows/deploy.yml and docs/RUNBOOK.md.
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { SSMClient, GetParameterCommand, PutParameterCommand, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const ec2 = new EC2Client({});
const ssm = new SSMClient({});
const s3 = new S3Client({});
const ses = new SESv2Client({});
const { INSTANCE_ID, BUCKET, SENDER_EMAIL, MC_IMAGE_TAG } = process.env;

async function readJson(key, fallback) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return JSON.parse(await r.Body.transformToString());
  } catch { return fallback; }
}
async function writeJson(key, value) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: JSON.stringify(value, null, 2), ContentType: "application/json" }));
}

async function readAdmins() { return readJson("config/admins.json", []); }

async function notify(subject, text) {
  const admins = await readAdmins();
  if (!admins.length) return;
  try {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: SENDER_EMAIL,
      Destination: { ToAddresses: admins },
      Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
    }));
  } catch (e) { console.warn("notify email failed:", e.message); }
}

async function runCommand(script, timeoutMs = 20000) {
  const { Command } = await ssm.send(new SendCommandCommand({
    DocumentName: "AWS-RunShellScript", InstanceIds: [INSTANCE_ID],
    Parameters: { commands: [script], executionTimeout: ["1800"] },
  }));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = await ssm.send(new GetCommandInvocationCommand({ CommandId: Command.CommandId, InstanceId: INSTANCE_ID }));
      if (r.Status === "Success") return { ok: true, out: r.StandardOutputContent || "" };
      if (["Failed", "Cancelled", "TimedOut"].includes(r.Status)) return { ok: false, out: r.StandardErrorContent || r.Status };
    } catch (e) { if (e.name !== "InvocationDoesNotExist") throw e; }
  }
  return { ok: false, out: "timed out waiting for command" };
}

async function waitForHealthy(maxWaitMs = 4 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 15000));
    try {
      const hb = JSON.parse((await ssm.send(new GetParameterCommand({ Name: "/hamaro/heartbeat" }))).Parameter.Value);
      if (Date.now() / 1000 - hb.ts > 120) continue; // stale, keep waiting
      if (hb.state === "running") return { healthy: true };
      if (hb.bootError) return { healthy: false, reason: hb.lastError };
    } catch { /* not published yet */ }
  }
  return { healthy: false, reason: "server never reported healthy within the wait window" };
}

// --- version-family helpers: "26.2.1" -> family "26.2", patch 1 ---
function parseVersion(v) {
  const m = /^(\d+\.\d+)(?:\.(\d+))?$/.exec(v || "");
  return m ? { family: m[1], patch: +(m[2] || 0), full: v } : null;
}

async function fetchPaperFamilies() {
  const r = await fetch("https://fill.papermc.io/v3/projects/paper");
  const data = await r.json();
  return data.versions; // { "26.2": ["26.2","26.2-rc-2"], "26.1": ["26.1.2","26.1.1"], ... }
}

async function fetchLatestItzgTag() {
  const r = await fetch("https://hub.docker.com/v2/repositories/itzg/minecraft-server/tags?page_size=25&ordering=last_updated");
  const data = await r.json();
  const dated = data.results.map((t) => t.name).filter((n) => /^\d{4}\.\d+\.\d+$/.test(n));
  return dated.sort().at(-1) || null;
}

export async function handler() {
  const inst = (await ec2.send(new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] })))
    .Reservations[0].Instances[0];
  if (inst.State.Name !== "stopped") {
    return { ok: true, skipped: `instance is ${inst.State.Name}, not stopped — trying again tomorrow night` };
  }

  const profile = await (await ssm.send(new GetParameterCommand({ Name: "/hamaro/active-profile" }))).Parameter.Value;
  const envKey = `profiles/${profile}/profile.env`;
  const env = await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: envKey }))).Body.transformToString();
  const type = (env.match(/^TYPE=(.+)$/m)?.[1] || "").trim().toUpperCase();
  const current = parseVersion(env.match(/^VERSION=(.+)$/m)?.[1]?.trim());
  if (!current) return { ok: true, skipped: "active profile has no parseable VERSION" };

  const state = await readJson("config/maintenance-state.json", {});
  let patchCandidate = null, familyCandidate = null;

  if (type === "PAPER") {
    const families = await fetchPaperFamilies();
    const sameFamily = (families[current.family] || []).filter((v) => /^\d+\.\d+\.\d+$/.test(v) || /^\d+\.\d+$/.test(v));
    for (const v of sameFamily) {
      const p = parseVersion(v);
      if (p && p.patch > current.patch) patchCandidate = !patchCandidate || p.patch > parseVersion(patchCandidate).patch ? v : patchCandidate;
    }
    const otherFamilies = Object.keys(families).filter((f) => /^\d+\.\d+$/.test(f) && f !== current.family && f > current.family);
    if (otherFamilies.length) {
      const newest = otherFamilies.sort().at(-1);
      const stable = (families[newest] || []).find((v) => /^\d+(\.\d+)*$/.test(v));
      if (stable) familyCandidate = stable;
    }
  }

  const itzgLatest = await fetchLatestItzgTag().catch(() => null);
  const itzgUpdate = itzgLatest && MC_IMAGE_TAG && itzgLatest !== MC_IMAGE_TAG ? itzgLatest : null;

  const results = { profile, current: current.full, patchCandidate, familyCandidate, itzgUpdate };

  // ---- auto-apply: same-family patch only ----
  if (patchCandidate) {
    console.log(`applying patch update ${current.full} -> ${patchCandidate} on profile ${profile}`);
    const backup = await runCommand("/opt/hamaro/backup.sh --force", 60000);
    if (!backup.ok) {
      await notify("Hamaro Minecraft: skipped an update (backup failed)",
        `Tried to update ${profile} from ${current.full} to ${patchCandidate}, but the pre-update backup failed, so nothing was touched.\n\n${backup.out}`);
      return { ok: true, results, note: "backup failed, update skipped" };
    }
    const newEnv = env.replace(/^VERSION=.*$/m, `VERSION=${patchCandidate}`);
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: envKey, Body: newEnv, ContentType: "text/plain" }));
    const apply = await runCommand("/opt/hamaro/apply-config.sh", 120000);
    const health = apply.ok ? await waitForHealthy() : { healthy: false, reason: apply.out };

    if (health.healthy) {
      await notify(`Hamaro Minecraft: auto-updated to ${patchCandidate}`,
        `"${profile}" was automatically updated overnight: ${current.full} -> ${patchCandidate} (bugfix release, same content).\n\n` +
        `A backup of the previous version was taken first. Everything came up healthy.`);
      results.applied = patchCandidate;
    } else {
      console.warn("update did not come up healthy, rolling back:", health.reason);
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: envKey, Body: env, ContentType: "text/plain" })); // restore old VERSION
      await runCommand("/opt/hamaro/apply-config.sh", 120000);
      await notify(`Hamaro Minecraft: auto-update to ${patchCandidate} FAILED — rolled back safely`,
        `Tried updating "${profile}" from ${current.full} to ${patchCandidate} overnight. It didn't come up healthy afterward:\n\n${health.reason}\n\n` +
        `It has been rolled back to ${current.full} automatically. The world is safe — nothing was lost.`);
      results.rolledBack = true;
    }
  }

  // ---- notify-only: new content-bearing version family, or itzg image bump ----
  const notifyKey = `${familyCandidate || ""}|${itzgUpdate || ""}`;
  if ((familyCandidate || itzgUpdate) && state.lastNotified !== notifyKey) {
    const lines = [];
    if (familyCandidate) lines.push(`A new Minecraft version is available: ${current.family} -> ${familyCandidate}. This likely has new content (biomes, blocks, etc.) — apply it from World -> Settings when the family wants to see what's new, not silently overnight.`);
    if (itzgUpdate) lines.push(`A newer server-software release is available: ${MC_IMAGE_TAG} -> ${itzgUpdate}. Bump mcImageTag in infra/lib/config.ts and deploy when convenient (see RUNBOOK).`);
    await notify("Hamaro Minecraft: update(s) available", lines.join("\n\n"));
    await writeJson("config/maintenance-state.json", { lastNotified: notifyKey, ts: new Date().toISOString() });
  }

  return { ok: true, results };
}
