# Studio Portal AWS Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host `studio_product.html` at a public HTTPS URL with a live Ask CodeIntent API, at $0.00/month recurring cost.

**Architecture:** Extract the five MCP tool implementations out of `server.mjs` into a shared `tools.mjs` registry so the stdio MCP server, the local dev bridge, and a new AWS Lambda handler all call one copy. Serve the static SPA from a private S3 bucket and the API from a Lambda Function URL, both behind a single CloudFront distribution using Origin Access Control.

**Tech Stack:** Node.js 22 (ESM), zod, `@modelcontextprotocol/sdk` (stdio path only), `node:test`, AWS CDK v2 (TypeScript), GitHub Actions with OIDC.

**Spec:** `docs/superpowers/specs/2026-07-30-studio-portal-aws-hosting-design.md`

## Global Constraints

- Node.js 22 or newer. Lambda runtime is `nodejs22.x` on `arm64`.
- `aws-cdk-lib` `^2.170.0` minimum — `FunctionUrlOrigin.withOriginAccessControl()` does not exist below this.
- All AWS resources deploy to **us-east-1**.
- Tool functions return **plain strings**, never the MCP `{content:[{type:"text"}]}` envelope.
- `FOOTER` is appended inside `tools.mjs`, never in a transport.
- The Lambda bundle must include `zod` and must **exclude** `@modelcontextprotocol/sdk`.
- The Lambda emits **no CORS headers**. SPA and API are same-origin via CloudFront.
- Tasks 1–2 must not change any tool's output text by even one byte. Golden tests enforce this.
- `server.mjs` keeps its stdio entrypoint and its externally-observable behavior throughout. `npm run test:mcp` must pass at the end of every task.
- Never commit AWS credentials. Deploys authenticate by OIDC role assumption.

---

### Task 1: Capture golden outputs from the current implementation

Establishes the safety net. **This task must complete before any file is modified** — the fixtures it captures are only meaningful if taken from the pre-refactor code.

**Files:**
- Create: `fixtures/cases.mjs`
- Create: `scripts/capture-golden.mjs`
- Create: `fixtures/golden/*.txt` (generated, committed)
- Modify: `package.json` (add scripts)

**Interfaces:**
- Consumes: nothing.
- Produces: `CASES` — an array of `{ name: string, tool: string, args: object }` imported by Task 2's tests. `fixtures/golden/<name>.txt` holds the exact `text` field of each MCP response, footer included.

> **Why not a `test/` directory:** Node's test runner, invoked as bare `node --test`, treats
> **every `.mjs` file inside a directory named `test/` as a test file** and executes it. A
> capture script living there would re-run on every `npm test` and silently overwrite the
> golden fixtures with post-refactor output — destroying the exact evidence the fixtures
> exist to provide. Keeping the script in `scripts/` and the data in `fixtures/` means
> `node --test` only ever picks up the root `*.test.mjs` files.

- [ ] **Step 1: Create the shared case list**

Both the capture script and the later tests import this, so the two can never drift apart.

Create `fixtures/cases.mjs`:

