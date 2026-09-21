const { getAccessToken } = require('../../lib/docusign-auth');
const { removeTab } = require('../../lib/docusign-template');

// Removes one previously-placed tab by tabId — the undo for add-field-tab. Needed when
// anchor_string matches more than one place in the document (a boilerplate sentence
// repeated on two pages, say) — add-field-tab places a tab at EVERY match.

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

  const { template_id: templateId, tab_id: tabId, tab_type: tabType, recipient_id: recipientId } = payload;

  if (!templateId || !tabId || !tabType) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Required: template_id, tab_id, tab_type' }) };
  }

  const requiredEnv = ['DOCUSIGN_ACCOUNT_ID', 'DOCUSIGN_API_BASE_URL'];
  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length) {
    return { statusCode: 500, body: JSON.stringify({ error: `Missing env vars: ${missing.join(', ')}` }) };
  }

  try {
    const { accessToken } = await getAccessToken();
    const result = await removeTab({
      accessToken,
      accountId: process.env.DOCUSIGN_ACCOUNT_ID,
      apiBase: process.env.DOCUSIGN_API_BASE_URL,
      templateId,
      recipientId: recipientId || '1',
      tabId,
      tabType,
    });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Failed to remove tab', detail: String(err && err.message ? err.message : err) }),
    };
  }
};
