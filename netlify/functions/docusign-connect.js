const { processConnectEvent } = require('../../lib/connect-processor');

// DocuSign Connect completion webhook target -- one shared subscription on the shared
// DocuSign account covers every tenant's envelopes; the tenant is resolved per-envelope from
// its own milemarker_tenant_id custom field (see lib/connect-processor.js).
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Use POST' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Body must be JSON' }) };
  }

  try {
    const result = await processConnectEvent({ webhookBody: payload });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
  }
};
