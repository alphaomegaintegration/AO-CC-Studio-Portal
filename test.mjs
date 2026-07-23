/* Test harness: spawns the server over stdio and exercises every tool,
   including the two demo moments (fee-waiver question, dormant-guard removal). */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["server.mjs"] });
const client = new Client({ name: "test", version: "0.0.1" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "), "\n");

async function call(name, args) {
  console.log(`\n========== ${name} ${JSON.stringify(args)} ==========`);
  const res = await client.callTool({ name, arguments: args });
  console.log(res.content[0].text);
}

await call("get_baseline_summary", {});
await call("explain_rule", { query: "why don't dormant accounts accrue interest" });
await call("trace_lineage", { file: "InterestAccrualService.java", line: 45 });

// Demo moment 1: the fee-waiver question (no bound behavior touched)
await call("check_change", {
  description: "Add a fee-waiver flag to the account model and statement rendering",
  files: ["Account.java", "StatementRenderingService.java"],
});

// Demo moment 2: the dormant-guard removal (breaks EQV-2272)
await call("check_change", {
  description: "Remove the dormant status guard so all accounts accrue",
  files: ["InterestAccrualService.java"],
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
});

// Touching the inferred rule -> held boundary
await call("check_change", {
  description: "Change ACH R10 routing to a new queue in AchReturnHandler.onReturn",
  symbols: ["AchReturnHandler.onReturn"],
});

// Allowed-change adapter
await call("check_change", {
  description: "Modify posting amounts in LedgerPostingAdapter for the fee waiver",
  files: ["LedgerPostingAdapter.java"],
});

await call("impact_analysis", { rule_id: "R-CTRL-006" });
await call("explain_rule", { rule_id: "R-INF-118" });
await call("trace_lineage", { file: "OLD-RPT-9.CBL" });

await client.close();
