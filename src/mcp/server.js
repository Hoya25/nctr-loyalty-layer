/**
 * MCP Streamable HTTP transport.
 *
 * Two protocol details that the Crescendo endpoint already enforces and that
 * clients get wrong constantly, so they are enforced here too:
 *
 *   1. The client MUST send `Accept: application/json, text/event-stream`.
 *      Anything less is 406 — matching Crescendo's behaviour exactly, so a
 *      client written against one works against the other.
 *   2. Responses are SSE-framed (`event: message\ndata: {...}`), not bare JSON.
 *
 * BH's mcp-proxy already parses this framing correctly; it is the reference
 * client and did not need changing to talk to this server.
 */

import { TOOLS, callTool } from './tools.js';
import { assertClean } from '../lib/disclosure.js';

const PROTOCOL_VERSION = '2025-06-18';
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Access-Control-Allow-Origin': '*'
};

function sse(payload) {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200, headers: SSE_HEADERS
  });
}

function rpcError(id, code, message) {
  return sse({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function acceptsBoth(request) {
  const a = (request.headers.get('Accept') || '').toLowerCase();
  return a.includes('application/json') && a.includes('text/event-stream');
}

async function handleMcp(request, env) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method Not Allowed: use POST' },
      id: null
    }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }

  if (!acceptsBoth(request)) {
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Not Acceptable: Client must accept both application/json and text/event-stream' },
      id: null
    }), { status: 406, headers: { 'Content-Type': 'application/json' } });
  }

  let req;
  try {
    req = await request.json();
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }

  const { id, method, params } = req || {};

  switch (method) {
    case 'initialize':
      return sse({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'nctr-alliance-registry', version: '2.2.0' }
        }
      });

    case 'notifications/initialized':
      return new Response(null, { status: 202, headers: { 'Access-Control-Allow-Origin': '*' } });

    case 'ping':
      return sse({ jsonrpc: '2.0', id, result: {} });

    case 'tools/list':
      return sse({ jsonrpc: '2.0', id, result: { tools: TOOLS } });

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        const result = await callTool(name, args, env);
        // Gate runs again here: an MCP result is a public response like any other.
        assertClean(result);
        return sse({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        });
      } catch (err) {
        console.error(`mcp tools/call ${name}:`, err.message);
        return sse({
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ error: 'tool_failed', tool: name }) }],
            isError: true
          }
        });
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export { handleMcp, TOOLS };
