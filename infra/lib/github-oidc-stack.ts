import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const provider = new iam.OpenIdConnectProvider(this, 'GithubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const role = new iam.Role(this, 'DeployRole', {
      roleName: 'studio-portal-github-deploy',
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        // StringEquals (not StringLike) for both conditions: `sub` is now a
        // single fully-qualified value with no wildcard, so an exact-match
        // operator is the tighter and clearer choice. This restricts the
        // trust to pushes/dispatches against `main` only — the deploy
        // workflow only runs on `main` and `workflow_dispatch`, so nothing
        // legitimate is broken, and a branch push can no longer assume this
        // role (which can in turn assume the AdministratorAccess-by-default
        // CDK bootstrap exec role).
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub':
            'repo:alphaomegaintegration/AO-CC-Studio-Portal:ref:refs/heads/main',
        },
      }),
      description: 'Deploys the Studio Portal from GitHub Actions',
    });

    // CDK deploys assume the bootstrap roles; permission to do so is what
    // the workflow actually needs.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
    }));

    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
  }
}
