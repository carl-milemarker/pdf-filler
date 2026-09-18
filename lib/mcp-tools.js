const { extractFields } = require('./extract-fields');
const { getAccessToken } = require('./docusign-auth');
const { addAnchoredTab, addCoordinateTab } = require('./docusign-template');
const { onboardPdf } = require('./onboard');

// Tool definitions exposed over MCP, and their dispatch — thin wrappers around the same
// lib/*.js functions the plain-HTTP Netlify functions already call, so onboard-pdf.js,
// add-field-tab.js and extract-fields.js and this MCP layer share one implementation.

const TOOLS = [
  {
    name: 'onboard_pdf',
    description:
      "Onboard a PDF into a brand-new Milemarker Workflow + Form, paired with a matching DocuSign Template, fully wired end to end. " +
      'Extracts every native form field from the PDF, creates a Milemarker Form with one field per extracted PDF field, ' +
      'creates a DocuSign Template with a matching tab per field (tabLabel == Milemarker field key), creates the Milemarker ' +
      'Workflow that binds them, attaches its create-trigger to the shared n8n automation (no new n8n workflow — one n8n workflow ' +
      'serves every onboarded document), and writes the document-identity mapping record that n8n uses to resolve which template ' +
      'to use at submit time. No manual n8n or mapping-store step needed after this call. ' +
      'The new Workflow is created as a draft — two things are still left to a human: (1) signature/initial/date tabs are NOT ' +
      'auto-detected, use add_field_tab afterward to place those (and any other missed field) conversationally, e.g. "add a ' +
      'signature at the bottom of the birthday field"; (2) publish the Workflow once those tabs are confirmed placed, so an ' +
      'unsignable document can\'t be submitted by a real client in the meantime.',
    inputSchema: {
      type: 'object',
      properties: {
        pdf_base64: { type: 'string', description: 'Base64-encoded PDF bytes.' },
        document_name: { type: 'string', description: 'Human-readable name of the source document, e.g. "Charles Schwab IRA Account Application".' },
        workflow_name: { type: 'string', description: 'Name for the new Milemarker Workflow + Form.' },
        workflow_description: { type: 'string', description: 'Optional description for the new Workflow.' },
      },
      required: ['pdf_base64', 'document_name', 'workflow_name'],
    },
  },
  {
    name: 'extract_fields',
    description:
      'Extract every native AcroForm field from a PDF (page, position, type, name) without creating anything. ' +
      'Useful to preview what onboard_pdf would find, or to check whether a PDF has any native fillable fields at all ' +
      '(scanned/flattened pages have none — those need add_field_tab with a fallback page/x/y position instead of an anchor string).',
    inputSchema: {
      type: 'object',
      properties: {
        pdf_base64: { type: 'string', description: 'Base64-encoded PDF bytes.' },
      },
      required: ['pdf_base64'],
    },
  },
  {
    name: 'add_field_tab',
    description:
      'Add one tab to an existing DocuSign Template that onboard_pdf missed — most commonly signHere/initialHere/dateSigned tabs ' +
      '(never auto-detected), or any other field the extraction missed. Prefer anchor_string (DocuSign finds that text on the page ' +
      'itself and places the tab relative to it) over page/x/y coordinates; fall back to coordinates only when the page has no text ' +
      'layer at all (a flattened scan) or the anchor text cannot be found.',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: { type: 'string', description: 'DocuSign Template ID to add the tab to.' },
        tab_type: {
          type: 'string',
          enum: ['text', 'checkbox', 'signHere', 'initialHere', 'dateSigned'],
          description: 'DocuSign tab type to create.',
        },
        tab_label: { type: 'string', description: 'Tab label/name. Required for text/checkbox tabs; optional for signHere/initialHere/dateSigned.' },
        anchor_string: { type: 'string', description: 'Exact text to find on the page (preferred placement method).' },
        x_offset: { type: 'number', description: 'Horizontal offset in points from the anchor text (with anchor_string).' },
        y_offset: { type: 'number', description: 'Vertical offset in points from the anchor text (with anchor_string). Positive = below.' },
        page: { type: 'integer', description: 'Page number, 1-indexed (fallback when no anchor_string).' },
        x: { type: 'number', description: 'X position in points from the page\'s left edge (fallback when no anchor_string).' },
        y: { type: 'number', description: 'Y position in points from the page\'s top edge (fallback when no anchor_string).' },
      },
      required: ['template_id', 'tab_type'],
    },
  },
];

function requireEnv(keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(', ')}`);
  }
}

async function callTool(name, args) {
  switch (name) {
    case 'onboard_pdf': {
      requireEnv([
        'DOCUSIGN_ACCOUNT_ID', 'DOCUSIGN_API_BASE_URL',
        'MILEMARKER_BASE_URL', 'MILEMARKER_API_KEY',
        'MILEMARKER_WORKFLOW_TYPE_ID', 'MILEMARKER_WORKFLOW_CATEGORY_ID',
        'MILEMARKER_WORKFLOW_ACCESS_LEVELS', 'MILEMARKER_DEFAULT_ASSIGNEES',
        'MILEMARKER_N8N_PROJECTION_ID',
      ]);
      if (!args.pdf_base64 || !args.document_name || !args.workflow_name) {
        throw new Error('Required: pdf_base64, document_name, workflow_name');
      }
      return onboardPdf({
        pdfBytes: Buffer.from(args.pdf_base64, 'base64'),
        documentName: args.document_name,
        workflowName: args.workflow_name,
        workflowDescription: args.workflow_description,
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
    }

    case 'extract_fields': {
      if (!args.pdf_base64) {
        throw new Error('Required: pdf_base64');
      }
      return extractFields(Buffer.from(args.pdf_base64, 'base64'));
    }

    case 'add_field_tab': {
      requireEnv(['DOCUSIGN_ACCOUNT_ID', 'DOCUSIGN_API_BASE_URL']);
      if (!args.template_id || !args.tab_type) {
        throw new Error('Required: template_id, tab_type');
      }
      if (!args.anchor_string && (args.page === undefined || args.x === undefined || args.y === undefined)) {
        throw new Error('Provide either anchor_string, or page + x + y as a fallback');
      }
      const { accessToken } = await getAccessToken();
      const common = {
        accessToken,
        accountId: process.env.DOCUSIGN_ACCOUNT_ID,
        apiBase: process.env.DOCUSIGN_API_BASE_URL,
        templateId: args.template_id,
        tabType: args.tab_type,
        tabLabel: args.tab_label,
      };
      return args.anchor_string
        ? addAnchoredTab({ ...common, anchorString: args.anchor_string, xOffset: args.x_offset || 0, yOffset: args.y_offset || 0 })
        : addCoordinateTab({ ...common, page: args.page, x: args.x, y: args.y });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TOOLS, callTool };
