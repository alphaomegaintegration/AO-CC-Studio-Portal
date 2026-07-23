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
import { z } from "zod";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const B = JSON.parse(readFileSync(join(__dirname, "baseline.json"), "utf8"));

/* ----------------------------- helpers ----------------------------- */

const FOOTER = `\n---\nBaseline: ${B.meta.baseline_id} · ${B.meta.client}\nInterface: governed evidence interface (read-only) · ${B.meta.disclaimer}`;

const text = (s) => ({ content: [{ type: "text", text: s + FOOTER }] });

function norm(s) {
  return (s || "").toLowerCase().replace(/[\u2011\u2010]/g, "-");
}

function findRuleById(id) {
  if (!id) return null;
  const key = Object.keys(B.rules).find((k) => norm(k) === norm(id));
  return key ? { id: key, ...B.rules[key] } : null;
}

function findRuleByText(q) {
  if (!q) return null;
  const ql = norm(q);
  const terms = ql.split(/\W+/).filter((t) => t.length > 3);
  let best = null, bestScore = 0;
  for (const [id, r] of Object.entries(B.rules)) {
    const hay = norm([id, r.behavior, r.rule, r.srcFile, r.tgtFile, r.clause].join(" "));
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score++;
    if (score > bestScore) { bestScore = score; best = { id, ...r }; }
  }
  return bestScore > 0 ? best : null;
}

function bindingsForFile(file) {
  const f = norm(file).split("/").pop();
  return B.bindings.filter((b) => norm(b.file) === f);
}

function ruleBlock(r) {
  const lines = [
    `**${r.id} — ${r.behavior}**`,
    `Rule: ${r.rule}`,
    `Provenance: ${r.originText}`,
    `Rule source: ${r.ruleSrc}`,
    `Governance contract clause: ${r.clause}`,
    `Validation: ${r.valStatus}`,
    `Evidence record: ${r.evId} — ${r.evResult}` + (r.det ? " (deterministic equivalence)" : ""),
    `Source: ${r.srcFile}` + (r.srcHL?.length ? ` lines ${r.srcHL[0]}–${r.srcHL[1]}` : ""),
    `Target: ${r.tgtFile}` + (r.tgtHL?.length ? ` lines ${r.tgtHL[0]}–${r.tgtHL[1]}` : ""),
  ];
  if (r.ev?.length) lines.push("Evidence detail: " + r.ev.map(([k, v]) => `${k}: ${v}`).join(" · "));
  if (r.impact) lines.push(`Bounded impact: ${r.impact}`);
  return lines.join("\n");
}

/* Touched-binding detection for check_change */
function detectTouched({ files = [], symbols = [], diff = "", description = "" }) {
  const hay = norm([files.join(" "), symbols.join(" "), diff, description].join(" "));
  const touched = new Map(); // binding.symbol -> {binding, hits:[reasons]}
  for (const b of B.bindings) {
    const reasons = [];
    const fname = norm(b.file);
    const method = norm(b.symbol.split(".").pop());
    if (hay.includes(fname.replace(".java", "")) || hay.includes(fname)) reasons.push(`file ${b.file}`);
    if (method.length > 3 && hay.includes(method)) reasons.push(`symbol ${b.symbol}`);
    // diff hunk line ranges: @@ -a,b +c,d @@ — check overlap with bound lines
    for (const m of diff.matchAll(/@@ .*\+(\d+),?(\d+)? @@/g)) {
      const start = +m[1], len = +(m[2] || 1), end = start + len - 1;
      if (start <= b.lines[1] && end >= b.lines[0] && reasons.some((r) => r.startsWith("file")))
        reasons.push(`lines ${start}–${end} overlap bound region ${b.lines[0]}–${b.lines[1]}`);
    }
    if (reasons.length) touched.set(b.symbol, { binding: b, reasons });
  }
  return [...touched.values()];
}

/* Rule-precise check: do the diff's removed/modified lines hit THIS rule's
   guarded target lines? (symbol-level binding precision, not region-coarse) */
