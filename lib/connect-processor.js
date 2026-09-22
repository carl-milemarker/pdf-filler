// Tenant-generic handler for DocuSign Connect completion events. One shared DocuSign
// account (per the decision to reuse Flatiron's DocuSign account for every tenant) means one
// Connect subscription receives events for every tenant's envelopes -- the tenant has to be
// resolved from the envelope's own `milemarker_tenant_id` custom field (set at creation time
// in submission-processor.js), then looked up via the tenant registry, since the Connect
// payload itself carries only an envelopeId with no Milemarker tenant context at all.
const { getAccessToken } = require('./docusign-auth');
const { resolveTenant } = require('./tenant-registry');

function parseConnectPayload(body) {
  const data = body?.data || body;
  const envelopeId = data?.envelopeId || data?.envelopeSummary?.envelopeId;
  const status = (data?.envelopeSummary?.status || body?.event || '').toString().toLowerCase();
  if (!envelopeId) throw new Error('DocuSign Connect payload missing envelopeId');
  return { envelopeId, connectStatus: status };
}

async function getEnvelopeCustomFields({ accessToken, accountId, apiBase, envelopeId }) {
  const res = await fetch(`${apiBase}/v2.1/accounts/${accountId}/envelopes/${envelopeId}/custom_fields`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Get envelope custom fields failed: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

function extractCustomField(customFields, name) {
  const match = (customFields.textCustomFields || []).find((f) => f.name === name);
  return match ? match.value : null;
}

async function attachMessage({ baseUrl, apiKey, workflowRequestId, message, fileBuffer, fileName }) {
  const form = new FormData();
  form.append('message', message);
  form.append('attachments[]', new Blob([fileBuffer], { type: 'application/pdf' }), fileName || 'document.pdf');
  const res = await fetch(`${baseUrl}/workflow-requests/${workflowRequestId}/messages`, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Attach message failed: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function processConnectEvent({ webhookBody }) {
  const { envelopeId, connectStatus } = parseConnectPayload(webhookBody);

  const accountId = process.env.DOCUSIGN_ACCOUNT_ID;
  const apiBase = process.env.DOCUSIGN_API_BASE_URL;
  const { accessToken } = await getAccessToken();

  const customFields = await getEnvelopeCustomFields({ accessToken, accountId, apiBase, envelopeId });
  const workflowRequestId = extractCustomField(customFields, 'milemarker_workflow_request_id');
  const tenantId = extractCustomField(customFields, 'milemarker_tenant_id');
  if (!workflowRequestId) throw new Error(`milemarker_workflow_request_id custom field not found on envelope ${envelopeId}`);
  if (!tenantId) throw new Error(`milemarker_tenant_id custom field not found on envelope ${envelopeId}`);

  const { baseUrl, apiKey } = resolveTenant(tenantId);

  // Only attach the completed document once the envelope has actually finished signing --
  // Connect also fires for intermediate statuses (sent, delivered) that we don't act on.
  if (connectStatus !== 'completed') {
    return { envelopeId, connectStatus, skipped: true };
  }

  const docRes = await fetch(`${apiBase}/v2.1/accounts/${accountId}/envelopes/${envelopeId}/documents/combined`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!docRes.ok) throw new Error(`Get completed document failed: ${docRes.status}`);
  const fileBuffer = Buffer.from(await docRes.arrayBuffer());

  await attachMessage({
    baseUrl,
    apiKey,
    workflowRequestId,
    message: `DocuSign envelope completed — filled document attached (envelope ${envelopeId}).`,
    fileBuffer,
    fileName: 'completed-document.pdf',
  });

  return { envelopeId, connectStatus, workflowRequestId, tenantId, attached: true };
}

module.exports = { processConnectEvent, parseConnectPayload };