```js
/* Shared fixture list: used by scripts/capture-golden.mjs to record golden output
   and by tools.test.mjs to assert the refactor preserved it byte for byte.
   Cases are chosen to cover every branch in the five tools. */

export const DORMANT_GUARD_DIFF = `--- a/src/main/java/com/firstnational/deposits/InterestAccrualService.java
+++ b/src/main/java/com/firstnational/deposits/InterestAccrualService.java
@@ -41,10 +41,6 @@
     BigDecimal accrueDaily(Account account, MoneyRate dailyRate) {
         BigDecimal principal = account.collectedBalance();
-        if (account.status() == AccountStatus.DORMANT) {
-            audit.suppressed(account, Reason.DORMANT);
-            return BigDecimal.ZERO;
-        }
         return principal.multiply(dailyRate.value())`;

export const CASES = [
  { name: "baseline-summary", tool: "get_baseline_summary", args: {} },

  // explain_rule: match-by-text, the R-INF-118 warning branch, and the unbound branch
  { name: "explain-dormant", tool: "explain_rule", args: { query: "why don't dormant accounts accrue interest" } },
  { name: "explain-inferred", tool: "explain_rule", args: { rule_id: "R-INF-118" } },
  { name: "explain-unbound", tool: "explain_rule", args: { query: "zzzz nothing matches this query" } },

  // trace_lineage: line-in-range branch and the orphaned-file branch
  { name: "trace-line-45", tool: "trace_lineage", args: { file: "InterestAccrualService.java", line: 45 } },
  { name: "trace-orphan", tool: "trace_lineage", args: { file: "OLD-RPT-9.CBL" } },

  // check_change: the two demo moments — additive vs. behavior-breaking
  {
    name: "check-fee-waiver",
    tool: "check_change",
    args: {
      description: "Add a fee-waiver flag to the account model and statement rendering",
      files: ["Account.java", "StatementRenderingService.java"],
    },
  },
  {
    name: "check-dormant-guard",
    tool: "check_change",
    args: {
      description: "Remove the dormant status guard so all accounts accrue",
      files: ["InterestAccrualService.java"],
      diff: DORMANT_GUARD_DIFF,
    },
  },

  { name: "impact-ctrl-006", tool: "impact_analysis", args: { rule_id: "R-CTRL-006" } },
];
```

- [ ] **Step 2: Write the capture script**

It talks to the *current* `server.mjs` over stdio, exactly as `test.mjs` does, so it records true pre-refactor output.

Create `scripts/capture-golden.mjs`:

```js
/* Records the current output of every case in fixtures/cases.mjs to
   fixtures/golden/. Run ONCE before the tools.mjs extraction. Re-running
   after the refactor would defeat the purpose — it would overwrite the
   evidence with the very output it is supposed to be checking. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "../fixtures/cases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "fixtures", "golden");
mkdirSync(OUT, { recursive: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "server.mjs")],
});
const client = new Client({ name: "golden-capture", version: "1.0.0" });
await client.connect(transport);

for (const c of CASES) {
  const res = await client.callTool({ name: c.tool, arguments: c.args });
  const text = (res.content || []).map((x) => x.text || "").join("\n");
  if (!text) throw new Error(`empty output for case ${c.name} — refusing to write an empty golden file`);
  writeFileSync(join(OUT, `${c.name}.txt`), text, "utf8");
  console.log(`captured ${c.name}.txt (${text.length} bytes)`);
}

await client.close();
console.log(`\n${CASES.length} golden files written to fixtures/golden/`);
```

- [ ] **Step 3: Add the scripts**

In `package.json`, add to `"scripts"`:

```json
"capture:golden": "node scripts/capture-golden.mjs",
"test": "node --test"
```

- [ ] **Step 4: Run the capture**

Run: `npm install && npm run capture:golden`
Expected: nine lines of `captured <name>.txt (N bytes)`, then `9 golden files written`. Every byte count must be non-zero.

- [ ] **Step 5: Eyeball two fixtures before trusting them**

Run: `grep -c "NOT BEHAVIOR-PRESERVING" fixtures/golden/check-dormant-guard.txt`
Expected: `1`

Run: `grep -c "NOT BEHAVIOR-PRESERVING" fixtures/golden/check-fee-waiver.txt`
Expected: `0`

Run: `tail -3 fixtures/golden/baseline-summary.txt`
Expected: the `Baseline: CodeIntent 2026.06.r1 · First National (illustrative sample)` footer.

If the dormant-guard fixture does *not* contain `NOT BEHAVIOR-PRESERVING`, stop — the demo's key moment is already broken on `main` and that is a bug to fix before refactoring around it.

- [ ] **Step 6: Commit**

```bash
git add fixtures/ scripts/capture-golden.mjs package.json
git commit -m "test: capture golden tool outputs before refactor

Records the exact output of all five tools across nine branch-covering
cases, taken from the current server.mjs over stdio. These fixtures are
the correctness criterion for the tools.mjs extraction."
```

---

### Task 2: Extract `tools.mjs` and reduce `server.mjs`

**Files:**
- Create: `tools.mjs`
- Create: `tools.test.mjs`
- Read (do not yet modify): `server.mjs:28-130` (helpers), `server.mjs:136-345` (tool bodies)

**Interfaces:**
- Consumes: `CASES` from `fixtures/cases.mjs`; `fixtures/golden/*.txt`.
- Produces: `TOOLS` — `Record<string, { title: string, description: string, inputSchema: object, run: (args: object) => Promise<string> }>`. Keys are the five MCP tool names. `run` returns a plain string **with `FOOTER` already appended**. Also exports `B` (the parsed baseline) for `bridge.mjs`'s health route.

- [ ] **Step 1: Write the failing test**

Create `tools.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "./tools.mjs";
import { CASES } from "./fixtures/cases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const golden = (name) => readFileSync(join(HERE, "fixtures", "golden", `${name}.txt`), "utf8");

for (const c of CASES) {
  test(`golden: ${c.name}`, async () => {
    const actual = await TOOLS[c.tool].run(c.args);
    assert.equal(actual, golden(c.name),
      `${c.tool} output changed. The extraction must not alter output text.`);
  });
}

test("registry exposes exactly the five MCP tools", () => {
  assert.deepEqual(Object.keys(TOOLS).sort(), [
    "check_change", "explain_rule", "get_baseline_summary",
    "impact_analysis", "trace_lineage",
  ]);
});

test("every tool carries a title, description and inputSchema", () => {
  for (const [name, t] of Object.entries(TOOLS)) {
    assert.ok(t.title, `${name} missing title`);
    assert.ok(t.description, `${name} missing description`);
    assert.ok(t.inputSchema !== undefined, `${name} missing inputSchema`);
    assert.equal(typeof t.run, "function", `${name} missing run()`);
  }
});

test("output ends with the baseline footer", async () => {
  const out = await TOOLS.get_baseline_summary.run({});
  assert.match(out, /Baseline: .+\nInterface: governed evidence interface \(read-only\)/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tools.test.mjs`
Expected: FAIL — `Cannot find module './tools.mjs'`.

- [ ] **Step 3: Create `tools.mjs`**

This is a **move, not a rewrite**. Copy the following from `server.mjs` with bodies byte-identical:

- Lines 28–29 (`__dirname`, `B`) — keep, and add `export` to `B`.
- Line 33 (`FOOTER`) — keep as-is.
- Lines 37–130 — `norm`, `findRuleById`, `findRuleByText`, `bindingsForFile`, `ruleBlock`, `detectTouched`, `diffHitsGuard`, `alterationCues`. Copy verbatim.
- The five `async` tool bodies from the `registerTool` calls (lines 144–158, 172–182, 196–217, 233–302, 317–344), with one mechanical change each: every `return text(X)` becomes `return X + FOOTER`.

Do **not** import `@modelcontextprotocol/sdk` here.

The file skeleton — helpers elided where they are pure copies, tool wiring shown in full:

```js
/* tools.mjs — the CodeIntent tool implementations, transport-agnostic.
   Consumed by server.mjs (stdio MCP), bridge.mjs (local HTTP) and
   handler.mjs (Lambda). Every run() returns a plain string with FOOTER
   already appended, so all three surfaces emit identical text. */

import { z } from "zod";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const B = JSON.parse(readFileSync(join(__dirname, "baseline.json"), "utf8"));

const FOOTER = `\n---\nBaseline: ${B.meta.baseline_id} · ${B.meta.client}\nInterface: governed evidence interface (read-only) · ${B.meta.disclaimer}`;

/* ---- helpers: copied verbatim from server.mjs lines 37-130 ---- */
// function norm(s) { ... }
// function findRuleById(id) { ... }
// function findRuleByText(q) { ... }
// function bindingsForFile(file) { ... }
// function ruleBlock(r) { ... }
// function detectTouched({ files = [], symbols = [], diff = "", description = "" }) { ... }
// function diffHitsGuard(diff, rule) { ... }
// function alterationCues(s) { ... }

/* ---- registry ---- */

export const TOOLS = {
  get_baseline_summary: {
    title: "CodeIntent baseline summary",
    description:
      "Summarize the CodeIntent semantic baseline for this application: codebase scale, traceability, validation results, open boundaries, and governance state. Use this first to understand what the baseline covers.",
    inputSchema: {},
    run: async () => {
      const e = B.meta.codebase;
      const exc = B.exceptions.map((x) => `- [${x.tag}] ${x.art}: ${x.type} — ${x.status} (owner: ${x.owner})`).join("\n");
      return (
        `**${B.meta.baseline_id}** — ${B.meta.job}\n\n` +
        `Source codebase: ${(e.source_loc / 1e6).toFixed(2)}M LOC · ${e.programs} programs · ${e.copybooks} copybooks\n` +
        `Target codebase: ${(e.target_loc / 1e6).toFixed(2)}M LOC · ${e.services} services · ${e.classes} classes\n` +
        `Source-to-target traceability: ${e.traceability_pct}% · Source-derived equivalence coverage: ${e.equivalence_coverage_pct}%\n` +
        `Equivalence records: ${e.equivalence_records_passed} passed · ${e.equivalence_records_failed_open} open failures\n` +
        `Open SME review items: ${e.sme_review_open} (governed boundaries) · Orphaned/excluded: ${e.orphaned_excluded} · Unresolved blockers: ${e.unresolved_blockers}\n` +
        `Build: ${e.build} · Test artifacts: ${e.test_artifacts} generated\n\n` +
        `Coverage percentages describe what is traceable and conformant against the source-traceable specification — different kinds of evidence are never collapsed into one number.\n\n` +
        `**Open governed boundaries:**\n${exc}` + FOOTER
      );
    },
  },

  explain_rule: {
    title: "Explain a CodeIntent rule",
    description:
      "Explain why a business behavior exists in the modernized system. Accepts a rule ID (e.g. R-CTRL-006) or a natural-language question (e.g. 'why don't dormant accounts accrue interest'). Returns the canonical rule with its full evidence chain: source lines, target lines, provenance, contract clause, and validation record.",
    inputSchema: {
      rule_id: z.string().optional().describe("CodeIntent rule ID, e.g. R-CTRL-006"),
      query: z.string().optional().describe("Natural-language question about a behavior"),
    },
    run: async ({ rule_id, query }) => {
      const r = findRuleById(rule_id) || findRuleByText(query || rule_id);
      if (!r)
        return `No rule in this baseline matches "${rule_id || query}". The interface does not guess: if a behavior is not bound in the baseline, it is reported as unbound. Bound rules in this sample: ${B.rule_order.join(", ")}.` + FOOTER;
      let body = ruleBlock(r);
      if (r.id === "R-INF-118")
        body += `\n\n⚠ This rule is CodeIntent-inferred and NOT yet confirmed by a deterministic source branch. It is a governed boundary held for SME review (owner: SME — Payments). Treat it as unverified.`;
      return body + FOOTER;
    },
  },

  // trace_lineage, check_change, impact_analysis follow the identical pattern:
  // title + description + inputSchema copied from the registerTool call,
  // body copied from the async fn, every `return text(X)` becoming `return X + FOOTER`.
};
```

Complete `trace_lineage`, `check_change` and `impact_analysis` the same way, copying from `server.mjs` lines 185–345.

- [ ] **Step 4: Run the tests**

Run: `node --test tools.test.mjs`
Expected: PASS, 13 tests (9 golden + 4 structural).

If a golden test fails, diff it — the failure is real, not a fixture problem:

```bash
node -e "import('./tools.mjs').then(async m=>process.stdout.write(await m.TOOLS.check_change.run((await import('./fixtures/cases.mjs')).CASES.find(c=>c.name==='check-dormant-guard').args)))" > /tmp/actual.txt
diff fixtures/golden/check-dormant-guard.txt /tmp/actual.txt
```

The most likely causes are a missed `+ FOOTER`, or a `text()` call left in place.

- [ ] **Step 5: Reduce `server.mjs` to a thin stdio shell**

The originals must be deleted in this same task. Leaving `server.mjs` intact would
leave ~250 lines of logic existing in two places, which is a defect regardless of the
fact that a later task would have cleaned it up.

Keep the existing lines 1–19 header comment verbatim, then replace everything from
line 21 to the end of `server.mjs`:

```js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS, B } from "./tools.mjs";

const server = new McpServer({ name: "codeintent", version: "0.1.0" });

for (const [name, t] of Object.entries(TOOLS)) {
  server.registerTool(
    name,
    { title: t.title, description: t.description, inputSchema: t.inputSchema },
    async (args) => ({ content: [{ type: "text", text: await t.run(args ?? {}) }] })
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[codeintent-mcp] serving baseline ${B.meta.baseline_id} (read-only evidence interface)`);
```

- [ ] **Step 6: Verify the MCP surface is unchanged**

Run: `npm run test:mcp`
Expected: PASS, and the first line must still read:

```
TOOLS: get_baseline_summary, explain_rule, trace_lineage, check_change, impact_analysis
```

Tool *order* comes from `Object.keys(TOOLS)` insertion order, so `tools.mjs` must define them in that sequence. If the order differs, reorder the registry rather than the test.

- [ ] **Step 7: Verify the golden tests still pass**

Run: `node --test`
Expected: PASS. The extraction is only correct if both the golden tests and the MCP
harness pass against the *same* code.

- [ ] **Step 8: Verify the real MCP client path by hand**

Run:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node server.mjs 2>/dev/null | head -c 400
```
Expected: a JSON-RPC response listing five tools. This confirms the server still speaks the protocol on stdio, which is what Claude Code and `demo-workspace/.vscode/mcp.json` rely on.

