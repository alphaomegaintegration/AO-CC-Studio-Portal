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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const BASELINE = JSON.parse(readFileSync(join(__dirname, 'baseline.json'), 'utf8'));

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
  return raw ? JSON.parse(raw) : {};
}

async function callMcpTool(name, args = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(__dirname, 'server.mjs')] });
  const client = new Client({ name: 'codeintent-studio-bridge', version: '0.1.0' });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content || []).map((c) => c.text || '').join('\n');
    return { tool: name, text };
  } finally {
    await client.close();
  }
}

function routeQuestion(question = '') {
  const q = question.toLowerCase();

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
      const result = await callMcpTool(routed.tool, routed.args);
      return json(res, 200, { question, routed, ...result });
    }

    if (req.method === 'POST' && url.pathname === '/api/tool') {
      const body = await readBody(req);
      if (!body.tool) return json(res, 400, { error: 'Missing tool' });
      const result = await callMcpTool(body.tool, body.args || {});
      return json(res, 200, result);
    }

    if (req.method === 'GET') return serveStatic(req, res);
    return json(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[bridge] error', err);
    return json(res, 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[codeintent-studio] http://${HOST}:${PORT}/studio`);
  console.log(`[codeintent-studio] baseline ${BASELINE.meta?.baseline_id || 'loaded'} · read-only`);
});
