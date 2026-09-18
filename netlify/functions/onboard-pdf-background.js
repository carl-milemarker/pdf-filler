const { onboardPdf } = require('../../lib/onboard');
const { completeJob, failJob } = require('../../lib/job-store');

// Netlify Background Function (note the "-background" suffix in the filename — that's what
// tells Netlify to run this as one: the platform responds 202 to the caller immediately,
// without waiting for this code to run at all, then executes it for up to 15 minutes instead
// of the ~10-26s limit a normal synchronous Function gets. There is no way to return a result
// to the original caller from here — job-store.js is how the result gets published instead.

exports.handler = async (event) => {
  const payload = JSON.parse(event.body || '{}');
  const {
    job_record_id: jobRecordId,
    pdf_base64: pdfBase64,
    document_name: documentName,
    workflow_name: workflowName,
    workflow_description: workflowDescription,
  } = payload;

  const milemarkerConfig = {
    baseUrl: process.env.MILEMARKER_BASE_URL,
    apiKey: process.env.MILEMARKER_API_KEY,
    workflowTypeId: Number(process.env.MILEMARKER_WORKFLOW_TYPE_ID),
    workflowCategoryId: Number(process.env.MILEMARKER_WORKFLOW_CATEGORY_ID),
    workflowAccessLevels: process.env.MILEMARKER_WORKFLOW_ACCESS_LEVELS.split(',').map(Number),
    defaultAssignees: process.env.MILEMARKER_DEFAULT_ASSIGNEES.split(',').map(Number),
    n8nProjectionId: Number(process.env.MILEMARKER_N8N_PROJECTION_ID),
  };

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
      milemarker: milemarkerConfig,
    });
    await completeJob({ baseUrl: milemarkerConfig.baseUrl, apiKey: milemarkerConfig.apiKey, recordId: jobRecordId, result });
  } catch (err) {
    await failJob({
      baseUrl: milemarkerConfig.baseUrl,
      apiKey: milemarkerConfig.apiKey,
      recordId: jobRecordId,
      errorMessage: String(err && err.message ? err.message : err),
    });
  }
};
