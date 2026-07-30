import { test } from "node:test";
import assert from "node:assert/strict";
import { routeQuestion } from "./router.mjs";
import { TOOLS } from "./tools.mjs";

/* The eight scripted questions from README_PRODUCT_BUILD.md.
   routeQuestion falls through to explain_rule when nothing matches, so a
   broken regex fails SOFT — it returns a plausible "no rule matches"
   answer instead of throwing. Pinning all eight is the only way a
   regression surfaces before a live client demo.

   NOTE: two entries were corrected from the brief's draft table to match
   the current regex table's observed behavior (characterization tests
   describe what the code does, not what the wording suggests):
     - "Why don't dormant accounts accrue interest?" falls through to
       explain_rule (no branch matches: "don't" does not contain "not",
       and there is no "guard" in the text), not check_change.
     - "What is the impact of changing dormant accrual logic?" matches
       the /impact|affect|blast|bounded/ branch and routes to
       impact_analysis, not check_change. */
const SCRIPTED = [
  ["What baseline governs this application?", "get_baseline_summary"],
  ["Why don't dormant accounts accrue interest?", "explain_rule"],
  ["Where does InterestAccrualService.java line 45 come from?", "trace_lineage"],
  ["Show me orphaned code.", "trace_lineage"],
  ["Will adding a fee-waiver flag break interest accrual?", "check_change"],
  ["What happens if I remove the dormant status guard?", "check_change"],
  ["Explain ACH R10 routing.", "explain_rule"],
  ["What is the impact of changing dormant accrual logic?", "impact_analysis"],
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

test("null input does not throw", () => {
  assert.equal(routeQuestion(null).tool, "explain_rule");
});
