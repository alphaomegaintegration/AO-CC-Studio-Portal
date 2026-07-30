// Thin re-export so the Lambda's esbuild entry point lives inside the CDK
// project root (required by aws-cdk-lib/aws-lambda-nodejs's NodejsFunction,
// which validates that `entry` is under `projectRoot`). The real
// implementation is `handler.mjs` at the repo root, which is off limits to
// modify for this task; esbuild follows this re-export and bundles the
// actual handler, tools.mjs, router.mjs, and their dependencies (zod)
// exactly as if handler.mjs had been the entry point directly.
export { handler } from '../handler.mjs';
