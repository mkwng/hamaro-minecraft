import {
  Stack, StackProps, Duration, RemovalPolicy, CfnOutput, Fn, Size, Tags,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as r53targets,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_apigatewayv2 as apigwv2,
  aws_apigatewayv2_integrations as apigwv2i,
  aws_certificatemanager as acm,
  aws_events as events,
  aws_events_targets as events_targets,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
  aws_cloudwatch as cw,
  aws_cloudwatch_actions as cw_actions,
  aws_budgets as budgets,
  aws_dlm as dlm,
  aws_ses as ses,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { CONFIG as C } from "./config";

export class GameStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const az = C.availabilityZone;

    // ---------- DNS: the zone the kids' clients resolve against ----------
    const gameZone = new route53.PublicHostedZone(this, "GameZone", {
      zoneName: C.gameDomain, // delegated from Gandi via NS records (docs/GANDI-DNS.md)
    });

    // ---------- storage: config + backups bucket, world data volume ----------
    const bucket = new s3.Bucket(this, "DataBucket", {
      bucketName: `hamaro-minecraft-${this.account}`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN, // world backups outlive any stack mistake
      lifecycleRules: [
        {
          id: "backups-tiering", prefix: "backups/",
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(30) },
            { storageClass: s3.StorageClass.DEEP_ARCHIVE, transitionAfter: Duration.days(120) },
          ],
        },
        { id: "tidy-noncurrent", noncurrentVersionExpiration: Duration.days(90) },
        { id: "abort-mpu", abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ],
    });

    // Everything the on-instance scripts need to know. Shipped inside the synced
    // script bundle so config additions reach the instance on its next boot —
    // user-data only writes the bootstrap copy on very first launch.
    const instanceEnv = [
      `export AWS_DEFAULT_REGION=${this.region}`,
      `HAMARO_BUCKET=${bucket.bucketName}`,
      `HAMARO_ZONE_ID=${gameZone.hostedZoneId}`,
      `HAMARO_DOMAIN=${C.gameDomain}`,
      `HAMARO_ECR=${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
      `MC_IMAGE_REPO=${C.mcImageRepo}`,
      `MC_IMAGE_TAG=${C.mcImageTag}`,
      `IDLE_MINUTES=${C.idleMinutes}`,
      `BOOT_GRACE_MINUTES=${C.bootGraceMinutes}`,
      `SITE_BUCKET=${C.siteBucketName}`,
      `SITE_DISTRIBUTION_ID=${C.siteDistributionId}`,
      `UNMINED_URL=${C.unminedUrl}`,
    ];

    // Instance-side scripts, synced to /opt/hamaro on every boot.
    const serverScripts = new s3deploy.BucketDeployment(this, "ServerScripts", {
      sources: [
        s3deploy.Source.asset("../server", { exclude: ["profiles/**"] }),
        s3deploy.Source.data("env", instanceEnv.join("\n") + "\n"),
      ],
      destinationBucket: bucket,
      destinationKeyPrefix: "server/",
      prune: true, // repo is the source of truth for server/ (and only server/)
    });

    const volume = new ec2.Volume(this, "WorldVolume", {
      availabilityZone: az,
      size: Size.gibibytes(C.dataVolumeGiB),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      removalPolicy: RemovalPolicy.RETAIN, // never let CloudFormation delete the worlds
    });
    Tags.of(volume).add("HamaroBackup", "true"); // targeted by the DLM snapshot policy
    Tags.of(volume).add("Name", "hamaro-minecraft-worlds");

    // ---------- private ECR mirror of the pinned server image ----------
    const repo = new ecr.Repository(this, "McRepo", {
      repositoryName: C.mcImageRepo,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ description: "keep last 5 mirrored tags", maxImageCount: 5 }],
    });

    // ---------- the game instance ----------
    const vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", {
      vpcId: C.vpcId,
      availabilityZones: [C.availabilityZone],
      publicSubnetIds: [C.publicSubnetId],
    });

    const sg = new ec2.SecurityGroup(this, "McSg", {
      vpc, description: "Hamaro Minecraft - game port only, no SSH (SSM instead)",
      allowAllOutbound: true,
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(25565), "Minecraft Java");
    if (C.botOriginDomain) {
      // whitelist-bot: CloudFront (WebStack) proxies /invite/*, /auth/*, /healthz
      // over HTTPS to Caddy on this host (which reverse-proxies to the bot on
      // localhost:3000). 443 is open only to CloudFront's origin-facing ranges;
      // 80 is open for ACME HTTP-01 cert issuance/renewal (Caddy redirects the
      // rest). The bot port (3000) and RCON (25575) are never exposed at all.
      sg.addIngressRule(
        ec2.Peer.prefixList(C.cloudfrontOriginPrefixListId),
        ec2.Port.tcp(443),
        "Whitelist bot via Caddy (CloudFront origin-facing only)",
      );
      sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "ACME HTTP-01 for the bot origin cert");
    }

    const role = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    bucket.grantReadWrite(role);
    repo.grantPullPush(role);
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["route53:ChangeResourceRecordSets"],
      resources: [gameZone.hostedZoneArn],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["ssm:GetParameter", "ssm:PutParameter"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/hamaro/*`],
    }));
    // Publish the public terrain map (/map/) and mirrored player avatars
    // (/avatars/) into the website bucket (WebStack).
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      resources: [
        `arn:aws:s3:::${C.siteBucketName}/map/*`,
        `arn:aws:s3:::${C.siteBucketName}/avatars/*`,
        `arn:aws:s3:::${C.siteBucketName}/map-archive/*`,
      ],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:ListBucket"],
      resources: [`arn:aws:s3:::${C.siteBucketName}`],
      conditions: { StringLike: { "s3:prefix": ["map/*", "avatars/*", "map-archive/*"] } },
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["cloudfront:CreateInvalidation"],
      resources: [`arn:aws:cloudfront::${this.account}:distribution/${C.siteDistributionId}`],
    }));

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -euxo pipefail",
      "dnf install -y docker",
      "systemctl enable --now docker",
      // Data volume: format ONLY if it carries no filesystem yet, then mount by label.
      `if ! blkid --label hamaro-data >/dev/null 2>&1; then
        for d in /dev/sdf /dev/xvdf /dev/nvme1n1; do
          if [ -b "$d" ] && ! blkid "$d" >/dev/null 2>&1; then mkfs.xfs -L hamaro-data "$d"; break; fi
        done
      fi`,
      "mkdir -p /srv/minecraft /opt/hamaro /etc/hamaro",
      `grep -q hamaro-data /etc/fstab || echo 'LABEL=hamaro-data /srv/minecraft xfs defaults,nofail 0 2' >> /etc/fstab`,
      "mount -a",
      // Everything the on-instance scripts need to know:
      `cat > /etc/hamaro/env <<EOF
export AWS_DEFAULT_REGION=${this.region}
HAMARO_BUCKET=${bucket.bucketName}
HAMARO_ZONE_ID=${gameZone.hostedZoneId}
HAMARO_DOMAIN=${C.gameDomain}
HAMARO_ECR=${this.account}.dkr.ecr.${this.region}.amazonaws.com
MC_IMAGE_REPO=${C.mcImageRepo}
MC_IMAGE_TAG=${C.mcImageTag}
IDLE_MINUTES=${C.idleMinutes}
BOOT_GRACE_MINUTES=${C.bootGraceMinutes}
EOF`,
      // Self-updating scripts: synced from S3 on every boot (edit repo -> deploy -> reboot).
      `cat > /usr/local/bin/hamaro-sync <<'EOF'
#!/bin/bash
set -e
source /etc/hamaro/env
aws s3 sync "s3://\${HAMARO_BUCKET}/server/" /opt/hamaro/ --delete
chmod +x /opt/hamaro/*.sh
cp /opt/hamaro/systemd/* /etc/systemd/system/
systemctl daemon-reload
EOF`,
      "chmod +x /usr/local/bin/hamaro-sync",
      "/usr/local/bin/hamaro-sync",
      "systemctl enable hamaro-boot.service hamaro-watchdog.timer hamaro-backup.timer",
      "systemctl start hamaro-boot.service hamaro-watchdog.timer hamaro-backup.timer",
    );

    const instance = new ec2.Instance(this, "McInstance", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(C.instanceType),
      machineImage: ec2.MachineImage.genericLinux({ [C.gameRegion]: C.gameAmiId }),
      securityGroup: sg,
      role,
      userData,
      associatePublicIpAddress: true,
      blockDevices: [{ deviceName: "/dev/xvda", volume: ec2.BlockDeviceVolume.ebs(16, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true }) }],
      requireImdsv2: true,
    });
    instance.node.addDependency(serverScripts); // first boot must find its scripts in S3
    Tags.of(instance).add("Name", "hamaro-minecraft");

    const cfnInstance = instance.node.defaultChild as ec2.CfnInstance;
    cfnInstance.instanceInitiatedShutdownBehavior = "stop"; // `shutdown -h` stops (not terminates)
    cfnInstance.disableApiTermination = true;

    new ec2.CfnVolumeAttachment(this, "WorldVolumeAttachment", {
      device: "/dev/sdf",
      instanceId: instance.instanceId,
      volumeId: volume.volumeId,
    });

    // ---------- alerts ----------
    const alerts = new sns.Topic(this, "Alerts", { displayName: "Hamaro Minecraft alerts" });
    alerts.addSubscription(new subs.EmailSubscription(C.alertEmail));

    // ---------- email (magic-link login + join-request notifications) ----------
    // Domain identity with automatic DKIM records in our own zone; sender is
    // server@mc.rowan.wang. NOTE: account starts in SES sandbox — production
    // access is requested at deploy time (see RUNBOOK).
    new ses.EmailIdentity(this, "SesIdentity", {
      identity: ses.Identity.publicHostedZone(gameZone),
    });
    const senderEmail = `server@${C.gameDomain}`;

    // ---------- control API ----------
    const apiLogs = new logs.LogGroup(this, "ApiLogs", { retention: logs.RetentionDays.ONE_MONTH });
    const apiFn = new lambda.Function(this, "ApiFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "api.handler",
      code: lambda.Code.fromAsset("../control-api"),
      timeout: Duration.seconds(29),
      memorySize: 256,
      logGroup: apiLogs,
      environment: {
        INSTANCE_ID: instance.instanceId,
        BUCKET: bucket.bucketName,
        GAME_DOMAIN: C.gameDomain,
        ALLOWED_ORIGIN: `https://${C.webDomain}`,
        DAILY_START_CAP: String(C.dailyStartCap),
        SENDER_EMAIL: senderEmail,
      },
    });
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ses:SendEmail"],
      resources: ["*"],
      conditions: { StringEquals: { "ses:FromAddress": senderEmail } },
    }));
    bucket.grantReadWrite(apiFn);
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ec2:DescribeInstances"], resources: ["*"],
    }));
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ec2:StartInstances"],
      resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/${instance.instanceId}`],
    }));
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ssm:GetParameter", "ssm:PutParameter"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/hamaro/*`],
    }));
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ssm:SendCommand"],
      resources: [
        `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
        `arn:aws:ec2:${this.region}:${this.account}:instance/${instance.instanceId}`,
      ],
    }));
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ssm:GetCommandInvocation"], resources: ["*"],
    }));

    const apiCert = new acm.Certificate(this, "ApiCert", {
      domainName: C.apiDomain,
      validation: acm.CertificateValidation.fromDns(gameZone),
    });
    const apiDomain = new apigwv2.DomainName(this, "ApiDomain", {
      domainName: C.apiDomain,
      certificate: apiCert,
    });
    const httpApi = new apigwv2.HttpApi(this, "ControlApi", {
      defaultIntegration: new apigwv2i.HttpLambdaIntegration("ApiIntegration", apiFn),
      defaultDomainMapping: { domainName: apiDomain },
      corsPreflight: {
        allowOrigins: [`https://${C.webDomain}`],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.PUT, apigwv2.CorsHttpMethod.DELETE],
        allowHeaders: ["authorization", "content-type"],
        maxAge: Duration.hours(1),
      },
    });
    const stage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 10, throttlingBurstLimit: 20 };

    new route53.ARecord(this, "ApiAlias", {
      zone: gameZone,
      recordName: "api", // api.mc.rowan.wang
      target: route53.RecordTarget.fromAlias(
        new r53targets.ApiGatewayv2DomainProperties(apiDomain.regionalDomainName, apiDomain.regionalHostedZoneId)),
    });

    // Failed-login spike -> email (the Lambda logs "AUTH_FAIL" on bad passwords).
    const authFailMetric = new logs.MetricFilter(this, "AuthFailFilter", {
      logGroup: apiLogs,
      filterPattern: logs.FilterPattern.literal("AUTH_FAIL"),
      metricNamespace: "Hamaro",
      metricName: "AuthFailures",
      metricValue: "1",
    });
    new cw.Alarm(this, "AuthFailAlarm", {
      metric: authFailMetric.metric({ statistic: "sum", period: Duration.minutes(15) }),
      threshold: 10,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      alarmDescription: "Someone is guessing the Hamaro admin password",
    }).addAlarmAction(new cw_actions.SnsAction(alerts));

    // ---------- reaper: independent kill switch ----------
    const reaperFn = new lambda.Function(this, "ReaperFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "reaper.handler",
      code: lambda.Code.fromAsset("../control-api"),
      timeout: Duration.seconds(60),
      logGroup: new logs.LogGroup(this, "ReaperLogs", { retention: logs.RetentionDays.ONE_MONTH }),
      environment: {
        INSTANCE_ID: instance.instanceId,
        SNS_TOPIC_ARN: alerts.topicArn,
        UPTIME_CAP_HOURS: String(C.uptimeCapHours),
        HEARTBEAT_STALE_MINUTES: String(C.heartbeatStaleMinutes),
      },
    });
    reaperFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["ec2:DescribeInstances"], resources: ["*"] }));
    reaperFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ec2:StopInstances"],
      resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/${instance.instanceId}`],
    }));
    reaperFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/hamaro/*`],
    }));
    alerts.grantPublish(reaperFn);
    new events.Rule(this, "ReaperSchedule", {
      schedule: events.Schedule.rate(Duration.minutes(15)),
      targets: [new events_targets.LambdaFunction(reaperFn)],
    });

    // ---------- scheduler: recurring recipes (daily gifts etc.) ----------
    const schedulerFn = new lambda.Function(this, "SchedulerFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "scheduler.handler",
      code: lambda.Code.fromAsset("../control-api"),
      timeout: Duration.seconds(60),
      logGroup: new logs.LogGroup(this, "SchedulerLogs", { retention: logs.RetentionDays.ONE_MONTH }),
      environment: { INSTANCE_ID: instance.instanceId, BUCKET: bucket.bucketName },
    });
    bucket.grantReadWrite(schedulerFn);
    schedulerFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["ec2:DescribeInstances"], resources: ["*"] }));
    schedulerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ssm:SendCommand"],
      resources: [
        `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
        `arn:aws:ec2:${this.region}:${this.account}:instance/${instance.instanceId}`,
      ],
    }));
    new events.Rule(this, "SchedulerSchedule", {
      schedule: events.Schedule.rate(Duration.minutes(15)),
      targets: [new events_targets.LambdaFunction(schedulerFn)],
    });

    // ---------- smart maintenance: nightly, off-hours, instance-must-be-stopped ----------
    // Auto-applies only same-family Minecraft/Paper patch releases (low risk),
    // with a mandatory backup + health check + auto-rollback on failure. A new
    // version FAMILY (new content, e.g. a new biome) and itzg image updates are
    // notify-only — never silently applied. The EC2 AMI is never touched here;
    // see the CI guard for that. 11:00 UTC ≈ 3-4am Pacific, safely asleep.
    const maintenanceFn = new lambda.Function(this, "MaintenanceFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "maintenance.handler",
      code: lambda.Code.fromAsset("../control-api"),
      timeout: Duration.minutes(10),
      logGroup: new logs.LogGroup(this, "MaintenanceLogs", { retention: logs.RetentionDays.THREE_MONTHS }),
      environment: {
        INSTANCE_ID: instance.instanceId,
        BUCKET: bucket.bucketName,
        SENDER_EMAIL: senderEmail,
        MC_IMAGE_TAG: C.mcImageTag,
      },
    });
    bucket.grantReadWrite(maintenanceFn);
    maintenanceFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["ec2:DescribeInstances"], resources: ["*"] }));
    maintenanceFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/hamaro/*`],
    }));
    maintenanceFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ssm:SendCommand"],
      resources: [
        `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
        `arn:aws:ec2:${this.region}:${this.account}:instance/${instance.instanceId}`,
      ],
    }));
    maintenanceFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetCommandInvocation"], resources: ["*"] }));
    maintenanceFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ses:SendEmail"], resources: ["*"],
      conditions: { StringEquals: { "ses:FromAddress": senderEmail } },
    }));
    new events.Rule(this, "MaintenanceSchedule", {
      schedule: events.Schedule.cron({ minute: "0", hour: "11" }),
      targets: [new events_targets.LambdaFunction(maintenanceFn)],
    });

    // ---------- weekly EBS snapshots (belt-and-braces behind S3 backups) ----------
    const dlmRole = new iam.Role(this, "DlmRole", {
      assumedBy: new iam.ServicePrincipal("dlm.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSDataLifecycleManagerServiceRole")],
    });
    new dlm.CfnLifecyclePolicy(this, "WeeklySnapshots", {
      description: "Hamaro weekly world-volume snapshots keep 4", // DLM allows only [0-9A-Za-z _-]
      state: "ENABLED",
      executionRoleArn: dlmRole.roleArn,
      policyDetails: {
        resourceTypes: ["VOLUME"],
        targetTags: [{ key: "HamaroBackup", value: "true" }],
        schedules: [{
          name: "weekly",
          createRule: { cronExpression: "cron(0 10 ? * SUN *)" },
          retainRule: { count: 4 },
          copyTags: true,
        }],
      },
    });

    // ---------- cost guardrails ----------
    for (const [name, amount] of [["BudgetWarn", C.budgetWarnUsd], ["BudgetAlarm", C.budgetAlarmUsd]] as const) {
      new budgets.CfnBudget(this, name, {
        budget: {
          budgetName: `hamaro-${String(amount)}usd`,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: Number(amount), unit: "USD" },
        },
        notificationsWithSubscribers: [{
          notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 100 },
          subscribers: [{ subscriptionType: "EMAIL", address: C.alertEmail }],
        }],
      });
    }

    // ---------- outputs ----------
    new CfnOutput(this, "GameZoneNameServers", {
      value: Fn.join(" ", gameZone.hostedZoneNameServers!),
      description: `NS records to add at Gandi for ${C.gameDomain}`,
    });
    new CfnOutput(this, "InstanceId", { value: instance.instanceId });
    new CfnOutput(this, "BucketName", { value: bucket.bucketName });
    new CfnOutput(this, "ApiUrl", { value: `https://${C.apiDomain}` });
  }
}
