// Resolves PDF bytes from either inline base64 or a URL the server fetches itself. The URL
// path exists specifically so a plain chat-based MCP client (no terminal/file-system access,
// unlike Claude Code) never has to embed a multi-MB base64 string in a tool-call argument —
// the server downloads the file directly instead.

const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20MB, generous for a scanned/multi-page PDF

async function resolvePdfBytes({ pdfBase64, pdfUrl }) {
  if (pdfBase64) {
    return Buffer.from(pdfBase64, 'base64');
  }
  if (pdfUrl) {
    let res;
    try {
      res = await fetch(pdfUrl);
    } catch (err) {
      throw new Error(`Failed to fetch pdf_url: ${String(err && err.message ? err.message : err)}`);
    }
    if (!res.ok) {
      throw new Error(`Failed to fetch pdf_url: ${res.status} ${res.statusText}`);
    }
    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength && contentLength > MAX_PDF_BYTES) {
      throw new Error(`PDF at pdf_url is too large (${contentLength} bytes, max ${MAX_PDF_BYTES})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PDF_BYTES) {
      throw new Error(`PDF at pdf_url is too large (${buf.length} bytes, max ${MAX_PDF_BYTES})`);
    }
    return buf;
  }
  throw new Error('Provide either pdf_base64 or pdf_url');
}

module.exports = { resolvePdfBytes, MAX_PDF_BYTES };
