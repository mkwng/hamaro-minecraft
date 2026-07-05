// Single source of truth for everything tweakable. Change here, `cdk deploy`.
export const CONFIG = {
  gameRegion: "us-west-2",   // close to the family (Pacific time)
  webRegion: "us-east-1",    // CloudFront certs must live here

  gameDomain: "mc.rowan.wang",        // what the kids type into Minecraft
  apiDomain: "api.mc.rowan.wang",     // control API (inside the game zone)
  webDomain: "hamaro.rowan.wang",     // the control website

  alertEmail: "hello@mkwng.com",

  instanceType: "t4g.large",  // 2 vCPU / 8 GB ARM — roomy for Paper + plugins
  dataVolumeGiB: 30,

  // Default VPC in us-west-2 (static for the life of the account; resolved once).
  vpcId: "vpc-c06cfca8",
  publicSubnetId: "subnet-c36cfcab",
  availabilityZone: "us-west-2a",

  // Pinned versions. Update on the yearly maintenance day (see RUNBOOK).
  mcImageRepo: "hamaro/minecraft-server",
  mcImageTag: "2026.7.0",     // itzg/minecraft-server release

  idleMinutes: 15,            // watchdog: sleep after this many empty minutes
  bootGraceMinutes: 10,       // don't count "unreachable" while still booting
  uptimeCapHours: 12,         // reaper: hard cap even if someone camps online
  heartbeatStaleMinutes: 30,  // reaper: wedged if no heartbeat for this long
  dailyStartCap: 20,          // public start button abuse guard

  budgetWarnUsd: 20,
  budgetAlarmUsd: 35,

  // Website bucket + distribution (WebStack, us-east-1) — referenced by the game
  // instance to publish the public terrain map at /map/.
  siteBucketName: "hamaroweb-sitebucket397a1860-vvfauro7hkzh",
  siteDistributionId: "E1BY9KADZ8GIML",

  // uNmINeD CLI (terrain map renderer), linux-arm64. Downloaded once, then
  // mirrored to s3://<data-bucket>/tools/ — delete that object to force refresh.
  // v0.19.60 at time of pinning.
  unminedUrl: "https://unmined.net/download/unmined-cli-linux-arm64-dev/",
};
