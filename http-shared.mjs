/* http-shared.mjs — logic shared by the two HTTP transports (bridge.mjs
   for local dev, handler.mjs for the Lambda Function URL) so the same
   request behaves identically on both. Neither transport should
   re-implement this: import it instead.

   Exports:
   - SCHEMAS: one zod object per tool, built from tools.mjs's inputSchema
     (a plain map of zod types), so /api/tool and /api/ask validate
     exactly what the MCP server validates.
   - parseJsonBody(raw, maxBytes?): turns a raw request-body string into a
     parsed object, rejecting literal JSON `null` (valid JSON, but not a
     usable body — property access on it would throw a TypeError
     downstream) and, when maxBytes is given, oversized payloads. Throws
     an Error with a `.statusCode` (400 or 413) on failure so callers can
     translate it straight into an HTTP response.
   - validateToolArgs(name, args): safeParse args against SCHEMAS[name]. */

import { z } from "zod";
import { TOOLS } from "./tools.mjs";

export const SCHEMAS = Object.fromEntries(
  Object.entries(TOOLS).map(([name, t]) => [name, z.object(t.inputSchema ?? {})])
);

export function parseJsonBody(raw, maxBytes) {
  if (!raw) return {};
  if (maxBytes != null && Buffer.byteLength(raw, "utf8") > maxBytes) {
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

export function validateToolArgs(name, args) {
  return SCHEMAS[name].safeParse(args ?? {});
}
