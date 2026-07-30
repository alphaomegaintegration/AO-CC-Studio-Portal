# Holonic CodeIntent Studio — Product Build + Local MCP Bridge

This bundle contains a cleaned product-build version of CodeIntent Studio and the local MCP files needed to make the **Ask CodeIntent** section query the same baseline used by Claude Code / VS Code.

## What changed in the product build

- Removed prototype/release labels and most marketing/explainer copy.
- Promoted **Governed Boundaries** into the Evidence navigation.
- Renamed **Equivalence** to **Verification**.
- Kept the product shape focused on the read-only delivery evidence surface:
  - Delivery Overview
  - Scope Ledger
  - Trace Explorer
  - Ask CodeIntent
  - Verification
  - Governed Boundaries
  - Evidence Package
- Removed Operate Mode from the product nav.
- Wired **Ask CodeIntent** to a local HTTP bridge that calls the MCP server over stdio.

## Files

```text
codeintent_product_build/
├── studio_product.html          Product-build Studio UI
├── bridge.mjs                   Local HTTP bridge for the browser
├── server.mjs                   MCP server over stdio
├── baseline.json                Shared sample CodeIntent baseline
├── package.json                 Node scripts/dependencies
├── package-lock.json            Locked dependencies
├── mcp-harness.mjs              MCP test harness
├── docs/
│   └── ao-client-demo-script.md AO client demo script (~15 min run of show)
└── demo-workspace/              Small workspace for Claude Code / VS Code demos
```

## Requirements

- Node.js 18 or newer
- npm
- Optional: Claude Code and/or VS Code Copilot agent mode

Check Node:

```bash
node --version
```

## Run the Studio product build

From this folder:

```bash
npm install
npm run studio
```

Open:

```text
http://127.0.0.1:8787/studio
```

(This local bridge path is only valid when running `npm run studio` on your own
machine. If you're pointed at a hosted demo instead, open the distribution URL's
root — `<hosted-url>/` — not `/studio`; CloudFront only serves the Studio HTML at
the root path.)

In the **Ask CodeIntent** page, the status strip should show:

```text
MCP bridge: connected · CodeIntent 2026.06.r1 · read-only
```

Try these questions:

```text
What baseline governs this application?
Why don't dormant accounts accrue interest?
Where does InterestAccrualService.java line 45 come from?
Show me orphaned code.
Will adding a fee-waiver flag break interest accrual?
What happens if I remove the dormant status guard?
Explain ACH R10 routing.
What is the impact of changing dormant accrual logic?
```

## Sanity-check the MCP server without the browser

```bash
npm run test:mcp
```

You should see all five tools:

```text
get_baseline_summary, explain_rule, trace_lineage, check_change, impact_analysis
```

The key demo moment is the dormant-guard removal. `check_change` should return:

```text
NOT BEHAVIOR-PRESERVING — route to change governance
```

## How the browser bridge works

The browser cannot directly call a stdio MCP server. This bundle uses:

```text
Studio HTML
  -> fetch('/api/ask')
  -> bridge.mjs
  -> MCP client over stdio
  -> server.mjs
  -> baseline.json
```

Important endpoints:

```text
GET  /api/health        bridge status
POST /api/ask           natural-language Ask CodeIntent route
POST /api/tool          direct MCP tool call: { "tool": "explain_rule", "args": {...} }
```

Example direct call:

```bash
curl -s http://127.0.0.1:8787/api/tool \
  -H 'content-type: application/json' \
  -d '{"tool":"explain_rule","args":{"rule_id":"R-CTRL-006"}}'
```

## Claude Code setup

From anywhere, add the MCP server:

```bash
claude mcp add --transport stdio codeintent -- node /absolute/path/to/codeintent_product_build/server.mjs
claude mcp list
```

Then open Claude Code in:

```text
codeintent_product_build/demo-workspace
```

Ask:

```text
Use codeintent: what baseline governs this application?
Why don't dormant accounts accrue interest? Ask codeintent.
Where does InterestAccrualService.java line 45 come from? Use codeintent trace_lineage.
Delete the dormant-status guard and check the change with codeintent before applying it.
```

## VS Code setup

Open the `demo-workspace` folder in VS Code. The included `.vscode/mcp.json` points to `../server.mjs`.

If VS Code cannot find Node, edit `.vscode/mcp.json` and replace `node` with the absolute path from:

```bash
which node
```

Then use Copilot Chat in Agent mode and enable the `codeintent` tools.

## Demo framing

Use this line when showing both Studio and Claude Code:

> The Studio product surface and Claude Code are querying the same CodeIntent baseline. The LLM can propose or ask; CodeIntent returns the evidence.

Guardrails:

- Say: deterministic equivalence to a source-traceable specification.
- Say: governed boundary, explicitly dispositioned, evidence-backed.
- Avoid: mathematically proven, prevents hallucinations, 100% converted.
