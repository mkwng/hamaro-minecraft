import {
  Stack, StackProps, RemovalPolicy, CfnOutput, Fn,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_certificatemanager as acm,
  aws_route53 as route53,
  aws_route53_targets as r53targets,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { CONFIG as C } from "./config";

// Static control website at https://hamaro.rowan.wang — S3 + CloudFront.
// Lives in us-east-1 because CloudFront certificates must.
export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const zone = new route53.PublicHostedZone(this, "WebZone", {
      zoneName: C.webDomain, // delegated from Gandi (docs/GANDI-DNS.md)
    });

    const cert = new acm.Certificate(this, "WebCert", {
      domainName: C.webDomain,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY, // fully regenerated from web/ at any time
      autoDeleteObjects: true,
    });

    const origin = origins.S3BucketOrigin.withOriginAccessControl(siteBucket);
    // Live-updating map data must never be edge-cached (the game rewrites these
    // between invalidations: player markers each minute, stats each render).
    const noCache = {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    };
    // Whitelist bot (whitelist-bot/): its routes live on the same domain, so
    // CloudFront proxies them to the bot on the game host — over HTTPS end to
    // end (Caddy on the host holds an ACME cert for the origin name and
    // reverse-proxies to the bot on localhost:3000). The OAuth callback carries
    // MS auth codes + invite tokens, so this hop must never be plaintext. A
    // shared-secret custom origin header (context: botOriginVerifySecret) lets
    // the bot refuse anything that didn't come through this distribution.
    // Never cached; query strings must reach the callback intact.
    const botBehaviors: Record<string, cloudfront.BehaviorOptions> = {};
    if (C.botOriginDomain) {
      const verifySecret = this.node.tryGetContext("botOriginVerifySecret") as string | undefined;
      const botOrigin = new origins.HttpOrigin(C.botOriginDomain, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
        customHeaders: verifySecret ? { [C.botOriginVerifyHeader]: verifySecret } : undefined,
      });
      const botBehavior: cloudfront.BehaviorOptions = {
        origin: botOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      };
      botBehaviors["/invite/*"] = botBehavior;
      botBehaviors["/auth/*"] = botBehavior;
      botBehaviors["/healthz"] = botBehavior;
    }

    const dist = new cloudfront.Distribution(this, "SiteDist", {
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        "/map/custom.markers.js": noCache,
        "/map/stats.json": noCache,
        "/map-archive/index.json": noCache,
        ...botBehaviors,
      },
      defaultRootObject: "index.html",
      domainNames: [C.webDomain],
      certificate: cert,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: "Hamaro Minecraft control panel",
    });

    new s3deploy.BucketDeployment(this, "SiteDeploy", {
      sources: [s3deploy.Source.asset("../web/dist")],
      destinationBucket: siteBucket,
      distribution: dist, // invalidates CloudFront on every deploy
      prune: false, // the game instance publishes the terrain map under /map/ — never sweep it
    });

    new route53.ARecord(this, "SiteAlias", {
      zone,
      target: route53.RecordTarget.fromAlias(new r53targets.CloudFrontTarget(dist)),
    });

    new CfnOutput(this, "WebZoneNameServers", {
      value: Fn.join(" ", zone.hostedZoneNameServers!),
      description: `NS records to add at Gandi for ${C.webDomain}`,
    });
    new CfnOutput(this, "SiteUrl", { value: `https://${C.webDomain}` });
  }
}
