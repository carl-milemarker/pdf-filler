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
      schema: JSON.stringify(schema),
      form: '{}',
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

module.exports = { buildFormSchema, createForm, createWorkflow };
