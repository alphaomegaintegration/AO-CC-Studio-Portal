import { test } from "node:test";
import assert from "node:assert/strict";
import { handler } from "./handler.mjs";

const evt = (method, path, body) => ({
  requestContext: { http: { method, path } },
  rawPath: path,
  body: body === undefined ? undefined : JSON.stringify(body),
  isBase64Encoded: false,
});

test("GET /api/health reports ok", async () => {
  const r = await handler(evt("GET", "/api/health"));
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.ok, true);
  assert.ok(b.baseline);
});

test("emits no CORS headers — same-origin via CloudFront", async () => {
  const r = await handler(evt("GET", "/api/health"));
  const keys = Object.keys(r.headers).map((k) => k.toLowerCase());
  assert.ok(!keys.some((k) => k.startsWith("access-control-")));
});

test("POST /api/ask routes and answers", async () => {
  const r = await handler(evt("POST", "/api/ask", {
    question: "What happens if I remove the dormant status guard?",
  }));
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.tool, "check_change");
  assert.match(b.text, /NOT BEHAVIOR-PRESERVING/);
});

test("POST /api/ask without a question is 400", async () => {
  const r = await handler(evt("POST", "/api/ask", { question: "  " }));
  assert.equal(r.statusCode, 400);
  assert.equal(JSON.parse(r.body).error, "Missing question");
});

test("POST /api/tool dispatches directly", async () => {
  const r = await handler(evt("POST", "/api/tool", {
    tool: "explain_rule", args: { rule_id: "R-CTRL-006" },
  }));
  assert.equal(r.statusCode, 200);
  assert.match(JSON.parse(r.body).text, /R-CTRL-006/);
});

test("unknown tool is 404", async () => {
  const r = await handler(evt("POST", "/api/tool", { tool: "rm_rf", args: {} }));
  assert.equal(r.statusCode, 404);
  assert.equal(JSON.parse(r.body).error, "Unknown tool");
});

test("invalid args are 400, not 500", async () => {
  const r = await handler(evt("POST", "/api/tool", {
    tool: "trace_lineage", args: { file: 12345 },
  }));
  assert.equal(r.statusCode, 400);
});

test("oversized body is 413", async () => {
  const r = await handler(evt("POST", "/api/ask", { question: "x".repeat(40_000) }));
  assert.equal(r.statusCode, 413);
});

test("unknown path is 404", async () => {
  const r = await handler(evt("GET", "/api/nope"));
  assert.equal(r.statusCode, 404);
});

test("base64-encoded bodies are decoded", async () => {
  const e = evt("POST", "/api/ask", { question: "What baseline governs this application?" });
  e.body = Buffer.from(e.body).toString("base64");
  e.isBase64Encoded = true;
  const r = await handler(e);
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).tool, "get_baseline_summary");
});