function diffHitsGuard(diff, rule) {
  if (!diff || !rule.tgtHL?.length || !rule.tgtLines?.length) return null; // unknown
  const removed = diff
    .split("\n")
    .filter((l) => l.startsWith("-") && !l.startsWith("---"))
    .map((l) => norm(l.slice(1)).replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 5);
  if (!removed.length) return false;
  const guards = rule.tgtLines
    .filter(([ln]) => ln >= rule.tgtHL[0] && ln <= rule.tgtHL[1])
    .map(([, txt]) => norm(txt).replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 5);
  return guards.some((g) => removed.some((r) => r.includes(g) || g.includes(r)));
}

/* Semantic cues: does the change plausibly alter guarded behavior, vs. additive? */
function alterationCues(s) {
  const hay = norm(s);
  const altering = ["remove", "delete", "drop", "bypass", "skip", "disable", "change", "modify", "alter", "replace", "rewrite", "threshold", "instead of", "no longer", "-        if", "- if"];
  const additive = ["add ", "introduce", "append", "log", "metric", "comment", "metadata", "field", "annotation"];
  return {
    alters: altering.some((k) => hay.includes(k)),
    additive: additive.some((k) => hay.includes(k)),
  };
}

/* ------------------------------ server ------------------------------ */

const server = new McpServer({ name: "codeintent", version: "0.1.0" });

server.registerTool(
  "get_baseline_summary",
  {
    title: "CodeIntent baseline summary",
    description:
      "Summarize the CodeIntent semantic baseline for this application: codebase scale, traceability, validation results, open boundaries, and governance state. Use this first to understand what the baseline covers.",
    inputSchema: {},
  },
  async () => {
    const e = B.meta.codebase;
    const exc = B.exceptions.map((x) => `- [${x.tag}] ${x.art}: ${x.type} — ${x.status} (owner: ${x.owner})`).join("\n");
    return text(
      `**${B.meta.baseline_id}** — ${B.meta.job}\n\n` +
      `Source codebase: ${(e.source_loc / 1e6).toFixed(2)}M LOC · ${e.programs} programs · ${e.copybooks} copybooks\n` +
      `Target codebase: ${(e.target_loc / 1e6).toFixed(2)}M LOC · ${e.services} services · ${e.classes} classes\n` +
      `Source-to-target traceability: ${e.traceability_pct}% · Source-derived equivalence coverage: ${e.equivalence_coverage_pct}%\n` +
      `Equivalence records: ${e.equivalence_records_passed} passed · ${e.equivalence_records_failed_open} open failures\n` +
      `Open SME review items: ${e.sme_review_open} (governed boundaries) · Orphaned/excluded: ${e.orphaned_excluded} · Unresolved blockers: ${e.unresolved_blockers}\n` +
      `Build: ${e.build} · Test artifacts: ${e.test_artifacts} generated\n\n` +
      `Coverage percentages describe what is traceable and conformant against the source-traceable specification — different kinds of evidence are never collapsed into one number.\n\n` +
      `**Open governed boundaries:**\n${exc}`
    );
  }
);

server.registerTool(
  "explain_rule",
  {
    title: "Explain a CodeIntent rule",
    description:
      "Explain why a business behavior exists in the modernized system. Accepts a rule ID (e.g. R-CTRL-006) or a natural-language question (e.g. 'why don't dormant accounts accrue interest'). Returns the canonical rule with its full evidence chain: source lines, target lines, provenance, contract clause, and validation record.",
    inputSchema: {
      rule_id: z.string().optional().describe("CodeIntent rule ID, e.g. R-CTRL-006"),
      query: z.string().optional().describe("Natural-language question about a behavior"),
    },
  },
  async ({ rule_id, query }) => {
    const r = findRuleById(rule_id) || findRuleByText(query || rule_id);
    if (!r)
      return text(
        `No rule in this baseline matches "${rule_id || query}". The interface does not guess: if a behavior is not bound in the baseline, it is reported as unbound. Bound rules in this sample: ${B.rule_order.join(", ")}.`
      );
    let body = ruleBlock(r);
    if (r.id === "R-INF-118")
      body += `\n\n⚠ This rule is CodeIntent-inferred and NOT yet confirmed by a deterministic source branch. It is a governed boundary held for SME review (owner: SME — Payments). Treat it as unverified.`;
    return text(body);
  }
);

