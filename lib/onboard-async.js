const crypto = require('crypto');
const { createTemplateFromPdf } = require('./onboard');
const { createJob, getJobByJobId } = require('./job-store');

const REQUIRED_ENV = [
  'DOCUSIGN_ACCOUNT_ID', 'DOCUSIGN_API_BASE_URL',
  'MILEMARKER_BASE_URL', 'MILEMARKER_API_KEY',
  'MILEMARKER_WORKFLOW_TYPE_ID', 'MILEMARKER_WORKFLOW_CATEGORY_ID',
  'MILEMARKER_WORKFLOW_ACCESS_LEVELS', 'MILEMARKER_DEFAULT_ASSIGNEES',
  'MILEMARKER_N8N_PROJECTION_ID',
];

function checkRequiredEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(', ')}`);
  }
}

// Runs phase 1 (DocuSign Template creation — the only step that needs the raw PDF bytes)
// synchronously here, then hands off phase 2 (Milemarker Form/Workflow, n8n attach, mapping
// record — none of which need the PDF bytes, only the small `mappedFields` array) to a
// Background Function job. This split exists because of two constraints discovered live:
// (1) the full 7+-step pipeline routinely exceeds Netlify's synchronous Function execution
// limit (~10-26s) for a real multi-MB PDF; (2) Background Function invocations have their own,
// much smaller payload cap that a multi-MB base64 PDF blows straight through even on its own
// (confirmed directly — not just as a function-to-function hop problem). Keeping phase 1
// synchronous means the PDF bytes never have to be re-transmitted anywhere after the original
// request, sidestepping the payload-cap problem entirely; phase 2's payload is always small.
async function startOnboarding({ pdfBase64, documentName, workflowName, workflowDescription, siteUrl }) {
  checkRequiredEnv();
  if (!pdfBase64 || !documentName || !workflowName) {
    throw new Error('Required: pdf_base64, document_name, workflow_name');
  }
  if (!siteUrl) {
    throw new Error('Could not determine this site\'s own URL (process.env.URL) to invoke the background function');
  }

  const jobId = crypto.randomUUID();
  const jobRecord = await createJob({
    baseUrl: process.env.MILEMARKER_BASE_URL,
    apiKey: process.env.MILEMARKER_API_KEY,
    jobId,
    documentName,
    workflowName,
  });

  const phase1 = await createTemplateFromPdf({
    pdfBytes: Buffer.from(pdfBase64, 'base64'),
    documentName,
    workflowName,
    docusign: {
      accountId: process.env.DOCUSIGN_ACCOUNT_ID,
      apiBase: process.env.DOCUSIGN_API_BASE_URL,
    },
  });

  // Fire the background function for phase 2. Awaited only long enough for Netlify's edge to
  // accept it (a background function ACKs near-instantly) — phase 2 keeps running after this
  // function returns. Payload here is small (mappedFields, not the PDF), well under any cap.
  const res = await fetch(`${siteUrl}/.netlify/functions/onboard-pdf-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_record_id: jobRecord.id,
      template_id: phase1.templateId,
      mapped_fields: phase1.mappedFields,
      field_count: phase1.fieldCount,
      by_type: phase1.byType,
      pdf_sha256: phase1.pdfSha256,
      document_name: documentName,
      workflow_name: workflowName,
      workflow_description: workflowDescription,
    }),
  });
  if (!res.ok && res.status !== 202) {
    throw new Error(`Failed to start background onboarding job (phase 2): ${res.status} ${await res.text()}`);
  }

  return {
    jobId,
    status: 'pending',
    templateId: phase1.templateId,
    fieldCount: phase1.fieldCount,
    message: 'DocuSign Template created. Milemarker Workflow/Form + n8n wiring started in the background — poll check_onboarding_status(job_id) for the final result.',
  };
}

async function checkOnboardingStatus({ jobId }) {
  checkRequiredEnv();
  if (!jobId) {
    throw new Error('Required: job_id');
  }
  const record = await getJobByJobId({ baseUrl: process.env.MILEMARKER_BASE_URL, apiKey: process.env.MILEMARKER_API_KEY, jobId });
  return {
    jobId: record.job_id,
    status: record.status,
    documentName: record.document_name,
    workflowName: record.workflow_name,
    result: record.result ? JSON.parse(record.result) : null,
    errorMessage: record.error_message,
  };
}

module.exports = { startOnboarding, checkOnboardingStatus };
