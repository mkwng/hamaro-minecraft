// Hamaro scheduler — runs scheduled recipes ("daily 4pm gift") when their time
// window arrives AND the server is running. EventBridge fires this every 15
// minutes; entries run at most once per day. Zero npm dependencies.
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { SSMClient, SendCommandCommand } from "@aws-sdk/client-ssm";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const ec2 = new EC2Client({});
const ssm = new SSMClient({});
const s3 = new S3Client({});
const { INSTANCE_ID, BUCKET } = process.env;

async function readJson(key, fallback) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return JSON.parse(await r.Body.transformToString());
  } catch { return fallback; }
}

export async function handler() {
  const schedule = await readJson("config/schedule.json", []);
  if (!schedule.length) return { ok: true, entries: 0 };

  const inst = (await ec2.send(new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] })))
    .Reservations[0].Instances[0];
  if (inst.State.Name !== "running") return { ok: true, note: "server asleep" };

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const minsNow = now.getUTCHours() * 60 + now.getUTCMinutes();
  const lastRuns = await readJson("config/schedule-runs.json", {});
  const recipes = await readJson("config/recipes.json", {});
  let ran = 0;

  for (const e of schedule) {
    const [h, m] = e.atUTC.split(":").map(Number);
    const due = minsNow >= h * 60 + m && minsNow < h * 60 + m + 15; // this 15-min window
    const key = `${e.recipe}@${e.atUTC}`;
    if (!due || lastRuns[key] === today) continue;
    const r = recipes[e.recipe];
    if (!r) continue;
    const cmds = [];
    for (const s of r.steps) {
      if (s.includes("{player}")) for (const p of e.players || []) cmds.push(s.replaceAll("{player}", p));
      else cmds.push(s);
    }
    if (!cmds.length) continue;
    const script = cmds.map((c) => `docker exec hamaro-mc rcon-cli '${c.replace(/'/g, `'\\''`)}' 2>&1`).join("\n");
    await ssm.send(new SendCommandCommand({
      DocumentName: "AWS-RunShellScript",
      InstanceIds: [INSTANCE_ID],
      Parameters: { commands: [script], executionTimeout: ["600"] },
    }));
    lastRuns[key] = today;
    ran++;
    console.log(`ran scheduled recipe ${key} (${cmds.length} commands)`);
  }

  if (ran) {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: "config/schedule-runs.json",
      Body: JSON.stringify(lastRuns), ContentType: "application/json",
    }));
  }
  return { ok: true, ran };
}