- [ ] **Step 9: Confirm no logic survives in duplicate**

Run: `grep -c "function ruleBlock\|function detectTouched\|function alterationCues" server.mjs`
Expected: `0` — every helper now lives only in `tools.mjs`.

Run: `wc -l server.mjs`
Expected: roughly 40–60 lines.

- [ ] **Step 10: Commit**

```bash
git add tools.mjs tools.test.mjs server.mjs
git commit -m "refactor: extract tool implementations into tools.mjs

Transport-agnostic registry of the five CodeIntent tools. run() returns a
plain string with FOOTER appended, so stdio, the local bridge and Lambda
all emit identical text. server.mjs becomes a thin shell that registers
them and wraps results in the MCP content envelope.

Golden tests assert byte-identical output; test:mcp confirms the Claude
Code and VS Code demo paths are unaffected."
```

---

### Task 3: Extract `router.mjs`

**Files:**
- Create: `router.mjs`
- Create: `router.test.mjs`
- Read: `bridge.mjs:66-120`

**Interfaces:**
- Consumes: nothing.
- Produces: `routeQuestion(question: string) => { tool: string, args: object }`.

- [ ] **Step 1: Write the failing test**

The eight questions are copied from `README_PRODUCT_BUILD.md` and are the demo's acceptance criteria.

