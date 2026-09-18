const DOCUSIGN_TAB_TYPE_TO_ARRAY = {
  text: 'textTabs',
  checkbox: 'checkboxTabs',
  radio: 'radioGroupTabs',
  dropdown: 'listTabs',
  list: 'listTabs',
};

/**
 * Creates a new DocuSign Template from a PDF and its mapped fields
 * (output of field-mapping.js#mapFields). Every field is added as a
 * signer-fillable tab, explicitly NOT required — DocuSign defaults
 * text/checkbox tabs to required:true, which would otherwise block a signer
 * from finishing until they filled in every single detected field (a real
 * bug caught and fixed by hand earlier this session).
 *
 * @param {string} accessToken
 * @param {string} accountId
 * @param {string} apiBase e.g. https://demo.docusign.net/restapi
 * @param {Buffer} pdfBytes
 * @param {string} documentName
 * @param {Array} mappedFields output of field-mapping.js#mapFields
 * @param {string} templateName
 * @returns {Promise<{templateId: string}>}
 */
async function createTemplate({ accessToken, accountId, apiBase, pdfBytes, documentName, mappedFields, templateName }) {
  const tabsByArray = {};
  for (const f of mappedFields) {
    const arrayKey = DOCUSIGN_TAB_TYPE_TO_ARRAY[f.tabType];
    if (!arrayKey) continue; // pushbuttons and unrecognized types are skipped
    if (!tabsByArray[arrayKey]) tabsByArray[arrayKey] = [];
    const entry = {
      tabLabel: f.tabLabel,
      documentId: '1',
      pageNumber: String(f.page),
      xPosition: String(f.x),
      yPosition: String(f.y),
      required: 'false',
    };
    if (arrayKey === 'textTabs') {
      entry.width = String(f.width);
      entry.height = String(f.height);
    }
    tabsByArray[arrayKey].push(entry);
  }

  const payload = {
    name: templateName,
    documents: [
      {
        documentBase64: pdfBytes.toString('base64'),
        name: documentName,
        fileExtension: 'pdf',
        documentId: '1',
      },
    ],
    recipients: {
      signers: [
        {
          roleName: 'Signer 1',
          recipientId: '1',
          tabs: tabsByArray,
        },
      ],
    },
  };

  const res = await fetch(`${apiBase}/v2.1/accounts/${accountId}/templates`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`DocuSign template creation failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return { templateId: body.templateId };
}

/**
 * Adds one tab to an existing template using DocuSign's anchor-string
 * placement (finds the given text on the page and positions the tab
 * relative to it) rather than raw pixel coordinates — used for fields the
 * automatic extraction missed (e.g. printed lines with no underlying form
 * field, like signature/initial/date lines).
 *
 * @param {object} opts
 * @param {string} opts.anchorString text to search for on the page
 * @param {'signHere'|'initialHere'|'dateSigned'|'text'|'checkbox'} opts.tabType
 * @param {number} [opts.xOffset]
 * @param {number} [opts.yOffset]
 * @param {string} [opts.tabLabel]
 */
async function addAnchoredTab({ accessToken, accountId, apiBase, templateId, anchorString, tabType, xOffset = 0, yOffset = 0, tabLabel }) {
  const tabArrayKey = {
    signHere: 'signHereTabs',
    initialHere: 'initialHereTabs',
    dateSigned: 'dateSignedTabs',
    text: 'textTabs',
    checkbox: 'checkboxTabs',
  }[tabType];
  if (!tabArrayKey) throw new Error(`Unsupported tabType: ${tabType}`);

  const entry = {
    documentId: '1',
    recipientId: '1',
    anchorString,
    anchorXOffset: String(xOffset),
    anchorYOffset: String(yOffset),
    anchorUnits: 'pixels',
    anchorCaseSensitive: 'false',
  };
  if (tabLabel) entry.tabLabel = tabLabel;
  if (tabArrayKey === 'signHereTabs' || tabArrayKey === 'initialHereTabs' || tabArrayKey === 'dateSignedTabs') {
    entry.optional = 'false';
  } else {
    entry.required = 'false';
  }

  const res = await fetch(`${apiBase}/v2.1/accounts/${accountId}/templates/${templateId}/recipients/1/tabs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ [tabArrayKey]: [entry] }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`DocuSign add anchored tab failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Adds one tab to an existing template at explicit page/pixel coordinates —
 * the fallback for documents where anchor text isn't available (e.g. a
 * flattened scanned page with no text layer at all, like the real IRS
 * Form W-4R page found attached to the Schwab PDF this session).
 */
async function addCoordinateTab({ accessToken, accountId, apiBase, templateId, page, x, y, tabType, tabLabel }) {
  const tabArrayKey = {
    signHere: 'signHereTabs',
    initialHere: 'initialHereTabs',
    dateSigned: 'dateSignedTabs',
    text: 'textTabs',
    checkbox: 'checkboxTabs',
  }[tabType];
  if (!tabArrayKey) throw new Error(`Unsupported tabType: ${tabType}`);

  const entry = {
    documentId: '1',
    recipientId: '1',
    pageNumber: String(page),
    xPosition: String(x),
    yPosition: String(y),
  };
  if (tabLabel) entry.tabLabel = tabLabel;
  if (tabArrayKey === 'signHereTabs' || tabArrayKey === 'initialHereTabs' || tabArrayKey === 'dateSignedTabs') {
    entry.optional = 'false';
  } else {
    entry.required = 'false';
  }

  const res = await fetch(`${apiBase}/v2.1/accounts/${accountId}/templates/${templateId}/recipients/1/tabs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ [tabArrayKey]: [entry] }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`DocuSign add coordinate tab failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

module.exports = { createTemplate, addAnchoredTab, addCoordinateTab };
