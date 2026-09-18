const { getStore } = require('@netlify/blobs');
const { onboardPdf } = require('../../lib/onboard');
const { completeJob, failJob } = require('../../lib/job-store');

const PDF_BLOB_STORE = 'onboard-pdf-pending';

// Netlify Background Function (note the "-background" suffix in the filename — that's what
// tells Netlify to run this as one: the platform responds 202 to the caller immediately,
// without waiting for this code to run at all, then executes it for up to 15 minutes instead
// of the ~10-26s limit a normal synchronous Function gets. There is no way to return a result
// to the original caller from here — job-store.js is how the result gets published instead.
//
// The PDF bytes are NOT in this invocation's own payload — Background Function invocations
// have a much smaller body-size cap than regular synchronous Functions (confirmed live: a
// ~4MB base64 PDF got a 413 even hitting this function directly), so lib/onboard-async.js
// stashes them in a Netlify Blob keyed by job id instead, and this function reads them back.

exports.handler = async (event) => {
  const payload = JSON.parse(event.body || '{}');
  const {
    job_record_id: jobRecordId,
    pdf_blob_key: pdfBlobKey,
    document_name: documentName,
    workflow_name: workflowName,
    workflow_description: workflowDescription,
  } = payload;

  const blobStore = getStore(PDF_BLOB_STORE);
  const pdfBase64 = await blobStore.get(pdfBlobKey);

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
  } finally {
    await blobStore.delete(pdfBlobKey).catch(() => {});
  }
};