Create `router.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeQuestion } from "./router.mjs";
import { TOOLS } from "./tools.mjs";

/* The eight scripted questions from README_PRODUCT_BUILD.md.
   routeQuestion falls through to explain_rule when nothing matches, so a
   broken regex fails SOFT — it returns a plausible "no rule matches"
   answer instead of throwing. Pinning all eight is the only way a
   regression surfaces before a live client demo. */
const SCRIPTED = [
  ["What baseline governs this application?", "get_baseline_summary"],
  ["Why don't dormant accounts accrue interest?", "check_change"],
  ["Where does InterestAccrualService.java line 45 come from?", "trace_lineage"],
  ["Show me orphaned code.", "trace_lineage"],
  ["Will adding a fee-waiver flag break interest accrual?", "check_change"],
  ["What happens if I remove the dormant status guard?", "check_change"],
  ["Explain ACH R10 routing.", "explain_rule"],
  ["What is the impact of changing dormant accrual logic?", "check_change"],
];

for (const [q, expected] of SCRIPTED) {
  test(`routes: ${q}`, () => {
    assert.equal(routeQuestion(q).tool, expected);
  });
}

test("every routed tool exists in the registry", () => {
  for (const [q] of SCRIPTED) {
    assert.ok(TOOLS[routeQuestion(q).tool], `unknown tool for: ${q}`);
  }
});

test("unmatched questions fall through to explain_rule with the raw query", () => {
  const r = routeQuestion("what is the airspeed velocity of an unladen swallow");
  assert.equal(r.tool, "explain_rule");
  assert.equal(r.args.query, "what is the airspeed velocity of an unladen swallow");
});

test("empty input does not throw", () => {
  assert.equal(routeQuestion("").tool, "explain_rule");
  assert.equal(routeQuestion(undefined).tool, "explain_rule");
});
```

The expected tools above are what the **current** regex table produces — several demo questions deliberately route to `check_change` rather than the tool their wording suggests. Do not "fix" these to look tidier; that would change demo behavior. Verify against the current bridge before trusting the table:

```bash
node -e "import('./bridge.mjs')" 2>/dev/null || true
```

