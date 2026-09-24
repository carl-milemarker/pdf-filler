const DOCUSIGN_TAB_TYPE_TO_ARRAY = {
  text: 'textTabs',
  checkbox: 'checkboxTabs',
  radio: 'radioGroupTabs',
  dropdown: 'listTabs',
  list: 'listTabs',
};

// DocuSign doesn't draw a checkbox/radio glyph flush with the tab's anchor —
// even with an explicit width/height (see above), the rendered mark sits a
// fixed distance right and below the real PDF widget rect. Measured against
// the live Charles Schwab template (2026-09-23): the glyph's centroid landed
// ~6pt right and ~5pt below the square's true center, consistently across
// every checkbox on the page. Subtracting this from the anchor before sending
// it to DocuSign re-centers the mark in the printed square.
const CHECKBOX_GLYPH_OFFSET_X = -6;
const CHECKBOX_GLYPH_OFFSET_Y = -5;

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
    const isCheckboxLike = arrayKey === 'checkboxTabs' || arrayKey === 'radioGroupTabs';
    const entry = {
      tabLabel: f.tabLabel,
      documentId: '1',
      pageNumber: String(f.page),
      xPosition: String(isCheckboxLike ? f.x + CHECKBOX_GLYPH_OFFSET_X : f.x),
      yPosition: String(isCheckboxLike ? f.y + CHECKBOX_GLYPH_OFFSET_Y : f.y),
      required: 'false',
    };
    if (arrayKey === 'textTabs' || isCheckboxLike) {
      // Without an explicit width/height, DocuSign falls back to its own default
      // checkbox glyph size, which doesn't match the source PDF's real widget
      // rect — the glyph then renders visibly offset from the actual printed
      // square. Using the real extracted rect keeps the tab visually locked to
      // the checkbox it belongs to.
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
 * @param {string} [opts.recipientId] Which template recipient owns this tab. Defaults to '1'
 *   (the original/only recipient, "Signer 1") for backward compatibility. Use whatever
 *   recipientId was assigned via setTemplateRecipients for a second signer (e.g. an Advisor).
 */
async function addAnchoredTab({ accessToken, accountId, apiBase, templateId, anchorString, tabType, xOffset = 0, yOffset = 0, tabLabel, recipientId = '1' }) {
  const tabArrayKey = {
    signHere: 'signHereTabs',
    initialHere: 'initialHereTabs',
    dateSigned: 'dateSignedTabs',
    text: 'textTabs',
    checkbox: 'checkboxTabs',
  }[tabType];
  if (!tabArrayKey) throw new Error(`Unsupported tabType: ${tabType}`);

  const isCheckboxLike = tabArrayKey === 'checkboxTabs' || tabArrayKey === 'radioGroupTabs';
  const entry = {
    documentId: '1',
    recipientId,
    anchorString,
    anchorXOffset: String(isCheckboxLike ? xOffset + CHECKBOX_GLYPH_OFFSET_X : xOffset),
    anchorYOffset: String(isCheckboxLike ? yOffset + CHECKBOX_GLYPH_OFFSET_Y : yOffset),
    anchorUnits: 'pixels',
    anchorCaseSensitive: 'false',
  };
  if (tabLabel) entry.tabLabel = tabLabel;
  if (tabArrayKey === 'signHereTabs' || tabArrayKey === 'initialHereTabs' || tabArrayKey === 'dateSignedTabs') {
    entry.optional = 'false';
  } else {
    entry.required = 'false';
  }
  if (isCheckboxLike) {
    // See CHECKBOX_GLYPH_OFFSET_X/Y above — an anchored checkbox needs the
    // same explicit size DocuSign otherwise substitutes its own default for.
    entry.width = '9';
    entry.height = '9';
  }

  const res = await fetch(`${apiBase}/v2.1/accounts/${accountId}/templates/${templateId}/recipients/${recipientId}/tabs`, {
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
 *
 * @param {string} [recipientId] Same meaning/default as in addAnchoredTab.
 */
async function addCoordinateTab({ accessToken, accountId, apiBase, templateId, page, x, y, tabType, tabLabel, recipientId = '1' }) {
  const tabArrayKey = {
    signHere: 'signHereTabs',
    initialHere: 'initialHereTabs',
    dateSigned: 'dateSignedTabs',
    text: 'textTabs',
    checkbox: 'checkboxTabs',
  }[tabType];
  if (!tabArrayKey) throw new Error(`Unsupported tabType: ${tabType}`);

  const isCheckboxLike = tabArrayKey === 'checkboxTabs' || tabArrayKey === 'radioGroupTabs';
  const entry = {
    documentId: '1',
    recipientId,
    pageNumber: String(page),
    xPosition: String(isCheckboxLike ? x + CHECKBOX_GLYPH_OFFSET_X : x),
    yPosition: String(isCheckboxLike ? y + CHECKBOX_GLYPH_OFFSET_Y : y),
  };
  if (tabLabel) entry.tabLabel = tabLabel;
  if (tabArrayKey === 'signHereTabs' || tabArrayKey === 'initialHereTabs' || tabArrayKey === 'dateSignedTabs') {
    entry.optional = 'false';
  } else {
    entry.required = 'false';
  }
  if (isCheckboxLike) {
    // See CHECKBOX_GLYPH_OFFSET_X/Y above — a coordinate-placed checkbox needs
    // the same explicit size DocuSign otherwise substitutes its own default for.
    entry.width = '9';
    entry.height = '9';
  }

  const res = await fetch(`${apiBase}/v2.1/accounts/${accountId}/templates/${templateId}/recipients/${recipientId}/tabs`, {
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

/**
 * Removes one previously-placed tab by tabId — the undo for addAnchoredTab/addCoordinateTab.
 * Needed because an anchor_string can legitimately match more than one place in a real
 * document (e.g. a boilerplate sentence repeated on two pages), which places a tab at every
 * match — there was no way to remove the unwanted one(s) before this.
 */
async function removeTab({ accessToken, accountId, apiBase, templateId, recipientId, tabId, tabType }) {
  const tabArrayKey = {
    signHere: 'signHereTabs',
    initialHere: 'initialHereTabs',
    dateSigned: 'dateSignedTabs',
    text: 'textTabs',
    checkbox: 'checkboxTabs',
  }[tabType];
  if (!tabArrayKey) throw new Error(`Unsupported tabType: ${tabType}`);

  const res = await fetch(`${apiBase}/v2.1/accounts/${accountId}/templates/${templateId}/recipients/${recipientId}/tabs`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ [tabArrayKey]: [{ tabId }] }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`DocuSign remove tab failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Sets the FULL desired recipients array on an existing template in one call —
 * DocuSign updates existing recipients by recipientId and adds new ones in the same
 * request, so this is how a second signer (e.g. "Advisor") gets added to a template
 * `onboard_pdf` created with only the implicit "Signer 1"/recipientId "1" role, while
 * simultaneously bumping that existing recipient's routingOrder so DocuSign enforces
 * sequential signing (lower routingOrder signs first; a later recipient's copy isn't
 * released until every earlier routingOrder completes).
 *
 * @param {Array<{recipientId: string, roleName: string, routingOrder: number}>} signers
 *   The FULL desired set of signer recipients on the template, not just the new one.
 */
async function setTemplateRecipients({ accessToken, accountId, apiBase, templateId, signers }) {
  const res = await fetch(`${apiBase}/v2.1/accounts/${accountId}/templates/${templateId}/recipients`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      signers: signers.map((s) => ({
        recipientId: s.recipientId,
        roleName: s.roleName,
        routingOrder: String(s.routingOrder),
      })),
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`DocuSign set template recipients failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Reads back a template or envelope's recipients (with each recipient's full tab set,
 * including any pre-filled values) — a read-only diagnostic for confirming tabs/values
 * actually attached the way onboard_pdf/setTemplateRecipients/n8n intended, without
 * needing to hand-mint or reuse a DocuSign access token outside this service.
 */
async function getRecipientTabs({ accessToken, accountId, apiBase, templateId, envelopeId, recipientId }) {
  const kind = envelopeId ? 'envelopes' : 'templates';
  const id = envelopeId || templateId;
  const res = await fetch(`${apiBase}/v2.1/accounts/${accountId}/${kind}/${id}/recipients/${recipientId}/tabs`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`DocuSign get recipient tabs failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Fetches a rendered PNG of one page of an envelope's document, with all tab values
 * resolved onto the page (i.e. the actual filled-in appearance) — a read-only visual
 * diagnostic, used the same way as getRecipientTabs but for confirming what a page
 * genuinely looks like rather than just its raw tab data.
 */
async function getPageImage({ accessToken, accountId, apiBase, envelopeId, documentId = '1', pageNumber }) {
  const res = await fetch(
    `${apiBase}/v2.1/accounts/${accountId}/envelopes/${envelopeId}/documents/${documentId}/pages/${pageNumber}/page_image`,
    { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DocuSign get page image failed: ${res.status} ${body}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return { base64: Buffer.from(arrayBuffer).toString('base64'), contentType: res.headers.get('content-type') || 'image/png' };
}

module.exports = { createTemplate, addAnchoredTab, addCoordinateTab, setTemplateRecipients, removeTab, getRecipientTabs, getPageImage };
