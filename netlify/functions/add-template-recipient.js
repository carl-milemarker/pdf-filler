const { getAccessToken } = require('../../lib/docusign-auth');
const { setTemplateRecipients } = require('../../lib/docusign-template');

// Adds a second (or further) signing recipient to an existing template that onboard_pdf
// created with only the implicit "Signer 1"/recipientId "1" role, and sets explicit
// routingOrder on ALL recipients so DocuSign enforces signing order natively (e.g. an
// Advisor signs first, then the Client — DocuSign withholds a later routingOrder
// recipient's copy until every earlier routingOrder recipient completes).

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

  const {
    template_id: templateId,
    new_recipient_id: newRecipientId,
    new_role_name: newRoleName,
    new_routing_order: newRoutingOrder,
    existing_recipient_id: existingRecipientId,
    existing_role_name: existingRoleName,
    existing_routing_order: existingRoutingOrder,
  } = payload;

  if (!templateId || !newRecipientId || !newRoleName || newRoutingOrder === undefined || existingRoutingOrder === undefined) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Required: template_id, new_recipient_id, new_role_name, new_routing_order, existing_routing_order' }),
    };
  }

  const requiredEnv = ['DOCUSIGN_ACCOUNT_ID', 'DOCUSIGN_API_BASE_URL'];
  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length) {
    return { statusCode: 500, body: JSON.stringify({ error: `Missing env vars: ${missing.join(', ')}` }) };
  }

  try {
    const { accessToken } = await getAccessToken();
    const result = await setTemplateRecipients({
      accessToken,
      accountId: process.env.DOCUSIGN_ACCOUNT_ID,
      apiBase: process.env.DOCUSIGN_API_BASE_URL,
      templateId,
      signers: [
        {
          recipientId: existingRecipientId || '1',
          roleName: existingRoleName || 'Signer 1',
          routingOrder: existingRoutingOrder,
        },
        {
          recipientId: newRecipientId,
          roleName: newRoleName,
          routingOrder: newRoutingOrder,
        },
      ],
    });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Failed to add template recipient', detail: String(err && err.message ? err.message : err) }),
    };
  }
};