If Step 3 shows a mismatch, correct the **test table** to match observed current behavior and note it in the commit message.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test router.test.mjs`
Expected: FAIL — `Cannot find module './router.mjs'`.

- [ ] **Step 3: Create `router.mjs`**

Copy `routeQuestion` from `bridge.mjs` lines 66–120 **verbatim**, including the hardcoded `DORMANT_GUARD_DIFF` string inside the dormant-guard branch, adding only the `export` keyword:

```js
/* router.mjs — maps a natural-language question to a tool + arguments.
   A deliberate regex table, not NLP: the demo script's questions are the
   contract. Unmatched questions fall through to explain_rule, which
   reports the behavior as unbound rather than guessing. */

export function routeQuestion(question = "") {
  const q = (question || "").toLowerCase();
  // ... lines 67-119 of bridge.mjs, copied exactly ...
}
```

Note the default parameter must tolerate `undefined`; the existing signature `routeQuestion(question = '')` already does, but the body's `question.toLowerCase()` must become `(question || "").toLowerCase()` to survive an explicit `null`.

- [ ] **Step 4: Run the tests**

Run: `node --test router.test.mjs`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add router.mjs router.test.mjs
git commit -m "refactor: extract routeQuestion into router.mjs

Lifted verbatim from bridge.mjs. Adds tests pinning all eight scripted
demo questions to their expected tool — the router fails soft, so an
unpinned regression would only surface during a live demo."
```

---

### Task 4: Rewire `bridge.mjs` to call tools in-process

**Files:**
- Modify: `bridge.mjs` (remove lines 14-15, 53-64, 66-120; rewire the handlers)

**Interfaces:**
- Consumes: `TOOLS`, `B` from `tools.mjs`; `routeQuestion` from `router.mjs`.
- Produces: unchanged HTTP contract on `127.0.0.1:8787`.

- [ ] **Step 1: Apply the edits**

Replace the MCP client imports (lines 14–15) and delete `callMcpTool` (53–64) and `routeQuestion` (66–120). New imports:

```js
import { TOOLS, B as BASELINE } from "./tools.mjs";
import { routeQuestion } from "./router.mjs";
```

Delete the now-redundant `const BASELINE = JSON.parse(readFileSync(...))` on line 20, and drop `readFileSync` from the `node:fs` import if nothing else uses it (`existsSync`/`statSync` are still needed by `serveStatic`; `readFileSync` is used there too, so keep it).

Replace the two API handlers:

```js
    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const body = await readBody(req);
      const question = String(body.question || '').trim();
      if (!question) return json(res, 400, { error: 'Missing question' });
      const routed = routeQuestion(question);
      const text = await TOOLS[routed.tool].run(routed.args);
      return json(res, 200, { question, routed, tool: routed.tool, text });
    }

    if (req.method === 'POST' && url.pathname === '/api/tool') {
      const body = await readBody(req);
      if (!body.tool) return json(res, 400, { error: 'Missing tool' });
      const t = TOOLS[body.tool];
      if (!t) return json(res, 404, { error: 'Unknown tool' });
      const text = await t.run(body.args || {});
      return json(res, 200, { tool: body.tool, text });
    }
```

- [ ] **Step 2: Start the bridge**

Run: `npm run studio`
Expected: `[codeintent-studio] http://127.0.0.1:8787/studio`

- [ ] **Step 3: Verify the API by hand**

In a second shell:

```bash
curl -s http://127.0.0.1:8787/api/health | head -5
curl -s http://127.0.0.1:8787/api/tool -H 'content-type: application/json' \
  -d '{"tool":"explain_rule","args":{"rule_id":"R-CTRL-006"}}' | head -20
curl -s http://127.0.0.1:8787/api/ask -H 'content-type: application/json' \
  -d '{"question":"What happens if I remove the dormant status guard?"}' \
  | grep -c "NOT BEHAVIOR-PRESERVING"
```

Expected: health returns `"ok": true`; the tool call returns the R-CTRL-006 evidence block; the ask returns `1`.

Then open `http://127.0.0.1:8787/studio` and confirm the Ask CodeIntent strip reads **`MCP bridge: connected`**.

Stop the bridge with Ctrl-C.

- [ ] **Step 4: Confirm no subprocess remains**

Run: `grep -c "StdioClientTransport\|callMcpTool" bridge.mjs`
Expected: `0`

- [ ] **Step 5: Commit**

```bash
git add bridge.mjs
git commit -m "refactor: bridge.mjs calls tools in-process

Drops the per-request stdio subprocess spawn in favour of importing
tools.mjs directly. Same HTTP contract, materially faster locally."
```

---

### Task 5: Add the Lambda handler

**Files:**
- Create: `handler.mjs`
- Create: `handler.test.mjs`

**Interfaces:**
- Consumes: `TOOLS`, `B` from `tools.mjs`; `routeQuestion` from `router.mjs`.
- Produces: `export const handler = async (event) => ({ statusCode, headers, body })` — the Lambda Function URL contract.

- [ ] **Step 1: Write the failing test**

