const { extractFields } = require('../../lib/extract-fields');

const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20MB, generous for a scanned/multi-page PDF

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

  const { pdf_base64: pdfBase64 } = payload;
  if (!pdfBase64 || typeof pdfBase64 !== 'string') {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing required field "pdf_base64" (base64-encoded PDF bytes)' }),
    };
  }
  if (pdfBase64.length > MAX_BODY_BYTES) {
    return { statusCode: 413, body: JSON.stringify({ error: 'PDF too large' }) };
  }

  let pdfBytes;
  try {
    pdfBytes = Buffer.from(pdfBase64, 'base64');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'pdf_base64 is not valid base64' }) };
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
