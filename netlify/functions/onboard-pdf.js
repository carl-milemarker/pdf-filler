const { onboardPdf } = require('../../lib/onboard');

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

  const { pdf_base64: pdfBase64, document_name: documentName, workflow_name: workflowName, workflow_description: workflowDescription } = payload;
  if (!pdfBase64 || !documentName || !workflowName) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Required: pdf_base64, document_name, workflow_name' }),
    };
  }

  const requiredEnv = [
    'DOCUSIGN_ACCOUNT_ID', 'DOCUSIGN_API_BASE_URL',
    'MILEMARKER_BASE_URL', 'MILEMARKER_API_KEY',
    'MILEMARKER_WORKFLOW_TYPE_ID', 'MILEMARKER_WORKFLOW_CATEGORY_ID',
    'MILEMARKER_WORKFLOW_ACCESS_LEVELS', 'MILEMARKER_DEFAULT_ASSIGNEES',
    'MILEMARKER_N8N_PROJECTION_ID',
  ];
  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length) {
    return { statusCode: 500, body: JSON.stringify({ error: `Missing env vars: ${missing.join(', ')}` }) };
  }

  try {
    const result = await onboardPdf({
      pdfBytes: Buffer.from(pdfBase64, 'base64'),
      documentName,
      workflowName,
      workflowDescription,
      docusign: {
        accountId: process.env.DOCUSIGN_ACCOUNT_ID,
        apiBase: process.env.DOCUSIGN_API_BASE_URL,
      },
      milemarker: {
        baseUrl: process.env.MILEMARKER_BASE_URL,
        apiKey: process.env.MILEMARKER_API_KEY,
        workflowTypeId: Number(process.env.MILEMARKER_WORKFLOW_TYPE_ID),
        workflowCategoryId: Number(process.env.MILEMARKER_WORKFLOW_CATEGORY_ID),
        workflowAccessLevels: process.env.MILEMARKER_WORKFLOW_ACCESS_LEVELS.split(',').map(Number),
        defaultAssignees: process.env.MILEMARKER_DEFAULT_ASSIGNEES.split(',').map(Number),
        n8nProjectionId: Number(process.env.MILEMARKER_N8N_PROJECTION_ID),
      },
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Onboarding pipeline failed', detail: String(err && err.message ? err.message : err) }),
    };
  }
};
