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

  // Pinned AL2023 ARM64 AMI. Deliberately NOT ec2.MachineImage.latestAmazonLinux2023() —
  // "latest" re-resolves on every deploy, and when AWS ships a newer base image the
  // ImageId change forces EC2 instance REPLACEMENT (a stateful single-instance server
  // must never do this by surprise). Bump this only on the yearly maintenance day,
  // deliberately, after a backup. See docs/RUNBOOK.md.
  gameAmiId: "ami-0aca5422add5908e3",

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

  // Whitelist bot (whitelist-bot/): the Discord /whitelist service runs on the
  // game host and is fronted by the same CloudFront distribution as the site —
  // /invite/*, /auth/* and /healthz on hamaro.rowan.wang are proxied over HTTPS
  // to https://<botOriginDomain> (Caddy on the host terminates TLS with an
  // ACME cert for that name and reverse-proxies to the bot on localhost:3000).
  // The game host's own A record (mc.rowan.wang, upserted by server/boot.sh) is
  // that name. Set botOriginDomain to "" to disable the proxying entirely.
  botOriginDomain: "mc.rowan.wang",
  // Shared secret CloudFront sends as X-Origin-Verify (the bot rejects proxied
  // routes without it => the origin can't be hit around the CDN). Supplied at
  // deploy time via context, never committed:
  //   cdk deploy HamaroWeb -c botOriginVerifySecret="$(openssl rand -hex 32)"
  // and the same value goes in the bot's ORIGIN_VERIFY_SECRET env. Omit the
  // context to deploy without the header (bot then relies on the SG only).
  botOriginVerifyHeader: "X-Origin-Verify",
  // AWS-managed prefix list "com.amazonaws.global.cloudfront.origin-facing" in
  // us-west-2 — port 443 on the game host is opened ONLY to CloudFront's
  // origin-facing IPs (port 80 stays open to the world for ACME HTTP-01).
  // Verify before deploying:
  //   aws ec2 describe-managed-prefix-lists --region us-west-2 \
  //     --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing
  cloudfrontOriginPrefixListId: "pl-82a045eb",

  // Website bucket + distribution (WebStack, us-east-1) — referenced by the game
  // instance to publish the public terrain map at /map/.
  siteBucketName: "hamaroweb-sitebucket397a1860-vvfauro7hkzh",
  siteDistributionId: "E1BY9KADZ8GIML",

  // uNmINeD CLI (terrain map renderer), linux-arm64. Downloaded once, then
  // mirrored to s3://<data-bucket>/tools/ — delete that object to force refresh.
  // v0.19.60 at time of pinning.
  unminedUrl: "https://unmined.net/download/unmined-cli-linux-arm64-dev/",
};
