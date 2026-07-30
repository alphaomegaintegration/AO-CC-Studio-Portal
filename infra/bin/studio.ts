#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { StudioPortalStack } from '../lib/studio-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' };

const alarmEmail = app.node.tryGetContext('alarmEmail');
if (!alarmEmail) {
  throw new Error('Missing required context: pass -c alarmEmail=you@example.com');
}

new StudioPortalStack(app, 'StudioPortalStack', { env, alarmEmail });
new GithubOidcStack(app, 'StudioPortalGithubOidcStack', { env });
