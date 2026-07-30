# Studio Portal — AWS Hosting Design

Date: 2026-07-30
Status: approved design, pending implementation plan
Scope: `AO-CC-Studio-Portal` only. The Discovery Portal is a separate spec.

---

## 1. Goal

Host the CodeIntent Studio product build at a public HTTPS URL, at zero recurring cost,
with the **Ask CodeIntent** feature backed by a live API rather than falling back to
built-in sample answers.

### Success criteria

1. `studio_product.html` is reachable over HTTPS without running anything locally.
2. The Ask CodeIntent status strip reads `MCP bridge: connected` on the hosted site.
3. All eight scripted demo questions from `README_PRODUCT_BUILD.md` return live answers
   routed through the same `baseline.json` the MCP server uses.
4. The stdio MCP entrypoint (`server.mjs`) continues to work unchanged for the Claude Code
   and VS Code demos in `demo-workspace/`.
5. Steady-state AWS cost is $0.00/month.

### Non-goals

- Custom domain. Deferred; see §9.
- Authentication or an access gate. The audience is AO staff presenting live.
- AWS WAF. $5/month minimum would exceed the entire rest of the bill by an order of
  magnitude to protect a read-only endpoint over a sample dataset.
- Any change to the substance of the five tools' output. This is a pure extraction.

### Context that drove the design

The portal is **presented live by AO staff** following the ~15-minute run of show in
`docs/ao-client-demo-script.md`. It is not a self-serve link sent to prospects and not a
public marketing surface. This is why there is no auth gate, no WAF, and why reserved
concurrency of 5 is generous rather than tight.

---

## 2. Architecture

One CloudFront distribution, two origins.

```
              CloudFront (dXXXXXXXX.cloudfront.net, default certificate)
                              |
        +---------------------+----------------------+
        | default behavior                            | /api/* behavior
        | GET/HEAD, compress: true, cached            | GET+POST, CACHING_DISABLED
        v                                             v
   S3 bucket (private, OAC)                  Lambda Function URL (OAC, AWS_IAM)
   studio_product.html -> /                  nodejs22.x, arm64, 256 MB, 10 s timeout
                                             reservedConcurrentExecutions: 5
                                             log retention: 7 days
```

Region: **us-east-1** for everything. Required if a CloudFront ACM certificate is added
later (§9); keeping the whole stack there avoids a second-region deployment.

### 2.1 Rejected alternatives, and why

**Lambda-only, no S3 or CloudFront.** `bridge.mjs` already serves both the HTML and the
API from one Node process, and a Function URL provides HTTPS on its own, so the whole
bridge could be lifted into a single Lambda. Rejected on two grounds: it would push an
858 KB uncompressed HTML payload through a Lambda invoke on every page load (CloudFront's
Brotli brings it to roughly 120–160 KB and then caches it at the edge), and more
importantly CloudFront is the mechanism that permits `authType: AWS_IAM` on the Function
URL. Without CloudFront the only option is `authType: NONE` — a public, unmetered
endpoint.

**API Gateway HTTP API instead of a Function URL.** HTTP API's free tier is 1M requests
for 12 months only; Lambda's is 1M/month in perpetuity. CloudFront already supplies TLS
and path routing, so API Gateway would introduce a cost after year one in exchange for
nothing.

**Shared-secret header instead of OAC + `AWS_IAM`.** Equivalent protection, but adds a
secret that must be rotated and that would have to be embedded in the SPA.

### 2.2 Cost

| Service | Allowance | Usage |
|---|---|---|
| CloudFront | 1 TB egress + 10M requests/month, perpetual | negligible |
| Lambda | 1M requests + 400,000 GB-s/month, perpetual | hundreds of requests |
| S3 | 5 GB (first 12 months), then ~$0.023/GB-month | ~0.9 MB |
| Route 53 | n/a — no hosted zone | $0.00 |

**Expected: $0.00/month.**

---

## 3. Module boundaries

### 3.1 The constraint

