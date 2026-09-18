const { TOOLS, callTool } = require('../../lib/mcp-tools');

// Minimal MCP server over the "Streamable HTTP" transport, stateless (no SSE, no session
// store) — every request is a single POST carrying one JSON-RPC message, answered with a
// single JSON-RPC response. This is spec-legal: a server that doesn't need resumable
// streams or server-initiated messages can just respond directly instead of opening an
// SSE stream. Netlify Functions are short-lived and can't hold a stream open anyway, so
// this is also the only shape that fits the hosting.

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'docusign-pdf-onboarder', version: '1.0.0' };

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isAuthorized(event) {
  const expected = process.env.MCP_SERVER_KEY;
  if (!expected) return true; // no key configured -> auth disabled (local/dev use)
  const header = event.headers.authorization || event.headers.Authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');
  return token === expected;
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === 'notifications/initialized' || (typeof method === 'string' && method.startsWith('notifications/'))) {
    return null; // notification, no response expected
  }

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    try {
      const result = await callTool(name, args || {});
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false });
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    // No resumable SSE stream offered — clients fall back to plain POST-per-request.
    return { statusCode: 405, headers: { Allow: 'POST' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Use POST' }) };
  }
  if (!isAuthorized(event)) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return jsonResponse(200, rpcError(null, -32700, 'Parse error'));
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const msg of messages) {
    const res = await handleMessage(msg);
    if (res) responses.push(res);
  }

  if (responses.length === 0) {
    return { statusCode: 202, body: '' };
  }
  return jsonResponse(200, Array.isArray(body) ? responses : responses[0]);
};
