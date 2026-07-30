import * as path from 'path';
import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';

export interface StudioStackProps extends StackProps {
  /** Email address that receives the billing alarm. */
  readonly alarmEmail: string;
}

export class StudioPortalStack extends Stack {
  constructor(scope: Construct, id: string, props: StudioStackProps) {
    super(scope, id, props);

    const repoRoot = path.join(__dirname, '..', '..');

    /* ---------- static site bucket: private, CloudFront-only ---------- */
    const bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    /* ---------- API lambda ---------- */
    const api = new NodejsFunction(this, 'ApiFn', {
      // entry is a thin re-export living inside infra/ (the CDK project
      // root) that points at the real handler.mjs at the repo root. See
      // infra/lambda-entry.mjs for why: NodejsFunction requires `entry` to
      // be located underneath `projectRoot`, and handler.mjs must not be
      // modified or moved.
      entry: path.join(__dirname, '..', 'lambda-entry.mjs'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      reservedConcurrentExecutions: 5,
      logGroup: new logs.LogGroup(this, 'ApiFnLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: {
        // tools.mjs derives its own directory from `import.meta.url` (to
        // locate baseline.json), which esbuild leaves empty under CJS
        // output — that would throw at cold start. Bundle to ESM (Lambda
        // nodejs22.x supports .mjs handlers) so import.meta.url survives.
        format: OutputFormat.ESM,
        // baseline.json is read at runtime via fs.readFileSync, so esbuild
        // does not trace it as a dependency — copy it into the bundle.
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir: string, outputDir: string) => [
            // NOTE: `inputDir` here is the CDK project root (infra/), not
            // the repo root, because the bundling entry is a re-export
            // inside infra/ (see infra/lambda-entry.mjs). baseline.json
            // lives at the repo root, so it is addressed via the closed-
            // over `repoRoot`, not `inputDir`.
            `cp ${path.join(repoRoot, 'baseline.json')} ${outputDir}`,
          ],
        },
        externalModules: ['@modelcontextprotocol/sdk'],
      },
    });

    const fnUrl = api.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    /* ---------- CloudFront: S3 default, lambda for /api/* ---------- */
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'CodeIntent Studio portal',
      defaultRootObject: 'studio_product.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });

    /* ---------- ship the SPA ---------- */
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(repoRoot, { exclude: ['*', '.*', '!studio_product.html'] })],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
      cacheControl: [
        s3deploy.CacheControl.setPublic(),
        s3deploy.CacheControl.maxAge(Duration.minutes(5)),
        s3deploy.CacheControl.mustRevalidate(),
      ],
    });

    /* ---------- cost guard ---------- */
    const topic = new sns.Topic(this, 'BillingTopic');
    topic.addSubscription(new subs.EmailSubscription(props.alarmEmail));

    new cw.Alarm(this, 'BillingAlarm', {
      metric: new cw.Metric({
        namespace: 'AWS/Billing',
        metricName: 'EstimatedCharges',
        dimensionsMap: { Currency: 'USD' },
        statistic: 'Maximum',
        period: Duration.hours(6),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.BREACHING,
      alarmDescription: 'AWS account-wide estimated charges (all services, not just Studio Portal) exceeded $5 — expected steady state is $0. Also fires if the metric stops publishing (e.g. "Receive Billing Alerts" is disabled), since a silent metric is itself a signal something is wrong.',
    }).addAlarmAction(new cwActions.SnsAction(topic));

    new CfnOutput(this, 'DistributionUrl', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}
