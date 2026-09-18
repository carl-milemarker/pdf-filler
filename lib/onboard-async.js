const crypto = require('crypto');
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

// Kicks off onboarding as a Background Function job instead of running the pipeline inline —
// the full pipeline (PDF parse, DocuSign Template creation with a multi-MB upload, Milemarker
// Form + Workflow creation, n8n attach, mapping record) routinely exceeds the ~10-26s limit a
// normal synchronous Netlify Function gets. Returns almost immediately with a job_id to poll
// via checkOnboardingStatus.
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

  // Fire the background function. Awaited only long enough for Netlify's edge to accept it
  // (a background function ACKs near-instantly) — the actual pipeline keeps running after
  // this function returns.
  const res = await fetch(`${siteUrl}/.netlify/functions/onboard-pdf-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_record_id: jobRecord.id,
      pdf_base64: pdfBase64,
      document_name: documentName,
      workflow_name: workflowName,
      workflow_description: workflowDescription,
    }),
  });
  if (!res.ok && res.status !== 202) {
    throw new Error(`Failed to start background onboarding job: ${res.status} ${await res.text()}`);
  }

  return {
    jobId,
    status: 'pending',
    message: 'Onboarding started in the background. Poll with check_onboarding_status(job_id) — the full pipeline (PDF extraction, DocuSign Template creation, Milemarker Form/Workflow, n8n wiring, mapping record) typically takes well under a minute but can run up to several minutes for large PDFs.',
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