server.registerTool(
  "trace_lineage",
  {
    title: "Trace lineage for a file or line",
    description:
      "Given a target Java file (and optionally a line number) — or a legacy source file — return the full lineage: source program and lines, canonical CodeIntent rule, contract clause, and the deterministic equivalence record. Use this when a developer asks 'where does this code come from' or 'what legacy behavior does this implement'.",
    inputSchema: {
      file: z.string().describe("File name or path, e.g. InterestAccrualService.java or ACCT-INTEREST.CBL"),
      line: z.number().optional().describe("Line number within the file"),
    },
  },
  async ({ file, line }) => {
    const f = norm(file).split("/").pop();
    const hits = Object.entries(B.rules)
      .map(([id, r]) => ({ id, ...r }))
      .filter((r) => norm(r.tgtFile) === f || norm(r.srcFile) === f);
    if (!hits.length) {
      const orphan = B.scope.find((s) => norm(s.src) === f && s.status === "orphaned");
      if (orphan)
        return text(`**${file}** is ORPHANED in this baseline: no runtime reference reaches it across the ingested codebase. It was excluded from the target — listed, not silently dropped.`);
      return text(`**${file}** is not bound in this sample baseline. In a production baseline every generated artifact resolves to a binding; in this sample only the pinned demo codebase is loaded.`);
    }
    let chosen = hits;
    if (line != null) {
      const inRange = hits.filter((r) => r.tgtHL?.length && line >= r.tgtHL[0] && line <= r.tgtHL[1]);
      if (inRange.length) chosen = inRange;
    }
    const blocks = chosen.map((r) => ruleBlock(r)).join("\n\n");
    const note = line != null && chosen === hits && hits.length > 1
      ? `\n(Line ${line} is not inside a specific bound region; showing all behaviors bound to ${file}.)`
      : "";
    return text(`Lineage for **${file}**${line != null ? ` line ${line}` : ""}:\n\n${blocks}${note}`);
  }
);

server.registerTool(
  "check_change",
  {
    title: "Check a proposed change against the baseline",
    description:
      "Check whether a proposed code change preserves the CodeIntent baseline. Provide any of: a unified diff, the files/symbols touched, or a plain-language description of the change. Returns a deterministic verdict: PRESERVED, ALLOWED CHANGE (re-validation named), NOT BEHAVIOR-PRESERVING (routes to change governance), or HELD BOUNDARY (touches an unverified inferred rule). This is an advisory evidence check — it does not modify anything.",
    inputSchema: {
      diff: z.string().optional().describe("Unified diff of the proposed change"),
      files: z.array(z.string()).optional().describe("Files touched"),
      symbols: z.array(z.string()).optional().describe("Methods/classes touched"),
      description: z.string().optional().describe("Plain-language description of the change"),
    },
  },
  async (args) => {
    const touched = detectTouched(args);
    const cues = alterationCues([args.diff, args.description].filter(Boolean).join(" "));

    if (!touched.length)
      return text(
        `**Verdict: NO BOUND BEHAVIOR AFFECTED (advisory pass)**\n\nThe proposed change does not touch any symbol, file, or line region bound in this baseline. No source-derived behavior is at risk. Note: in this sample baseline only the pinned demo codebase is bound; a production baseline binds the full codebase.`
      );

    const sections = [];
    let worst = "preserved"; // preserved < allowed < held < break
    const rank = { preserved: 0, allowed: 1, held: 2, break: 3 };
    const bump = (v) => { if (rank[v] > rank[worst]) worst = v; };

    for (const { binding, reasons } of touched) {
      if (binding.allowed_change) {
        bump("allowed");
        sections.push(
          `**${binding.symbol}** (${binding.file}) — matched via ${reasons.join(", ")}\n` +
          `This region is an ALLOWED CHANGE under ${binding.allowed_change}. The change is permitted, and contract conformance re-validation is REQUIRED — named, not assumed.`
        );
        continue;
      }
      for (const rid of binding.rules) {
        const r = findRuleById(rid);
        if (rid === "R-INF-118") {
          bump("held");
          sections.push(
            `**${binding.symbol}** → ${rid} (${r.behavior}) — matched via ${reasons.join(", ")}\n` +
            `HELD BOUNDARY: the bound intent is itself CodeIntent-inferred and not yet confirmed by a deterministic source branch. CodeIntent will not verify a change against a baseline that does not exist yet. Route to SME review (owner: SME — Payments) before merging.`
          );
          continue;
        }
        if (rid === "R-NEW-031") {
          bump(cues.alters && !cues.additive ? "allowed" : "preserved");
          sections.push(
            `**${binding.symbol}** → ${rid} (${r.behavior}) — matched via ${reasons.join(", ")}\n` +
            `Net-new intent: no source behavior is bound here. Additive changes validate against ${r.clause}. Contract conformance check applies; no equivalence record is affected.`
          );
          continue;
        }
        // source-derived verified rule — guard-precise when a diff is given
        const guardHit = diffHitsGuard(args.diff, r);
        const alters = guardHit === null ? cues.alters && !cues.additive : guardHit;
        if (alters) {
          bump("break");
          sections.push(
            `**${binding.symbol}** → ${rid} (${r.behavior}) — matched via ${reasons.join(", ")}\n` +
            `NOT BEHAVIOR-PRESERVING. The bound region implements a source-derived behavior verified by ${r.evId} (${r.valStatus}). The proposed change alters it: "${r.rule}" would no longer hold.\n` +
            `This may be valid business policy — but it is not behavior-preserving. Required action: open a change-governance review to either reject the change or update the approved intent baseline (which retires/replaces ${r.evId} explicitly).\n` +
            `Source lineage: ${r.srcFile} lines ${r.srcHL?.[0]}–${r.srcHL?.[1]} · Contract clause: ${r.clause}`
          );
        } else {
          sections.push(
            `**${binding.symbol}** → ${rid} (${r.behavior}) — matched via ${reasons.join(", ")}\n` +
            `Touches the bound region but does not alter the guarded lines. Equivalence record ${r.evId} should be RE-RUN on commit to confirm preservation; the bound behavior ("${r.rule}") is the invariant being protected.`
          );
        }
      }
    }

    const VERDICT = {
      break: "NOT BEHAVIOR-PRESERVING — route to change governance",
      held: "HELD BOUNDARY — SME review required before this change can be verified",
      allowed: "ALLOWED CHANGE — re-validation required and named",
      preserved: "PRESERVED (advisory) — bound behavior unaffected; equivalence re-run recommended on commit",
    }[worst];

    return text(`**Verdict: ${VERDICT}**\n\n${sections.join("\n\n")}`);
  }
);