`server.mjs:349-351` constructs a `StdioServerTransport` and connects it **at module top
level**. A Lambda handler therefore cannot import `server.mjs` — the import alone would
start a stdio server. The tool logic must move somewhere both can reach.

### 3.2 Target structure

```
baseline.json
   |
   +-- tools.mjs     NEW. Tool registry + all helpers.
   +-- router.mjs    NEW. routeQuestion(), lifted from bridge.mjs:66.
   |
   +-- server.mjs    stdio MCP entrypoint. Thin shell over TOOLS.
   +-- bridge.mjs    local dev server on :8787. In-process, no subprocess.
   +-- handler.mjs   NEW. Lambda Function URL handler.
```

| File | Before | After |
|---|---|---|
| `tools.mjs` | — | ~250 lines (moved verbatim) |
| `router.mjs` | — | ~55 lines (moved verbatim) |
| `server.mjs` | ~352 lines | ~60 lines |
| `bridge.mjs` | ~180 lines | ~120 lines |
| `handler.mjs` | — | ~80 lines |

### 3.3 The tool registry

Tool functions return **plain strings**, not the MCP `{content:[{type:"text"}]}` envelope
produced by `server.mjs:35`'s `text()` helper. Each transport wraps as it needs; the
Lambda has nothing to do with MCP and must not have to unwrap an MCP structure.

```js
// tools.mjs
export const TOOLS = {
  get_baseline_summary: { title, description, inputSchema: {},    run: async ()     => string },
  explain_rule:         { title, description, inputSchema: {...}, run: async (args) => string },
  trace_lineage:        { title, description, inputSchema: {...}, run: async (args) => string },
  check_change:         { title, description, inputSchema: {...}, run: async (args) => string },
  impact_analysis:      { title, description, inputSchema: {...}, run: async (args) => string },
};
```

Helpers moving into `tools.mjs` with their bodies unchanged: `norm`, `findRuleById`,
`findRuleByText`, `bindingsForFile`, `ruleBlock`, `detectTouched`, `diffHitsGuard`,
`alterationCues`, `FOOTER`.

Precisely one thing about them changes, and only at the seam: today each tool body ends
by calling `text(...)`, which both appends `FOOTER` and wraps the result in the MCP
envelope. Those two responsibilities split — `FOOTER` appending moves into `tools.mjs`
(see below), MCP wrapping stays in `server.mjs`. The composed output string is therefore
identical; only where the concatenation happens moves.

**zod schemas move out of the `registerTool` calls and into the registry entries.**
`server.mjs` gets validation for free from `registerTool`, but `handler.mjs` receives
arbitrary JSON from a browser and needs the same validation. Colocating the schema with
the tool gives both surfaces one source of truth, and makes the `/api/tool` allowlist a
non-issue — it is exactly `Object.keys(TOOLS)`.

**`FOOTER` is appended inside `tools.mjs`, not in the transports.** Today the browser sees
the baseline attribution footer only as a side effect of the answer travelling through
MCP's `text()`. Leaving `FOOTER` in `server.mjs` would silently drop baseline provenance
from every answer on the hosted site — unacceptable for a product whose central claim is
evidence attribution. Appending inside the tools guarantees all three transports emit
identical text.

### 3.4 Dependency consequences

- `zod` is bundled into the Lambda. Small; acceptable.
- `@modelcontextprotocol/sdk` is **not** bundled. Nothing on the Lambda path imports it.

---

## 4. API contract

Response shapes are identical to today's `bridge.mjs`, so the SPA's fetch calls
(`studio_product.html:1914` and `:1931`) need no modification.

```
GET  /api/health
  -> { ok, bridge, baseline, mode }

POST /api/ask   { question }
  -> routeQuestion(question) -> { tool, args }
  -> TOOLS[tool].run(args)
  -> { question, routed, tool, text }

POST /api/tool  { tool, args }
  -> TOOLS[tool].inputSchema.parse(args)
  -> TOOLS[tool].run(args)
  -> { tool, text }
```

