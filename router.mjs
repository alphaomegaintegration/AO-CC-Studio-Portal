/* router.mjs — maps a natural-language question to a tool + arguments.
   A deliberate regex table, not NLP: the demo script's questions are the
   contract. Unmatched questions fall through to explain_rule, which
   reports the behavior as unbound rather than guessing. */

export function routeQuestion(question = '') {
  const q = (question || '').toLowerCase();

  if (/summary|baseline|govern|covers|estate|codebase|scale|overview/.test(q)) {
    return { tool: 'get_baseline_summary', args: {} };
  }
  if (/orphan|excluded|old-rpt/.test(q)) {
    return { tool: 'trace_lineage', args: { file: 'OLD-RPT-9.CBL' } };
  }
  if (/line\s*45|where.*line|lineage|come from|interestaccrualservice/.test(q)) {
    return { tool: 'trace_lineage', args: { file: 'InterestAccrualService.java', line: 45 } };
  }
  if (/remove|delete|dormant.*guard|all accounts accrue|not behavior|break/.test(q)) {
    return {
      tool: 'check_change',
      args: {
        description: 'Remove the dormant status guard so all accounts accrue',
        files: ['InterestAccrualService.java'],
        diff: `--- a/src/main/java/com/firstnational/deposits/InterestAccrualService.java
+++ b/src/main/java/com/firstnational/deposits/InterestAccrualService.java
@@ -41,10 +41,6 @@
     BigDecimal accrueDaily(Account account, MoneyRate dailyRate) {
         BigDecimal principal = account.collectedBalance();
-        if (account.status() == AccountStatus.DORMANT) {
-            audit.suppressed(account, Reason.DORMANT);
-            return BigDecimal.ZERO;
-        }
         return principal.multiply(dailyRate.value())`,
      },
    };
  }
  if (/fee.?waiver|waiver flag/.test(q)) {
    return {
      tool: 'check_change',
      args: {
        description: 'Add a fee-waiver flag to the account model and statement rendering',
        files: ['Account.java', 'StatementRenderingService.java'],
      },
    };
  }
  if (/r10|ach|return routing|manual review/.test(q)) {
    return { tool: 'explain_rule', args: { rule_id: 'R-INF-118' } };
  }
  if (/impact|affect|blast|bounded/.test(q)) {
    return { tool: 'impact_analysis', args: { rule_id: 'R-CTRL-006' } };
  }
  if (/reg dd|apy|annual percentage/.test(q)) {
    return { tool: 'explain_rule', args: { rule_id: 'R-REG-014' } };
  }
  if (/daily interest|accrual basis|365/.test(q)) {
    return { tool: 'explain_rule', args: { rule_id: 'R-CALC-002' } };
  }

  return { tool: 'explain_rule', args: { query: question } };
}