server.registerTool(
  "impact_analysis",
  {
    title: "Bounded impact analysis",
    description:
      "Show the bounded impact of touching a rule, symbol, or file: affected behaviors, call sites, adjacent allowed-change surfaces, and the evidence records that would re-run. Use when a developer asks 'what does this affect' or before scoping a change.",
    inputSchema: {
      rule_id: z.string().optional(),
      symbol: z.string().optional(),
      file: z.string().optional(),
    },
  },
  async ({ rule_id, symbol, file }) => {
    let r = findRuleById(rule_id);
    if (!r && symbol) {
      const b = B.bindings.find((b) => norm(b.symbol).includes(norm(symbol)));
      if (b?.rules?.length) r = findRuleById(b.rules[0]);
    }
    if (!r && file) {
      const hits = bindingsForFile(file).flatMap((b) => b.rules);
      if (hits.length) r = findRuleById(hits[0]);
    }
    if (!r) return text(`No bound rule found for that input. Bound rules in this sample: ${B.rule_order.join(", ")}.`);

    const prop = B.change_proposals.find((c) => c.rule === r.id);
    let fan = "";
    if (prop?.fan) {
      fan =
        `\nImpact fan (${prop.fan.center}):\n` +
        prop.fan.sites.map(([name, n, sev]) => `  - ${name}: ${n} call site${n > 1 ? "s" : ""} [${sev === "break" ? "BREAKS" : sev === "warn" ? "re-validate" : "unaffected"}]`).join("\n");
    }
    const adjacent = r.id === "R-CTRL-006" || r.id === "R-CALC-002"
      ? `\nAdjacent allowed-change surface: Ledger Posting adapter (Contract v1.1) — re-validate if posting amounts change.`
      : "";
    return text(
      `**Impact analysis — ${r.id} (${r.behavior})**\n\n${r.impact}\n` +
      `Evidence record that re-runs on change: ${r.evId} (${r.valStatus})${fan}${adjacent}\n` +
      `Provenance: ${r.originText}`
    );
  }
);

/* ------------------------------- main ------------------------------- */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[codeintent-mcp] serving baseline ${B.meta.baseline_id} (read-only evidence interface)`);