### 4.1 Errors

| Condition | Status | Body |
|---|---|---|
| Body > 32 KB | 413 | `{ error: "Request too large" }` |
| Missing/empty `question` | 400 | `{ error: "Missing question" }` |
| zod validation failure | 400 | `{ error: <zod message> }` |
| Unknown tool name | 404 | `{ error: "Unknown tool" }` |
| Unexpected throw | 500 | `{ error: "Internal error" }` |

The 500 row is a deliberate departure from `bridge.mjs:172`, which returns `err.message`
directly to the client. Acceptable on localhost, leaky on the internet. The real error
goes to CloudWatch.

The 32 KB cap exists specifically because `check_change` accepts a free-form `diff`
string — the only unbounded input path in the API.

### 4.2 Hardening carried over from the localhost bridge

1. **Drop CORS entirely.** `bridge.mjs:35` sets `access-control-allow-origin: *`.
   CloudFront serves the SPA and the API from the same origin, so the Lambda needs no CORS
   headers at all. Remove rather than port.
2. **Bound the request body** (see 32 KB cap above); `readBody()` currently accumulates
   chunks without limit.
3. **Allowlist `/api/tool`** via `Object.keys(TOOLS)`.

### 4.3 Degradation

If the Lambda is unavailable, `checkMcpBridge()` renders `MCP bridge: offline` and
`askCodeIntent()` falls back to the built-in `QA` array. A presented demo degrades to the
scripted answers rather than breaking. **This existing behavior must be preserved.**

`checkMcpBridge()` fires on page load, which warms the Lambda container before the
presenter reaches the Ask section — cold start does not land on a live demo moment.

### 4.4 Required SPA change

`studio_product.html:1938` renders, on API failure:

> `MCP bridge unavailable. Start the local bridge with: npm run studio`

These instructions are meaningless to a client watching a hosted demo. Replace with copy
along the lines of:

> `CodeIntent baseline temporarily unreachable — built-in examples remain available.`

This is the only change to `studio_product.html`.

---

## 5. Testing

The repo currently has no assertions: `test.mjs` spawns the server and prints every
tool's output for human inspection. It is retained as a demo sanity check, but it cannot
detect a behavior change introduced by the refactor.

### 5.1 Golden-output strategy

Because §3 is a **pure extraction** with no intended logic change, the strongest available
guarantee is byte-identical output:

1. Before modifying any file, run all five tools through the current `server.mjs` and
   capture exact output strings to `test/golden/*.txt`.
2. Perform the refactor.
3. Assert `tools.mjs` produces byte-identical output.

The captured golden string is the **full text including `FOOTER`** — that is, the `text`
field of the MCP response, not the tool body's return value before concatenation. This is
what makes the check meaningful across the seam described in §3.3: pre-refactor the footer
is appended by `text()`, post-refactor by `tools.mjs`, and the golden comparison is what
proves that relocation lost nothing.

`check_change` is captured twice — once for the fee-waiver case and once for the
dormant-guard case — since the two demo moments exercise different branches.

Any diff is by definition a defect. This catches exactly the failures a pure move is prone
to: a dropped `FOOTER`, a lost newline in `ruleBlock`, a reindented `alterationCues` regex.

### 5.2 Layers

Uses Node's built-in `node:test`. No new dependencies.

| Layer | Coverage |
|---|---|
| `tools.test.mjs` | Golden outputs for all 5 tools. Demo moment 1: dormant-guard removal returns **"NOT BEHAVIOR-PRESERVING"**. Demo moment 2: fee-waiver does not. `explain_rule` with an unbound query returns the "does not guess" response. |
| `router.test.mjs` | All 8 scripted README questions map to their expected tool. |
| `handler.test.mjs` | Function URL event shapes in; correct status codes out, covering every row of §4.1. |
| `test.mjs` | **Unchanged.** Still spawns `server.mjs` over stdio. Passing proves the Claude Code / VS Code MCP path survived. |
| post-deploy smoke | `curl` the CloudFront URL for `/api/health`, then one `/api/ask`, asserting a bound rule returns. |

