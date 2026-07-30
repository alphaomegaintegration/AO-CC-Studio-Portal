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
