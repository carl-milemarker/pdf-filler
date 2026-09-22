// Central, tenant-agnostic registry of {baseUrl, apiKey} per Milemarker tenant. Lives here
// (not in any per-tenant n8n workflow) because the DocuSign Connect completion webhook has
// no tenant context of its own -- it only carries an envelopeId, so the tenant has to be
// resolved from the envelope's own `milemarker_tenant_id` custom field, then looked up here.
// The create-submission path could derive this from a client-supplied tenant_id + a lookup
// here too, keeping tenant secrets in exactly one place instead of duplicated per n8n stub.
//
// TENANT_REGISTRY env var is a JSON object: { "<tenant_uuid>": { "baseUrl": "...", "apiKey": "..." } }

function loadRegistry() {
  const raw = process.env.TENANT_REGISTRY;
  if (!raw) {
    throw new Error('Missing TENANT_REGISTRY env var');
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`TENANT_REGISTRY is not valid JSON: ${err.message}`);
  }
}

function resolveTenant(tenantId) {
  const registry = loadRegistry();
  const entry = registry[tenantId];
  if (!entry || !entry.baseUrl || !entry.apiKey) {
    throw new Error(`Unknown or incomplete tenant registry entry for tenant_id: ${tenantId}`);
  }
  return entry;
}

module.exports = { resolveTenant };