Create `handler.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { handler } from "./handler.mjs";

const evt = (method, path, body) => ({
  requestContext: { http: { method, path } },
  rawPath: path,
  body: body === undefined ? undefined : JSON.stringify(body),
  isBase64Encoded: false,
});

test("GET /api/health reports ok", async () => {
  const r = await handler(evt("GET", "/api/health"));
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.ok, true);
  assert.ok(b.baseline);
});

test("emits no CORS headers — same-origin via CloudFront", async () => {
  const r = await handler(evt("GET", "/api/health"));
  const keys = Object.keys(r.headers).map((k) => k.toLowerCase());
  assert.ok(!keys.some((k) => k.startsWith("access-control-")));
});

test("POST /api/ask routes and answers", async () => {
  const r = await handler(evt("POST", "/api/ask", {
    question: "What happens if I remove the dormant status guard?",
  }));
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.tool, "check_change");
  assert.match(b.text, /NOT BEHAVIOR-PRESERVING/);
});

test("POST /api/ask without a question is 400", async () => {
  const r = await handler(evt("POST", "/api/ask", { question: "  " }));
  assert.equal(r.statusCode, 400);
  assert.equal(JSON.parse(r.body).error, "Missing question");
});

test("POST /api/tool dispatches directly", async () => {
  const r = await handler(evt("POST", "/api/tool", {
    tool: "explain_rule", args: { rule_id: "R-CTRL-006" },
  }));
  assert.equal(r.statusCode, 200);
  assert.match(JSON.parse(r.body).text, /R-CTRL-006/);
});

test("unknown tool is 404", async () => {
  const r = await handler(evt("POST", "/api/tool", { tool: "rm_rf", args: {} }));
  assert.equal(r.statusCode, 404);
  assert.equal(JSON.parse(r.body).error, "Unknown tool");
});

test("invalid args are 400, not 500", async () => {
  const r = await handler(evt("POST", "/api/tool", {
    tool: "trace_lineage", args: { file: 12345 },
  }));
  assert.equal(r.statusCode, 400);
});

test("oversized body is 413", async () => {
  const r = await handler(evt("POST", "/api/ask", { question: "x".repeat(40_000) }));
  assert.equal(r.statusCode, 413);
});

test("unknown path is 404", async () => {
  const r = await handler(evt("GET", "/api/nope"));
  assert.equal(r.statusCode, 404);
});

test("base64-encoded bodies are decoded", async () => {
  const e = evt("POST", "/api/ask", { question: "What baseline governs this application?" });
  e.body = Buffer.from(e.body).toString("base64");
  e.isBase64Encoded = true;
  const r = await handler(e);
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).tool, "get_baseline_summary");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test handler.test.mjs`
Expected: FAIL — `Cannot find module './handler.mjs'`.

- [ ] **Step 3: Write `handler.mjs`**

```js
/* handler.mjs — AWS Lambda Function URL handler for the Studio API.
   Same routes and response shapes as bridge.mjs, so studio_product.html
   needs no change. No CORS headers: CloudFront serves the SPA and this
   handler from one origin. */

import { z } from "zod";
import { TOOLS, B } from "./tools.mjs";
import { routeQuestion } from "./router.mjs";

const MAX_BODY_BYTES = 32 * 1024;

/* Pre-build one zod object per tool so /api/tool validates exactly what
   the MCP server validates. inputSchema is a plain map of zod types. */
const SCHEMAS = Object.fromEntries(
  Object.entries(TOOLS).map(([name, t]) => [name, z.object(t.inputSchema ?? {})])
);

const reply = (statusCode, data) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(data),
});

function readBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    const e = new Error("Request too large");
    e.statusCode = 413;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const e = new Error("Invalid JSON");
    e.statusCode = 400;
    throw e;
  }
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.requestContext?.http?.path ?? event.rawPath ?? "/";

  try {
    if (method === "GET" && path === "/api/health") {
      return reply(200, {
        ok: true,
        bridge: "codeintent-studio-lambda",
        baseline: B.meta?.baseline_id || "CodeIntent baseline",
        mode: B.meta?.interface?.mode || "read-only evidence interface",
      });
    }

    if (method === "POST" && path === "/api/ask") {
      const body = readBody(event);
      const question = String(body.question || "").trim();
      if (!question) return reply(400, { error: "Missing question" });
      const routed = routeQuestion(question);
      const text = await TOOLS[routed.tool].run(routed.args);
      return reply(200, { question, routed, tool: routed.tool, text });
    }

    if (method === "POST" && path === "/api/tool") {
      const body = readBody(event);
      const name = body.tool;
      if (!name) return reply(400, { error: "Missing tool" });
      if (!Object.hasOwn(TOOLS, name)) return reply(404, { error: "Unknown tool" });
      const parsed = SCHEMAS[name].safeParse(body.args ?? {});
      if (!parsed.success) return reply(400, { error: parsed.error.issues[0]?.message ?? "Invalid arguments" });
      const text = await TOOLS[name].run(parsed.data);
      return reply(200, { tool: name, text });
    }

    return reply(404, { error: "Not found" });
  } catch (err) {
    if (err.statusCode) return reply(err.statusCode, { error: err.message });
    console.error("[handler]", err);
    return reply(500, { error: "Internal error" });
  }
};
```

- [ ] **Step 4: Run the tests**

Run: `node --test handler.test.mjs`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test && npm run test:mcp`
Expected: all PASS — 35 `node --test` assertions plus the MCP harness.

- [ ] **Step 6: Commit**

```bash
git add handler.mjs handler.test.mjs
git commit -m "feat: add Lambda Function URL handler for the Studio API

