const { extractFields } = require('../../lib/extract-fields');
const { resolvePdfBytes } = require('../../lib/fetch-pdf');

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

  const { pdf_base64: pdfBase64, pdf_url: pdfUrl } = payload;
  if (!pdfBase64 && !pdfUrl) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Provide either "pdf_base64" (base64-encoded PDF bytes) or "pdf_url" (a URL this server fetches itself)' }),
    };
  }

  let pdfBytes;
  try {
    pdfBytes = await resolvePdfBytes({ pdfBase64, pdfUrl });
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
  }

  try {
    const result = await extractFields(pdfBytes);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 422,
      body: JSON.stringify({ error: 'Failed to parse PDF', detail: String(err && err.message ? err.message : err) }),
    };
  }
};
