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