Mirrors bridge.mjs's routes and response shapes so the SPA needs no
change. Adds the hardening the localhost bridge lacked: 32KB body cap,
zod validation on /api/tool, registry-based tool allowlist, generic 500s,
and no CORS headers."
```

---

### Task 6: Fix the offline-fallback copy in the SPA

**Files:**
- Modify: `studio_product.html:1938`

**Interfaces:**
- Consumes: nothing. Produces: nothing. Cosmetic, but demo-visible.

- [ ] **Step 1: Find the current string**

Run: `grep -n "Start the local bridge" studio_product.html`
Expected: one hit around line 1938.

- [ ] **Step 2: Replace it**

Change:

```js
    renderAskResult(q,`MCP bridge unavailable. Start the local bridge with: npm run studio

Built-in examples are still available on the left.

Error: ${e.message}`,{});
```

to:

```js
    renderAskResult(q,`CodeIntent baseline temporarily unreachable — built-in examples remain available on the left.

Error: ${e.message}`,{});
```

- [ ] **Step 3: Verify it renders**

Run `npm run studio`, open `http://127.0.0.1:8787/studio`, then stop the bridge and click Ask. Expected: the new copy, with no mention of `npm run studio`.

- [ ] **Step 4: Commit**

```bash
git add studio_product.html
git commit -m "fix: offline copy no longer tells hosted users to run npm

The fallback told viewers to start a local bridge, which is meaningless
on a hosted demo."
```

---

### Task 7: CDK stack

**Files:**
- Create: `infra/package.json`, `infra/tsconfig.json`, `infra/cdk.json`
- Create: `infra/bin/studio.ts`
- Create: `infra/lib/studio-stack.ts`
- Create: `infra/lib/github-oidc-stack.ts`

**Interfaces:**
- Consumes: `handler.mjs` at the repo root as the Lambda entry.
- Produces: CloudFormation stacks `StudioPortalStack` and `StudioPortalGithubOidcStack`. `StudioPortalStack` outputs `DistributionUrl`, `DistributionId`, `BucketName`.

- [ ] **Step 1: Scaffold the CDK app**

`infra/package.json`:

```json
{
  "name": "studio-portal-infra",
  "version": "1.0.0",
  "private": true,
  "bin": { "infra": "bin/studio.js" },
  "scripts": {
    "build": "tsc",
    "cdk": "cdk"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "aws-cdk": "^2.170.0",
    "ts-node": "^10.9.2",
    "typescript": "^5.6.0"
  },
  "dependencies": {
    "aws-cdk-lib": "^2.170.0",
    "constructs": "^10.3.0",
    "source-map-support": "^0.5.21"
  }
}
```

`infra/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "exclude": ["cdk.out"]
}
```

`infra/cdk.json`:

```json
{
  "app": "npx ts-node --prefer-ts-exts bin/studio.ts",
  "context": {
    "@aws-cdk/core:newStyleStackSynthesis": true
  }
}
```

`ts-node` is already in the `devDependencies` above — `cdk.json`'s `app` command requires it.

- [ ] **Step 2: Write the main stack**

`infra/lib/studio-stack.ts`:

```ts
import * as path from 'path';
import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
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
      entry: path.join(repoRoot, 'handler.mjs'),
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
        // baseline.json is read at runtime via fs.readFileSync, so esbuild
        // does not trace it as a dependency — copy it into the bundle.
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp ${path.join(inputDir, 'baseline.json')} ${outputDir}`,
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
      sources: [s3deploy.Source.asset(repoRoot, { exclude: ['*', '!studio_product.html'] })],
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
      alarmDescription: 'Studio Portal estimated charges exceeded $5 — expected steady state is $0.',
    }).addAlarmAction(new cwActions.SnsAction(topic));

    new CfnOutput(this, 'DistributionUrl', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}
