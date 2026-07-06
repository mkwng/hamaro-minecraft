import { Stack, StackProps, CfnOutput, Duration, aws_iam as iam } from "aws-cdk-lib";
import { Construct } from "constructs";

// Keyless CI/CD: GitHub Actions assumes this role via OIDC federation — no AWS
// secrets stored in GitHub. Only pushes to main of the family repo qualify,
// and the role can do nothing but drive CDK's own bootstrap roles.
const REPO = "mkwng/hamaro-minecraft";

export class CiStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const provider = new iam.OpenIdConnectProvider(this, "GithubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    const role = new iam.Role(this, "DeployRole", {
      roleName: "hamaro-github-deploy",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        StringLike: { "token.actions.githubusercontent.com:sub": `repo:${REPO}:ref:refs/heads/main` },
      }),
    });

    // CDK deploys by assuming its bootstrap roles; that's the entire grant.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
    }));

    new CfnOutput(this, "DeployRoleArn", { value: role.roleArn });
  }
}
