const { createWorkflowForTemplate } = require('../../lib/onboard');
const { completeJob, failJob } = require('../../lib/job-store');

// Netlify Background Function (note the "-background" suffix in the filename — that's what
// tells Netlify to run this as one: the platform responds 202 to the caller immediately,
// without waiting for this code to run at all, then executes it for up to 15 minutes instead
// of the ~10-26s limit a normal synchronous Function gets. There is no way to return a result
// to the original caller from here — job-store.js is how the result gets published instead.
//
// This only runs phase 2 (lib/onboard.js#createWorkflowForTemplate) — Milemarker Form/Workflow
// creation, the n8n attach, the mapping record. Phase 1 (DocuSign Template creation, the only
// step that needs the PDF's raw bytes) already ran synchronously in onboard-pdf.js before this
// was invoked — a real constraint discovered live: Background Function invocations have their
// own payload cap far too small for a multi-MB PDF, smaller even than a regular synchronous
// Function's, so the PDF bytes must never need to travel into this invocation's payload at all.

exports.handler = async (event) => {
  const payload = JSON.parse(event.body || '{}');
  const {
    job_record_id: jobRecordId,
    template_id: templateId,
    mapped_fields: mappedFields,
    field_count: fieldCount,
    by_type: byType,
    pdf_sha256: pdfSha256,
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
    const result = await createWorkflowForTemplate({
      templateId,
      mappedFields,
      fieldCount,
      byType,
      pdfSha256,
      documentName,
      workflowName,
      workflowDescription,
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
