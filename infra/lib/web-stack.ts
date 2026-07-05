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

    const dist = new cloudfront.Distribution(this, "SiteDist", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
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
