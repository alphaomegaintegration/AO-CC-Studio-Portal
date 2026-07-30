#!/usr/bin/env node
/**
 * Holonic CodeIntent — MCP Evidence Interface (prototype)
 * -------------------------------------------------------
 * A read-only MCP server exposing the CodeIntent semantic baseline to
 * developer tools (Claude Code, VS Code Copilot agent mode, etc.).
 *
 * The baseline behind this server is the SAME sample codebase rendered by
 * the CodeIntent Studio cockpit (baseline.json, extracted from it).
 * The MCP interface is real; the production engine that generates
 * baselines from customer source codebases is the August milestone.
 *
 * Tools (all read-only, evidence-returning — no write surface):
 *   get_baseline_summary  — what this baseline is and what it covers
 *   explain_rule          — why a behavior exists, with full evidence chain
 *   trace_lineage         — Java file/line -> source program, rule, evidence
 *   check_change          — proposed change -> deterministic verdict vs baseline
 *   impact_analysis       — bounded impact fan for a rule, symbol, or file
 */

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
