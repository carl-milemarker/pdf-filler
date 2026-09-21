const crypto = require('crypto');

// Milemarker's Form `schema`/`form` fields are stored double-encoded — the
// backend does json_encode(json_encode($schema)) on save. GET/PUT both hand
// back and expect a JSON *string* (confirmed by reading a real, live form
// via the raw REST API this session, not just the MCP wrapper's behavior) —
// so POST /forms needs the same: schema/form passed as pre-stringified JSON.

const MILEMARKER_FIELD_TYPE = { text: 'text', checkbox: 'checkbox' };

/**
 * Builds a Milemarker VueForm schema from mapped fields (output of
 * field-mapping.js#mapFields) — one field per detected PDF field, all of
 * them, matching the "auto-create every extracted field" decision made this
 * session (no filtering step).
 */
function buildFormSchema(mappedFields) {
  const schema = {};
  for (const f of mappedFields) {
    const type = MILEMARKER_FIELD_TYPE[f.tabType];
    if (!type) continue; // only text/checkbox map to a Milemarker form field type today
    schema[f.tabLabel] = {
      name: f.tabLabel,
      type,
      label: f.label,
      builder: { type, label: type === 'text' ? 'Text input' : 'Checkbox' },
    };
  }
  return schema;
}

async function createForm({ baseUrl, apiKey, name, description, schema }) {
  const res = await fetch(`${baseUrl}/forms`, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      name,
      status: 'active',
      description,
      // POST /forms (create) wants schema/form as real JSON objects — unlike
      // PUT /forms/{id}/update, which needs them pre-stringified (Milemarker
      // stores them double-encoded, but only re-encodes on the update path).
      // Confirmed by the API's own 422 when this was sent as a string:
      // "The schema field must be an array."
      schema,
      form: {},
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Milemarker form creation failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.data || body;
}

async function createWorkflow({ baseUrl, apiKey, name, description, icon, formId, workflowTypeId, workflowCategoryId, workflowAccessLevels, defaultAssignees, status = 'draft', releaseStatus = 'development' }) {
  const res = await fetch(`${baseUrl}/workflows`, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      name,
      icon,
      description,
      form_id: formId,
      workflow_type_id: workflowTypeId,
      workflow_category_id: workflowCategoryId,
      workflow_access_levels: workflowAccessLevels,
      default_assignees: defaultAssignees,
      status,
      release_status: releaseStatus,
      published_at: new Date().toISOString(),
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Milemarker workflow creation failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.data || body;
}

// Attaches the create-trigger for a newly-onboarded workflow to the SAME shared n8n
// projection every onboarded document uses (see workflow-projection-setup/spec: attach
// takes an existing `workflow_n8n_projection_id`, not a new one) — this is what keeps
// n8n-workflow sprawl from happening: one "FLATIRON | Generic Doc Onboarding" n8n
// workflow serves every onboarded document, distinguished only by which Milemarker
// workflow triggered it (resolved via the custom-object mapping store at runtime).
async function attachN8nProjection({ baseUrl, apiKey, workflowId, projectionId, triggerAction = 'create' }) {
  const res = await fetch(`${baseUrl}/workflows/${workflowId}/projections`, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      workflow_n8n_projection_id: projectionId,
      trigger_action: triggerAction,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`n8n projection attach failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.data || body;
}

// Writes the document-identity mapping record the generic n8n workflow looks up by
// `milemarker_workflow_id` to resolve which DocuSign template to use per submission.
// Must be created with the SAME X-Api-Key identity that will later query it — Milemarker
// custom object records are per-user siloed by `created_by`, and this API key is exactly
// the identity n8n's lookup step authenticates as (a real bug hit and fixed by hand this
// session: the tenant MCP server's own tool owns records as a different, fixed identity).
// signerCount/advisorRecipientId/advisorTabsPlaced are new, optional fields for
// multi-recipient (e.g. Advisor + Client) templates — default to single-signer values so
// onboard.js's existing call site (which never passes them) is unaffected. Kept alongside
// signature_tabs_placed rather than renaming/replacing it, to avoid migrating existing rows.
async function createDocumentMapping({ baseUrl, apiKey, workflowId, templateId, pdfSha256, documentName, onboardedBy, signatureTabsPlaced = false, signerCount = 1, advisorRecipientId, advisorTabsPlaced }) {
  const res = await fetch(`${baseUrl}/custom-objects/docusign_onboarded_documents/records`, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      milemarker_workflow_id: workflowId,
      docusign_template_id: templateId,
      pdf_sha256: pdfSha256,
      document_name: documentName,
      signature_tabs_placed: signatureTabsPlaced,
      onboarded_by: onboardedBy,
      signer_count: signerCount,
      advisor_recipient_id: advisorRecipientId,
      advisor_tabs_placed: advisorTabsPlaced,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Document mapping record creation failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.data || body;
}

// Partial update of an existing mapping record (e.g. once signature tabs get placed after
// the fact) — Milemarker custom-object records use PUT for updates, and it's a merge, not a
// full-document replace (confirmed live this session via job-store.js's identical pattern).
async function updateDocumentMapping({ baseUrl, apiKey, recordId, updates }) {
  const res = await fetch(`${baseUrl}/custom-objects/docusign_onboarded_documents/records/${recordId}`, {
    method: 'PUT',
    headers: {
      'X-Api-Key': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Document mapping record update failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.data || body;
}

module.exports = { buildFormSchema, createForm, createWorkflow, attachN8nProjection, createDocumentMapping, updateDocumentMapping };
