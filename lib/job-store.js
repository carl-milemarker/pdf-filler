// Tracks async onboard_pdf jobs in the `docusign_onboarding_jobs` Milemarker custom object.
// Needed because the full onboarding pipeline (PDF parse, DocuSign template creation with a
// multi-MB upload, Milemarker Form + Workflow creation, n8n attach, mapping record) routinely
// exceeds Netlify's synchronous Function execution limit — so onboard-pdf-background.js runs
// the real work as a Background Function (up to 15 min) while this store lets the fast, normal
// "start" function and a separate "check status" call communicate about job progress.

async function createJob({ baseUrl, apiKey, jobId, documentName, workflowName }) {
  const res = await fetch(`${baseUrl}/custom-objects/docusign_onboarding_jobs/records`, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, status: 'pending', document_name: documentName, workflow_name: workflowName }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Job record creation failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.data || body;
}

async function completeJob({ baseUrl, apiKey, recordId, result }) {
  const res = await fetch(`${baseUrl}/custom-objects/docusign_onboarding_jobs/records/${recordId}`, {
    method: 'PUT',
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'success', result: JSON.stringify(result) }),
  });
  if (!res.ok) {
    throw new Error(`Job record update (success) failed: ${res.status} ${await res.text()}`);
  }
}

async function failJob({ baseUrl, apiKey, recordId, errorMessage }) {
  const res = await fetch(`${baseUrl}/custom-objects/docusign_onboarding_jobs/records/${recordId}`, {
    method: 'PUT',
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'error', error_message: errorMessage }),
  });
  if (!res.ok) {
    throw new Error(`Job record update (error) failed: ${res.status} ${await res.text()}`);
  }
}

async function getJobByJobId({ baseUrl, apiKey, jobId }) {
  const url = `${baseUrl}/custom-objects/docusign_onboarding_jobs/records?filters%5Bjob_id%5D=${encodeURIComponent(jobId)}&per_page=1`;
  const res = await fetch(url, { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' } });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Job lookup failed: ${res.status} ${JSON.stringify(body)}`);
  }
  const record = (body.data || [])[0];
  if (!record) {
    throw new Error(`No job found with job_id ${jobId}`);
  }
  return record;
}

module.exports = { createJob, completeJob, failJob, getJobByJobId };
