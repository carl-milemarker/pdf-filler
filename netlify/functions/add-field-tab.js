const { getAccessToken } = require('../../lib/docusign-auth');
const { addAnchoredTab, addCoordinateTab } = require('../../lib/docusign-template');

// Patches a field the auto-extraction missed (including signature/initial/
// date lines) onto an already-created template. Prefers anchor-string
// placement (finds real text on the page); falls back to explicit
// page/x/y coordinates for documents with no text layer at all — a real
// case hit this session (the attached IRS Form W-4R is a flattened scan).

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

  const { template_id: templateId, tab_type: tabType, tab_label: tabLabel, anchor_string: anchorString, x_offset: xOffset, y_offset: yOffset, page, x, y } = payload;

  if (!templateId || !tabType) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Required: template_id, tab_type' }) };
  }
  if (!anchorString && (page === undefined || x === undefined || y === undefined)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Provide either anchor_string, or page + x + y as a fallback' }),
    };
  }

  const requiredEnv = ['DOCUSIGN_ACCOUNT_ID', 'DOCUSIGN_API_BASE_URL'];
  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length) {
    return { statusCode: 500, body: JSON.stringify({ error: `Missing env vars: ${missing.join(', ')}` }) };
  }

  try {
    const { accessToken } = await getAccessToken();
    const common = {
      accessToken,
      accountId: process.env.DOCUSIGN_ACCOUNT_ID,
      apiBase: process.env.DOCUSIGN_API_BASE_URL,
      templateId,
      tabType,
      tabLabel,
    };
    const result = anchorString
      ? await addAnchoredTab({ ...common, anchorString, xOffset: xOffset || 0, yOffset: yOffset || 0 })
      : await addCoordinateTab({ ...common, page, x, y });

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Failed to add tab', detail: String(err && err.message ? err.message : err) }),
    };
  }
};
