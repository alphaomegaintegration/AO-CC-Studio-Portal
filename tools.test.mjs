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
