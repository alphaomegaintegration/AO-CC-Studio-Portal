/* handler.mjs — AWS Lambda Function URL handler for the Studio API.
   Same routes and response shapes as bridge.mjs, so studio_product.html
   needs no change. No CORS headers: CloudFront serves the SPA and this
   handler from one origin. */

import { TOOLS, B } from "./tools.mjs";
import { routeQuestion } from "./router.mjs";
import { parseJsonBody, validateToolArgs } from "./http-shared.mjs";

const MAX_BODY_BYTES = 32 * 1024;

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
  return parseJsonBody(raw, MAX_BODY_BYTES);
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
      const askParsed = validateToolArgs(routed.tool, routed.args);
      if (!askParsed.success) return reply(400, { error: askParsed.error.issues[0]?.message ?? "Invalid arguments" });
      const text = await TOOLS[routed.tool].run(askParsed.data);
      return reply(200, { question, routed, tool: routed.tool, text });
    }

    if (method === "POST" && path === "/api/tool") {
      const body = readBody(event);
      const name = body.tool;
      if (!name) return reply(400, { error: "Missing tool" });
      if (!Object.hasOwn(TOOLS, name)) return reply(404, { error: "Unknown tool" });
      const parsed = validateToolArgs(name, body.args);
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
