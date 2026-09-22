const { processSubmission } = require('../../lib/submission-processor');

// Called by each tenant's tiny n8n "stub" workflow (webhook -> one HTTP Request here) right
// after a Milemarker workflow request is created. Body: { tenant_id, webhook_body } where
// webhook_body is the raw Milemarker create-trigger payload passed straight through from n8n.
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

  const { tenant_id: tenantId, webhook_body: webhookBody, test_mode: testMode } = payload;
  if (!tenantId || !webhookBody) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Required: tenant_id, webhook_body' }) };
  }

  try {
    const result = await processSubmission({ tenantId, webhookBody, testMode: !!testMode });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
  }
};
