// Tenant-generic "a Milemarker workflow request was submitted -> create the matching DocuSign
// envelope" pipeline. This replaces the n8n Code-node chain that used to live only inside
// n8n (Normalize Fields / Build Envelope Tabs / Resolve Client Identity / the JWT-signing
// chain / Create Envelope / Attach Confirmation) -- ported here because n8n workflows are
// isolated per Milemarker tenant's own n8n project (confirmed live: a second tenant's
// generated n8n workflow is invisible to another tenant's n8n API key), so genuine
// cross-tenant sharing of this logic is only possible outside n8n. Each tenant's n8n
// workflow is now just a thin stub: webhook -> one HTTP call into this endpoint.
const { getAccessToken } = require('./docusign-auth');
const { resolveTenant } = require('./tenant-registry');

function unwrapField(field) {
  if (!field) return null;
  const v = field.field_value;
  return v && typeof v === 'object' && 'value' in v ? v.value : v;
}

function normalizeFields(webhookBody) {
  const request = webhookBody?.request ?? {};
  const submitter = webhookBody?.submitted_by_user ?? webhookBody?.user ?? {};
  const fields = {};
  for (const [key, field] of Object.entries(request)) {
    fields[key] = { type: field?.field_type || 'text', value: unwrapField(field) };
  }
  return { workflowRequestId: webhookBody.workflow_request_id ?? null, fields, submitter };
}

