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
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const e = new Error("Invalid JSON");
    e.statusCode = 400;
    throw e;
  }
  /* JSON `null` parses fine but is not a usable request body — treat it as
     absent/invalid input rather than letting `body.question`/`body.tool`
     throw a TypeError downstream. Primitives (numbers, strings) and arrays
     are left as-is: they safely produce `undefined` field access, which the
     route handlers already turn into ordinary 400s (e.g. "Missing question"). */
  if (parsed === null) {
    const e = new Error("Invalid JSON");
    e.statusCode = 400;
    throw e;
  }
  return parsed;
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