### 5.3 Why `router.test.mjs` matters most

`routeQuestion` is a regex table, and an unmatched question falls through to `explain_rule`
rather than erroring. A broken regex therefore **fails soft** — it returns a plausible
"no rule matches" response instead of throwing. One of the eight demo questions would
quietly stop working, and the discovery would happen live in front of a client. Pinning
all eight is cheap insurance against an expensive failure.

---

## 6. Repository layout

```
AO-CC-Studio-Portal/
├── tools.mjs  router.mjs  handler.mjs      new
├── server.mjs  bridge.mjs                  refactored
├── test/golden/*.txt
├── tools.test.mjs  router.test.mjs  handler.test.mjs
├── test.mjs                                unchanged
├── infra/                                  new — CDK v2 (TypeScript)
│   ├── bin/studio.ts
│   ├── lib/studio-stack.ts
│   ├── cdk.json
│   └── package.json
└── .github/workflows/deploy.yml            new
```

`handler.mjs` bundles via CDK's `NodejsFunction` (esbuild), including `zod` and excluding
`@modelcontextprotocol/sdk`. Docker is available locally as the bundling fallback.

---

## 7. Deployment

Triggered on push to `main` and by manual dispatch.

```
npm ci
node --test                 # golden + router + handler
npm run test:mcp            # stdio MCP path still alive
cdk deploy                  # Lambda + S3 + CloudFront
aws s3 cp studio_product.html s3://<bucket>/studio_product.html \
    --cache-control "public, max-age=300, must-revalidate"
aws cloudfront create-invalidation --paths "/*"
curl smoke: /api/health, /api/ask
```

GitHub Actions authenticates by **OIDC role assumption**, not stored access keys. The
trust policy scopes to `repo:alphaomegaintegration/AO-CC-Studio-Portal:*`.

### 7.1 Cost guards, enforced in CDK

```
logs.RetentionDays.ONE_WEEK           # unbounded log retention is the usual way
                                      # a "free" demo starts costing money
reservedConcurrentExecutions: 5
PriceClass.PRICE_CLASS_100            # NA + EU edges
CloudWatch billing alarm at $5 -> SNS email
```

`PRICE_CLASS_100` is about predictability rather than cost, since egress is inside the
free tier regardless. Drop it if APAC edge performance is ever needed.

### 7.2 Caching

| Path | Policy |
|---|---|
| `/api/*` | `CACHING_DISABLED` + `AllViewerExceptHostHeader` origin request policy |
| everything else | cached, `compress: true` |

`/api/health` is deliberately uncached: caching it would mask a genuinely offline backend
from the status strip.

---

## 8. Prerequisites

None of these are code, and all three must exist before the first deploy.

1. AWS credentials configured locally (`aws configure`, or `aws configure sso`).
   AWS CLI v2.36.11 is installed at `~/.local/bin/aws`.
2. `cdk bootstrap` run once against the target account.
3. The GitHub OIDC provider and deploy role, delivered as a small CDK stack deployed
   manually once.

---

## 9. Deferred decisions

These are recorded with explicit defaults so they do not block implementation.

**Custom domain — deferred.** The site ships on its generated `*.cloudfront.net` URL.
Attaching `studio.<domain>` later requires a Route 53 hosted zone ($0.50/month), an ACM
certificate in us-east-1, and adding an alias plus `domainNames` to the existing
distribution. No rework of anything in this spec.

**Repository visibility — default: stays public.** `AO-CC-Studio-Portal` is a public
repo. Nothing in it is sensitive; `baseline.json` is explicitly labelled an illustrative
sample for a fictional "First National". But a hosted client-demo surface combined with a
public repo means anyone can read `routeQuestion` and see which eight questions map to
which canned answers. This is a positioning judgment for AO, not a security defect. The
default is to leave it public and accept that.
