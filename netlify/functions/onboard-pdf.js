const { startOnboarding } = require('../../lib/onboard-async');

// Starts onboarding as a Background Function job and returns almost immediately — the full
// pipeline routinely exceeds Netlify's synchronous Function execution limit (~10-26s), so this
// endpoint no longer runs it inline. Poll /.netlify/functions/check-onboarding-status?job_id=...
// for the result.

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

  try {
    const result = await startOnboarding({
      pdfBase64: payload.pdf_base64,
      documentName: payload.document_name,
      workflowName: payload.workflow_name,
      workflowDescription: payload.workflow_description,
      siteUrl: process.env.URL,
    });
    return {
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: result.jobId, status: result.status, message: result.message }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Failed to start onboarding job', detail: String(err && err.message ? err.message : err) }),
    };
  }
};
