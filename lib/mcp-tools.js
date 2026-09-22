const { extractFields } = require('./extract-fields');
const { getAccessToken, diagnosePrivateKey } = require('./docusign-auth');
const { addAnchoredTab, addCoordinateTab, setTemplateRecipients, removeTab, getRecipientTabs, getPageImage } = require('./docusign-template');
const { startOnboarding, checkOnboardingStatus } = require('./onboard-async');
const { resolvePdfBytes } = require('./fetch-pdf');

// Tool definitions exposed over MCP, and their dispatch — thin wrappers around the same
// lib/*.js functions the plain-HTTP Netlify functions already call, so onboard-pdf.js,
// add-field-tab.js and extract-fields.js and this MCP layer share one implementation.

const TOOLS = [
  {
    name: 'onboard_pdf',
    description:
      "Start onboarding a PDF into a brand-new Milemarker Workflow + Form, paired with a matching DocuSign Template, fully wired end " +
      'to end. Extracts every native form field from the PDF, creates a Milemarker Form with one field per extracted PDF field, ' +
      'creates a DocuSign Template with a matching tab per field (tabLabel == Milemarker field key), creates the Milemarker ' +
      'Workflow that binds them, attaches its create-trigger to the shared n8n automation (no new n8n workflow — one n8n workflow ' +
      'serves every onboarded document), and writes the document-identity mapping record that n8n uses to resolve which template ' +
      'to use at submit time. No manual n8n or mapping-store step needed after this call. ' +
      'This runs as a background job (the pipeline is too slow for a synchronous call, especially with large PDFs) — this tool ' +
      'returns a job_id almost immediately; poll check_onboarding_status(job_id) to see when it finishes and get the result. ' +
      'The new Workflow is created as a draft — two things are still left to a human once the job succeeds: (1) signature/' +
      'initial/date tabs are NOT auto-detected, use add_field_tab afterward to place those (and any other missed field) ' +
      'conversationally, e.g. "add a signature at the bottom of the birthday field"; (2) publish the Workflow once those tabs are ' +
      'confirmed placed, so an unsignable document can\'t be submitted by a real client in the meantime. ' +
      'Provide EITHER pdf_base64 or pdf_url, not both — prefer pdf_url whenever the PDF is more than a couple hundred KB: many MCP ' +
      'clients (especially plain chat clients with no file-system access) cannot reliably pass a multi-MB base64 string as a single ' +
      'tool-call argument. pdf_url is fetched by the server itself, so the file never has to pass through the calling client at all.',
    inputSchema: {
      type: 'object',
      properties: {
        pdf_base64: { type: 'string', description: 'Base64-encoded PDF bytes. Only for small PDFs — prefer pdf_url otherwise.' },
        pdf_url: { type: 'string', description: 'A URL to the PDF; the server fetches it directly. Preferred over pdf_base64 for any non-trivial file size.' },
        document_name: { type: 'string', description: 'Human-readable name of the source document, e.g. "Charles Schwab IRA Account Application".' },
        workflow_name: { type: 'string', description: 'Name for the new Milemarker Workflow + Form.' },
        workflow_description: { type: 'string', description: 'Optional description for the new Workflow.' },
      },
      required: ['document_name', 'workflow_name'],
    },
  },
  {
    name: 'check_onboarding_status',
    description:
      'Check the status of an onboard_pdf job started earlier. Returns "pending" while the background job is still running, ' +
      '"success" with the full result (formId, workflowId, templateId, fieldCount, etc.) once done, or "error" with the failure detail.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job_id returned by onboard_pdf.' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'extract_fields',
    description:
      'Extract every native AcroForm field from a PDF (page, position, type, name) without creating anything. ' +
      'Useful to preview what onboard_pdf would find, or to check whether a PDF has any native fillable fields at all ' +
      '(scanned/flattened pages have none — those need add_field_tab with a fallback page/x/y position instead of an anchor string). ' +
      'Provide EITHER pdf_base64 or pdf_url, not both — prefer pdf_url for anything more than a couple hundred KB.',
    inputSchema: {
      type: 'object',
      properties: {
        pdf_base64: { type: 'string', description: 'Base64-encoded PDF bytes. Only for small PDFs — prefer pdf_url otherwise.' },
        pdf_url: { type: 'string', description: 'A URL to the PDF; the server fetches it directly. Preferred over pdf_base64 for any non-trivial file size.' },
      },
    },
  },
  {
    name: 'add_field_tab',
    description:
      'Add one tab to an existing DocuSign Template that onboard_pdf missed — most commonly signHere/initialHere/dateSigned tabs ' +
      '(never auto-detected), or any other field the extraction missed. Prefer anchor_string (DocuSign finds that text on the page ' +
      'itself and places the tab relative to it) over page/x/y coordinates; fall back to coordinates only when the page has no text ' +
      'layer at all (a flattened scan) or the anchor text cannot be found. For a template with more than one signing recipient ' +
      '(see add_template_recipient), pass recipient_id to say which recipient this tab belongs to.',
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
        recipient_id: { type: 'string', description: 'DocuSign recipientId this tab belongs to. Defaults to "1" (the original/only signer). Use the recipientId assigned via add_template_recipient for a second signer such as an Advisor.' },
      },
      required: ['template_id', 'tab_type'],
    },
  },
  {
    name: 'remove_field_tab',
    description:
      'Remove one previously-placed tab from a DocuSign Template by its tabId (returned in the response of add_field_tab). ' +
      'Needed when anchor_string matches more than one place in the document (e.g. a boilerplate sentence repeated on two ' +
      'pages) — add_field_tab places a tab at EVERY match, so the unwanted one(s) need removing afterward.',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: { type: 'string', description: 'DocuSign Template ID.' },
        tab_id: { type: 'string', description: 'The tabId to remove (from a prior add_field_tab response).' },
        tab_type: {
          type: 'string',
          enum: ['text', 'checkbox', 'signHere', 'initialHere', 'dateSigned'],
          description: 'The tab\'s type (needed to know which DocuSign tab array it lives in).',
        },
        recipient_id: { type: 'string', description: 'The recipient that owns this tab. Defaults to "1".' },
      },
      required: ['template_id', 'tab_id', 'tab_type'],
    },
  },
  {
    name: 'add_template_recipient',
    description:
      'Add a second (or further) signing recipient to an existing DocuSign Template that onboard_pdf created with a single implicit ' +
      '"Signer 1"/recipientId "1" role, and set explicit routingOrder on ALL recipients so DocuSign enforces signing order natively ' +
      '(e.g. an Advisor signs first, then the Client signs after — DocuSign withholds a later routingOrder recipient\'s copy until ' +
      'every earlier routingOrder recipient completes). Use this BEFORE calling add_field_tab to place the new recipient\'s own ' +
      'signHere/dateSigned tabs with recipient_id set to the new recipient\'s id.',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: { type: 'string', description: 'DocuSign Template ID.' },
        new_recipient_id: { type: 'string', description: 'e.g. "2" — must not collide with an existing recipientId.' },
        new_role_name: { type: 'string', description: 'e.g. "Advisor".' },
        new_routing_order: { type: 'integer', description: 'e.g. 1 to sign first.' },
        existing_recipient_id: { type: 'string', description: 'The template\'s existing recipient to also update. Defaults to "1".' },
        existing_role_name: { type: 'string', description: 'Defaults to "Signer 1" (the roleName onboard_pdf/createTemplate always uses).' },
        existing_routing_order: { type: 'integer', description: 'e.g. 2 to sign after the new recipient.' },
      },
      required: ['template_id', 'new_recipient_id', 'new_role_name', 'new_routing_order', 'existing_routing_order'],
    },
  },
  {
    name: 'get_recipient_tabs',
    description:
      'Read-only diagnostic: fetch a recipient\'s full tab set (including any pre-filled values) from either a Template or an ' +
      'Envelope. Use this to confirm tabs/values actually attached the way onboard_pdf/setTemplateRecipients/n8n intended — ' +
      'e.g. checking whether a Client recipient\'s 291 data tabs and their values really made it onto a created envelope.',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: { type: 'string', description: 'DocuSign Template ID. Provide this OR envelope_id, not both.' },
        envelope_id: { type: 'string', description: 'DocuSign Envelope ID. Provide this OR template_id, not both.' },
        recipient_id: { type: 'string', description: 'Required. The recipientId to inspect.' },
      },
      required: ['recipient_id'],
    },
  },
  {
    name: 'get_page_image',
    description:
      'Read-only diagnostic: fetch a rendered PNG of one page of an envelope\'s document, with all tab values resolved onto ' +
      'the page as they actually appear. Use this to visually confirm a page\'s filled-in appearance rather than just its raw tab data.',
    inputSchema: {
      type: 'object',
      properties: {
        envelope_id: { type: 'string', description: 'DocuSign Envelope ID.' },
        document_id: { type: 'string', description: 'Defaults to "1" (the main document).' },
        page_number: { type: 'integer', description: 'Required. 1-indexed page number.' },
      },
      required: ['envelope_id', 'page_number'],
    },
  },
  {
    name: 'diagnose_private_key',
    description:
      'Read-only diagnostic: reports whether DOCUSIGN_RSA_PRIVATE_KEY parses as valid RSA key material, its bit length, and its ' +
      'public-key SHA256 fingerprint — never the key content itself. Use this to tell apart "the stored value isn\'t valid key ' +
      'material" from "it\'s valid but doesn\'t match what DocuSign has registered" when JWT auth fails.',
    inputSchema: { type: 'object', properties: {} },
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
      return startOnboarding({
        pdfBase64: args.pdf_base64,
        pdfUrl: args.pdf_url,
        documentName: args.document_name,
        workflowName: args.workflow_name,
        workflowDescription: args.workflow_description,
        siteUrl: process.env.URL,
      });
    }

    case 'check_onboarding_status': {
      return checkOnboardingStatus({ jobId: args.job_id });
    }

    case 'extract_fields': {
      const pdfBytes = await resolvePdfBytes({ pdfBase64: args.pdf_base64, pdfUrl: args.pdf_url });
      return extractFields(pdfBytes);
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
        recipientId: args.recipient_id || '1',
      };
      return args.anchor_string
        ? addAnchoredTab({ ...common, anchorString: args.anchor_string, xOffset: args.x_offset || 0, yOffset: args.y_offset || 0 })
        : addCoordinateTab({ ...common, page: args.page, x: args.x, y: args.y });
    }

    case 'remove_field_tab': {
      requireEnv(['DOCUSIGN_ACCOUNT_ID', 'DOCUSIGN_API_BASE_URL']);
      if (!args.template_id || !args.tab_id || !args.tab_type) {
        throw new Error('Required: template_id, tab_id, tab_type');
      }
      const { accessToken } = await getAccessToken();
      return removeTab({
        accessToken,
        accountId: process.env.DOCUSIGN_ACCOUNT_ID,
        apiBase: process.env.DOCUSIGN_API_BASE_URL,
        templateId: args.template_id,
        recipientId: args.recipient_id || '1',
        tabId: args.tab_id,
        tabType: args.tab_type,
      });
    }

    case 'add_template_recipient': {
      requireEnv(['DOCUSIGN_ACCOUNT_ID', 'DOCUSIGN_API_BASE_URL']);
      if (!args.template_id || !args.new_recipient_id || !args.new_role_name || args.new_routing_order === undefined || args.existing_routing_order === undefined) {
        throw new Error('Required: template_id, new_recipient_id, new_role_name, new_routing_order, existing_routing_order');
      }
      const { accessToken } = await getAccessToken();
      return setTemplateRecipients({
        accessToken,
        accountId: process.env.DOCUSIGN_ACCOUNT_ID,
        apiBase: process.env.DOCUSIGN_API_BASE_URL,
        templateId: args.template_id,
        signers: [
          {
            recipientId: args.existing_recipient_id || '1',
            roleName: args.existing_role_name || 'Signer 1',
            routingOrder: args.existing_routing_order,
          },
          {
            recipientId: args.new_recipient_id,
            roleName: args.new_role_name,
            routingOrder: args.new_routing_order,
          },
        ],
      });
    }

    case 'get_recipient_tabs': {
      requireEnv(['DOCUSIGN_ACCOUNT_ID', 'DOCUSIGN_API_BASE_URL']);
      if (!args.recipient_id || (!args.template_id && !args.envelope_id)) {
        throw new Error('Required: recipient_id, and one of template_id/envelope_id');
      }
      const { accessToken } = await getAccessToken();
      return getRecipientTabs({
        accessToken,
        accountId: process.env.DOCUSIGN_ACCOUNT_ID,
        apiBase: process.env.DOCUSIGN_API_BASE_URL,
        templateId: args.template_id,
        envelopeId: args.envelope_id,
        recipientId: args.recipient_id,
      });
    }

    case 'get_page_image': {
      requireEnv(['DOCUSIGN_ACCOUNT_ID', 'DOCUSIGN_API_BASE_URL']);
      if (!args.envelope_id || args.page_number === undefined) {
        throw new Error('Required: envelope_id, page_number');
      }
      const { accessToken } = await getAccessToken();
      return getPageImage({
        accessToken,
        accountId: process.env.DOCUSIGN_ACCOUNT_ID,
        apiBase: process.env.DOCUSIGN_API_BASE_URL,
        envelopeId: args.envelope_id,
        documentId: args.document_id || '1',
        pageNumber: args.page_number,
      });
    }

    case 'diagnose_private_key': {
      return diagnosePrivateKey();
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TOOLS, callTool };
