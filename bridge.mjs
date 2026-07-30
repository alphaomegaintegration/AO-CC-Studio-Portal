#!/usr/bin/env node
/**
 * CodeIntent Studio local bridge
 * -----------------------------
 * Serves the product-build Studio HTML and exposes a tiny HTTP API that calls
 * the local CodeIntent MCP server over stdio. This keeps the browser simple:
 * Studio -> fetch('/api/ask') -> bridge -> MCP server.mjs -> baseline.json.
 */

import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, B as BASELINE } from "./tools.mjs";
import { routeQuestion } from "./router.mjs";
import { parseJsonBody, validateToolArgs } from "./http-shared.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(body);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data, null, 2));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return parseJsonBody(raw);
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/studio_product.html';
  if (pathname === '/studio') pathname = '/studio_product.html';

  const file = resolve(join(__dirname, pathname.replace(/^\/+/, '')));
  if (!file.startsWith(__dirname) || !existsSync(file) || !statSync(file).isFile()) {
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    return;
  }
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  send(res, 200, readFileSync(file), type);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');

    const url = new URL(req.url, `http://${HOST}:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        bridge: 'codeintent-studio-bridge',
        baseline: BASELINE.meta?.baseline_id || 'CodeIntent baseline',
        mode: BASELINE.meta?.interface?.mode || 'read-only evidence interface',
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const body = await readBody(req);
      const question = String(body.question || '').trim();
      if (!question) return json(res, 400, { error: 'Missing question' });
      const routed = routeQuestion(question);
      const askParsed = validateToolArgs(routed.tool, routed.args);
      if (!askParsed.success) return json(res, 400, { error: askParsed.error.issues[0]?.message ?? 'Invalid arguments' });
      const text = await TOOLS[routed.tool].run(askParsed.data);
      return json(res, 200, { question, routed, tool: routed.tool, text });
    }

    if (req.method === 'POST' && url.pathname === '/api/tool') {
      const body = await readBody(req);
      if (!body.tool) return json(res, 400, { error: 'Missing tool' });
      const t = TOOLS[body.tool];
      if (!t) return json(res, 404, { error: 'Unknown tool' });
      const parsed = validateToolArgs(body.tool, body.args);
      if (!parsed.success) return json(res, 400, { error: parsed.error.issues[0]?.message ?? 'Invalid arguments' });
      const text = await t.run(parsed.data);
      return json(res, 200, { tool: body.tool, text });
    }

    if (req.method === 'GET') return serveStatic(req, res);
    return json(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    if (err.statusCode) return json(res, err.statusCode, { error: err.message });
    console.error('[bridge] error', err);
    return json(res, 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[codeintent-studio] http://${HOST}:${PORT}/studio`);
  console.log(`[codeintent-studio] baseline ${BASELINE.meta?.baseline_id || 'loaded'} · read-only`);
});
