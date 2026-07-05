// Hamaro reaper — the independent safety net. Runs every 15 minutes via
// EventBridge. Force-stops the game instance if it is clearly wedged, so a
// broken watchdog can never turn into an always-on bill. Zero npm dependencies.
//
// Stops the instance when EITHER:
//   - uptime exceeds UPTIME_CAP_HOURS (default 12 — generous for a marathon), or
//   - the on-instance watchdog heartbeat is stale (instance up >35 min but no
//     heartbeat written in the last HEARTBEAT_STALE_MINUTES).
import { EC2Client, DescribeInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const ec2 = new EC2Client({});
const ssm = new SSMClient({});
const sns = new SNSClient({});

const { INSTANCE_ID, SNS_TOPIC_ARN, UPTIME_CAP_HOURS = "12", HEARTBEAT_STALE_MINUTES = "30" } = process.env;

export async function handler() {
  const r = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
  const i = r.Reservations[0].Instances[0];
  if (i.State.Name !== "running") return { ok: true, state: i.State.Name };

  const uptimeMin = (Date.now() - new Date(i.LaunchTime).getTime()) / 60000;

  let hbAgeMin = Infinity;
  try {
    const hb = JSON.parse((await ssm.send(new GetParameterCommand({ Name: "/hamaro/heartbeat" }))).Parameter.Value);
    hbAgeMin = (Date.now() / 1000 - hb.ts) / 60;
  } catch {}

  let reason = null;
  if (uptimeMin > +UPTIME_CAP_HOURS * 60) {
    reason = `uptime ${Math.round(uptimeMin / 60)}h exceeded the ${UPTIME_CAP_HOURS}h cap`;
  } else if (uptimeMin > 35 && hbAgeMin > +HEARTBEAT_STALE_MINUTES) {
    reason = `watchdog heartbeat stale (${Math.round(hbAgeMin)} min) — instance looks wedged`;
  }
  if (!reason) return { ok: true, uptimeMin: Math.round(uptimeMin), hbAgeMin: Math.round(hbAgeMin) };

  console.warn("REAPING:", reason);
  await ec2.send(new StopInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
  if (SNS_TOPIC_ARN) {
    await sns.send(new PublishCommand({
      TopicArn: SNS_TOPIC_ARN,
      Subject: "Hamaro Minecraft: reaper stopped the server",
      Message: `The reaper force-stopped ${INSTANCE_ID}.\n\nReason: ${reason}\n\n` +
        `The world is safe (last good backup is in S3; the EBS volume is intact). ` +
        `Just press Start on the website to bring it back. If this repeats, see docs/RUNBOOK.md.`,
    }));
  }
  return { ok: true, reaped: reason };
}