function resolveClientIdentity({ mapping, fields, submitter }) {
  const nameKeys = (mapping.client_name_field_keys || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const formFullName = nameKeys
    .map((k) => fields[k]?.value)
    .filter(Boolean)
    .join(' ')
    .trim();
  const emailKey = mapping.client_email_field_key;
  const formEmail = (emailKey && fields[emailKey]?.value ? fields[emailKey].value : '').toString().trim();
  const signerEmail = formEmail || submitter.email || null;
  const signerName = formFullName || `${submitter.first_name || ''} ${submitter.last_name || ''}`.trim() || 'Signer';
  return { signerName, signerEmail };
}

/**
 * Turns normalized fields into DocuSign envelope tabs, keyed generically off the mapping
 * record's config rather than any per-document hardcoding:
 * - list_field_row_caps: {fieldKey: maxRows} -- positional repeaters (row N -> tabLabel
 *   `${fieldKey}_${N}_${subKey}`), capped at the PDF's fixed printed row count. Extra
 *   submitted rows beyond the cap are simply not printed (still saved in Milemarker itself).
 * - list_field_row_keys: {fieldKey: {key_field, slots: [...]}} -- keyed repeaters, where a
 *   row's slot is chosen by matching `row[key_field]` against `slots` (e.g. other_contacts'
 *   `contact_role` picks which of the PDF's 3 named contact blocks a row fills), not by
 *   array position.
 * - checkbox_style_select_fields: comma-separated field keys where a Milemarker
 *   radiogroup/select was represented on the PDF as independent checkboxes rather than a
 *   real single grouped radio widget (tabLabel `${key}__${value}`, one per option) --
 *   otherwise radiogroup/select fields use a true DocuSign radioGroupTabs value set.
 */
function buildEnvelopeTabs(fields, mapping) {
  const rowCaps = mapping.list_field_row_caps ? JSON.parse(mapping.list_field_row_caps) : {};
  const rowKeys = mapping.list_field_row_keys ? JSON.parse(mapping.list_field_row_keys) : {};
  const checkboxStyleFields = new Set(
    (mapping.checkbox_style_select_fields || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const textTabs = [];
  const checkboxTabs = [];
  const radioGroupTabs = [];

  const emitFlat = (key, f) => {
    if (f.value === null || f.value === undefined || f.value === '') return;
    if (f.type === 'checkbox') {
      // DocuSign checkboxTabs use `selected`, not `value` -- sending `value` doesn't error,
      // it silently reinterprets the tab (observed live: it renamed the matched template tab
      // from "entity_econsent" to "entity_econsent__true" instead of checking it).
      checkboxTabs.push({ tabLabel: key, selected: f.value ? 'true' : 'false' });
    } else if (f.type === 'checkboxgroup' && Array.isArray(f.value)) {
      for (const v of f.value) {
        checkboxTabs.push({ tabLabel: `${key}__${v}`, selected: 'true' });
      }
    } else if ((f.type === 'radiogroup' || f.type === 'select') && checkboxStyleFields.has(key)) {
      checkboxTabs.push({ tabLabel: `${key}__${f.value}`, selected: 'true' });
    } else if (f.type === 'radiogroup' || f.type === 'select') {
      // A top-level {groupName, value} shorthand does NOT pre-select the radio on envelope
      // creation from a template (observed live: the group came back with value:"" and every
      // radio unselected) -- DocuSign needs the specific radio marked selected explicitly.
      radioGroupTabs.push({ groupName: key, radios: [{ value: String(f.value), selected: 'true' }] });
    } else {
      textTabs.push({ tabLabel: key, value: String(f.value) });
    }
  };

  for (const [key, f] of Object.entries(fields)) {
    if (f.type === 'list' && Array.isArray(f.value)) {
      if (rowKeys[key]) {
        const { key_field: keyField, slots } = rowKeys[key];
        for (const row of f.value) {
          const idx = slots.indexOf(row[keyField]);
          if (idx === -1) continue;
          const slotLabel = slots[idx];
          for (const [subKey, subVal] of Object.entries(row)) {
            if (subKey === keyField) continue;
            emitFlat(`${key}_${slotLabel}_${subKey}`, { type: 'text', value: subVal });
          }
        }
      } else if (rowCaps[key]) {
        f.value.slice(0, rowCaps[key]).forEach((row, i) => {
          for (const [subKey, subVal] of Object.entries(row)) {
            emitFlat(`${key}_${i + 1}_${subKey}`, { type: 'text', value: subVal });
          }
        });
      }
      continue;
    }
    emitFlat(key, f);
  }

  return { textTabs, checkboxTabs, radioGroupTabs };
}

async function getWorkflowRequest({ baseUrl, apiKey, workflowRequestId }) {
  const res = await fetch(`${baseUrl}/workflow-requests/${workflowRequestId}`, {
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Get workflow request failed: ${res.status} ${JSON.stringify(body)}`);
  return body.data || body;
}

async function getDocumentMapping({ baseUrl, apiKey, workflowId }) {
  const url = `${baseUrl}/custom-objects/docusign_onboarded_documents/records?filters%5Bmilemarker_workflow_id%5D=${workflowId}&per_page=1`;
  const res = await fetch(url, { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' } });
  const body = await res.json();
  if (!res.ok) throw new Error(`Get document mapping failed: ${res.status} ${JSON.stringify(body)}`);
  const rows = body.data || body;
  if (!rows || !rows[0]) throw new Error(`No docusign_onboarded_documents mapping found for workflow_id ${workflowId}`);
  return rows[0];
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

/**
 * Main entry point: given a tenant_id (resolved to {baseUrl, apiKey} via the tenant
 * registry) and the raw Milemarker webhook payload, creates the DocuSign envelope and
 * attaches a confirmation message back to the originating request.
 */
async function processSubmission({ tenantId, webhookBody, testMode = false }) {
  const { baseUrl, apiKey } = resolveTenant(tenantId);
  const { workflowRequestId, fields, submitter } = normalizeFields(webhookBody);
  if (!workflowRequestId) throw new Error('webhook payload missing workflow_request_id');

  const workflowRequest = await getWorkflowRequest({ baseUrl, apiKey, workflowRequestId });
  const workflowId = workflowRequest.workflow_id;
  const mapping = await getDocumentMapping({ baseUrl, apiKey, workflowId });

  const { signerName, signerEmail } = resolveClientIdentity({ mapping, fields, submitter });
  const { textTabs, checkboxTabs, radioGroupTabs } = buildEnvelopeTabs(fields, mapping);

  const { accessToken } = await getAccessToken();
  const accountId = process.env.DOCUSIGN_ACCOUNT_ID;
  const apiBase = process.env.DOCUSIGN_API_BASE_URL;

  const isTwoSigner = Number(mapping.signer_count) === 2;
  const delayDays = mapping.advisor_notify_delay_days === null || mapping.advisor_notify_delay_days === undefined
    ? 0
    : Number(mapping.advisor_notify_delay_days);
  const shouldDelay = !testMode && isTwoSigner && delayDays > 0;
  const status = testMode ? 'created' : shouldDelay ? 'created' : 'sent';
  const workflowField = shouldDelay
    ? { scheduledSending: { resumeDate: new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000).toISOString() } }
    : undefined;

  const envelopePayload = {
    templateId: mapping.docusign_template_id,
    status,
    emailSubject: `Please sign: ${mapping.document_name || 'Your document'}`,
    customFields: {
      textCustomFields: [
        { name: 'milemarker_workflow_request_id', value: String(workflowRequestId), show: 'false', required: 'false' },
        { name: 'milemarker_tenant_id', value: tenantId, show: 'false', required: 'false' },
      ],
    },
    ...(workflowField ? { workflow: workflowField } : {}),
    templateRoles: [
      ...(isTwoSigner
        ? [
            {
              roleName: 'Advisor',
              recipientId: String(mapping.advisor_recipient_id),
              name: mapping.advisor_display_name || 'Advisor',
              email: 'connect@milemarker.co',
            },
          ]
        : []),
      {
        roleName: 'Signer 1',
        recipientId: '1',
        name: signerName,
        email: signerEmail,
        tabs: { textTabs, checkboxTabs, radioGroupTabs },
      },
    ],
  };

  const envRes = await fetch(`${apiBase}/v2.1/accounts/${accountId}/envelopes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(envelopePayload),
  });
  const envBody = await envRes.json();
  if (!envRes.ok) throw new Error(`Create envelope failed: ${envRes.status} ${JSON.stringify(envBody)}`);

  // Fetch the (possibly pre-filled) document and attach a confirmation message back to the
  // originating Milemarker request.
  const docRes = await fetch(
    `${apiBase}/v2.1/accounts/${accountId}/envelopes/${envBody.envelopeId}/documents/combined`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (docRes.ok) {
    const fileBuffer = Buffer.from(await docRes.arrayBuffer());
    await attachMessage({
      baseUrl,
      apiKey,
      workflowRequestId,
      message: `DocuSign envelope created and emailed to the signer: ${envBody.envelopeId} — status: ${envBody.status}. You'll receive a completed, filled document here automatically once the recipient signs.`,
      fileBuffer,
      fileName: `${mapping.document_name || 'document'}.pdf`,
    });
  }

  return { envelopeId: envBody.envelopeId, status: envBody.status, workflowRequestId, workflowId };
}

module.exports = { processSubmission, normalizeFields, resolveClientIdentity, buildEnvelopeTabs };