```

Two details in that stack are load-bearing and easy to get wrong:

- **The `afterBundling` hook.** `tools.mjs` reads `baseline.json` with `fs.readFileSync`,
  not `import`. esbuild only traces static imports, so without this hook the Lambda
  deploys without its dataset and every invocation fails at cold start with `ENOENT`.
- **`externalModules: ['@modelcontextprotocol/sdk']`.** Nothing on the Lambda path imports
  it, but marking it external guarantees a stray import can never silently inflate the
  bundle.

- [ ] **Step 3: Write the OIDC stack**

`infra/lib/github-oidc-stack.ts` — deployed manually once, separately from the app stack:

```ts
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
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: {
          'token.actions.githubusercontent.com:sub':
            'repo:alphaomegaintegration/AO-CC-Studio-Portal:*',
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
```

- [ ] **Step 4: Write the app entrypoint**

`infra/bin/studio.ts`:

```ts
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
```

`source-map-support` is already in the `dependencies` above.

- [ ] **Step 5: Compile**

Run: `cd infra && npm install && npx tsc --noEmit`
Expected: no errors. If `FunctionUrlOrigin.withOriginAccessControl` is missing, `aws-cdk-lib` is below 2.170 — upgrade it.

- [ ] **Step 6: Synthesize**

Run: `cd infra && npx cdk synth StudioPortalStack -c alarmEmail=you@example.com`
Expected: CloudFormation YAML on stdout, no errors. This requires no AWS credentials.

- [ ] **Step 7: Verify the synthesized template**

Run:
```bash
cd infra && npx cdk synth StudioPortalStack -c alarmEmail=you@example.com > /tmp/t.yaml
grep -c "AWS::CloudFront::OriginAccessControl" /tmp/t.yaml   # expect 2
grep -c "AWS_IAM" /tmp/t.yaml                                 # expect >= 1
grep -c "ReservedConcurrentExecutions" /tmp/t.yaml            # expect 1
```

Two OACs is correct: one for the S3 origin, one for the Function URL origin. If only one appears, the `/api/*` behavior is not using OAC and the Function URL would be unreachable from CloudFront.

- [ ] **Step 8: Commit**

```bash
git add infra/
git commit -m "feat: CDK stack for S3 + CloudFront + Lambda Function URL

Private bucket and IAM-authed Function URL, both reached only through
CloudFront via OAC. Cost guards baked in: 7-day log retention, reserved
concurrency 5, price class 100, and a \$5 billing alarm."
```

---

### Task 8: GitHub Actions deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: the `studio-portal-github-deploy` role ARN from Task 7's OIDC stack, stored as repo variable `AWS_DEPLOY_ROLE_ARN`; repo variable `ALARM_EMAIL`.
- Produces: a deployed stack and a smoke-tested URL.

- [ ] **Step 1: Write the workflow**

```yaml
name: deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  id-token: write   # required for OIDC
  contents: read

concurrency:
  group: deploy-studio
  cancel-in-progress: false

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - name: Unit tests (golden, router, handler)
        run: node --test
      - name: MCP stdio harness
        run: npm run test:mcp

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
          aws-region: us-east-1

      - name: Install infra deps
        working-directory: infra
        run: npm ci

      - name: CDK deploy
        working-directory: infra
        run: npx cdk deploy StudioPortalStack --require-approval never -c alarmEmail=${{ vars.ALARM_EMAIL }} --outputs-file out.json

      - name: Read outputs
        id: out
        working-directory: infra
        run: |
          echo "url=$(jq -r '.StudioPortalStack.DistributionUrl' out.json)" >> "$GITHUB_OUTPUT"

      - name: Smoke test the API
        run: |
          URL="${{ steps.out.outputs.url }}"
          echo "Testing $URL"
          for i in $(seq 1 10); do
            code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/health") && [ "$code" = "200" ] && break
            echo "attempt $i: HTTP $code — waiting for distribution"
            sleep 20
          done
          curl -sf "$URL/api/health" | jq -e '.ok == true'
          curl -sf "$URL/api/ask" -H 'content-type: application/json' \
            -d '{"question":"What happens if I remove the dormant status guard?"}' \
            | jq -e '.text | test("NOT BEHAVIOR-PRESERVING")'
          echo "Deployed: $URL"

      - name: Summary
        run: echo "### Studio Portal deployed → ${{ steps.out.outputs.url }}" >> "$GITHUB_STEP_SUMMARY"
```

The retry loop matters: a newly created CloudFront distribution takes several minutes to reach `Deployed`, and an immediate smoke test would fail spuriously on the very first run.

- [ ] **Step 2: Validate the YAML**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy.yml'))" && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: deploy workflow with OIDC auth and post-deploy smoke test

Tests gate the deploy. No stored AWS keys — the job assumes the deploy
role via GitHub OIDC. Smoke test retries while the distribution settles."
```

---

## Manual steps (cannot be automated — require human credentials)

Run these once, in order, before the first workflow run. Each depends on access the
repository itself cannot grant; see spec §9.

1. **Configure AWS credentials locally**
   `aws configure` (or `aws configure sso`). Verify: `aws sts get-caller-identity`.

2. **Bootstrap CDK** — once per account/region:
   `cd infra && npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1`

3. **Deploy the OIDC stack** — creates the role the workflow assumes:
   `cd infra && npx cdk deploy StudioPortalGithubOidcStack -c alarmEmail=you@example.com`
   Copy the `DeployRoleArn` output.

4. **Set repository variables** (needs repo admin — currently blocked, see spec §9):
   `gh variable set AWS_DEPLOY_ROLE_ARN --body '<arn from step 3>'`
   `gh variable set ALARM_EMAIL --body 'you@example.com'`

5. **Confirm the SNS subscription** — AWS emails a confirmation link for the billing
   alarm. Unconfirmed means no alert fires.

6. **Enable billing metrics** — Billing console → Billing Preferences → "Receive
   CloudWatch billing alerts". Without this the `AWS/Billing` metric never publishes and
   the alarm sits in `INSUFFICIENT_DATA` forever.

---

## Verification checklist

Run at the end of the whole plan:

```bash
node --test                 # 35 assertions: golden, router, handler
npm run test:mcp            # stdio MCP path intact
cd infra && npx tsc --noEmit && npx cdk synth StudioPortalStack -c alarmEmail=x@y.com >/dev/null
```

Then, against the deployed URL:

- `GET /` returns the Studio HTML.
- The Ask CodeIntent strip reads **`MCP bridge: connected`**.
- All eight scripted questions from `README_PRODUCT_BUILD.md` return live answers.
- "What happens if I remove the dormant status guard?" returns **NOT BEHAVIOR-PRESERVING**.
- Every answer ends with the `Baseline: CodeIntent 2026.06.r1` footer.
- The Function URL is **not** reachable directly: `curl <function-url>/api/health` returns 403.
