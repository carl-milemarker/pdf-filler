const { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber } = require('pdf-lib');

// Field-flag bits (PDF spec 12.7.4.2 / 12.7.4.3), used to tell button/choice
// subtypes apart. Read directly off /Ff since pdf-lib's high-level Form API
// (PDFDocument.getForm()) is unreliable against XFA-hybrid PDFs — this file
// walks the raw widget annotations instead, the same approach validated by
// hand against the real Schwab IRA Application PDF.
const FF_RADIO = 1 << 15; // bit 16
const FF_PUSHBUTTON = 1 << 16; // bit 17
const FF_COMBO = 1 << 17; // bit 18

// Widgets that are UI chrome baked into the source PDF (clear/print buttons,
// barcode/QR helper fields DocuSign has no use for) rather than real,
// client-facing data fields.
const SKIP_NAME_PATTERN = /qrcode|barcode|btnprint|btnreset|clrpnt/i;

function resolveFieldFlags(dict, context) {
  let node = dict;
  for (let depth = 0; depth < 10 && node; depth++) {
    const ff = node.get(PDFName.of('Ff'));
    if (ff instanceof PDFNumber) return ff.asNumber();
    const parentRef = node.get(PDFName.of('Parent'));
    node = parentRef ? context.lookup(parentRef, PDFDict) : undefined;
  }
  return 0;
}

function resolveFieldType(dict, context) {
  let node = dict;
  for (let depth = 0; depth < 10 && node; depth++) {
    const ft = node.get(PDFName.of('FT'));
    // PDFName#asString() includes the leading slash (e.g. "/Tx"), so strip it
    // for a plain "Tx"/"Ch"/"Btn" comparison downstream.
    if (ft instanceof PDFName) return ft.asString().replace(/^\//, '');
    const parentRef = node.get(PDFName.of('Parent'));
    node = parentRef ? context.lookup(parentRef, PDFDict) : undefined;
  }
  return null;
}

function resolveFieldName(dict, context) {
  const parts = [];
  let node = dict;
  for (let depth = 0; depth < 10 && node; depth++) {
    const t = node.get(PDFName.of('T'));
    if (t) parts.unshift(t.decodeText ? t.decodeText() : String(t));
    const parentRef = node.get(PDFName.of('Parent'));
    node = parentRef ? context.lookup(parentRef, PDFDict) : undefined;
  }
  return parts.join('.') || null;
}

function tabTypeFor(ft, flags) {
  if (ft === 'Tx') return 'text';
  if (ft === 'Ch') return (flags & FF_COMBO) ? 'dropdown' : 'list';
  if (ft === 'Btn') {
    if (flags & FF_PUSHBUTTON) return null; // not a data field, skip
    return (flags & FF_RADIO) ? 'radio' : 'checkbox';
  }
  return null;
}

/**
 * Extract every real, client-fillable field from a PDF's native widget
 * annotations (works even on XFA-hybrid forms, since those still carry
 * backward-compatible /Widget annotations with a real /Rect).
 *
 * @param {Buffer|Uint8Array} pdfBytes
 * @returns {Promise<{pageCount: number, fields: Array<object>}>}
 */
async function extractFields(pdfBytes) {
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const context = pdfDoc.context;
  const pages = pdfDoc.getPages();
  const fields = [];

  pages.forEach((page, pageIndex) => {
    const pageNumber = pageIndex + 1;
    const pageHeight = page.getHeight();
    const annotsRef = page.node.get(PDFName.of('Annots'));
    if (!annotsRef) return;
    const annots = context.lookup(annotsRef, PDFArray);
    if (!annots) return;

    for (let i = 0; i < annots.size(); i++) {
      const annotRef = annots.get(i);
      const annot = context.lookup(annotRef, PDFDict);
      if (!annot) continue;

      const subtype = annot.get(PDFName.of('Subtype'));
      if (!subtype || subtype.asString() !== '/Widget') continue;

      const rectArr = annot.get(PDFName.of('Rect'));
      if (!(rectArr instanceof PDFArray) || rectArr.size() !== 4) continue;
      const [x1, y1, x2, y2] = [0, 1, 2, 3].map((idx) => {
        const n = context.lookup(rectArr.get(idx), PDFNumber);
        return n ? n.asNumber() : 0;
      });
      const left = Math.min(x1, x2);
      const right = Math.max(x1, x2);
      const bottom = Math.min(y1, y2);
      const top = Math.max(y1, y2);
      const width = right - left;
      const height = top - bottom;
      if (width <= 0 || height <= 0) continue;

      const name = resolveFieldName(annot, context);
      if (!name || SKIP_NAME_PATTERN.test(name)) continue;

      const ft = resolveFieldType(annot, context);
      const flags = resolveFieldFlags(annot, context);
      const tabType = tabTypeFor(ft, flags);
      if (!tabType) continue;

      fields.push({
        page: pageNumber,
        // DocuSign tab coordinates are measured from the top-left of the
        // page; PDF /Rect coordinates are measured from the bottom-left.
        x: Math.round(left),
        y: Math.round(pageHeight - top),
        width: Math.round(width),
        height: Math.round(height),
        tabType,
        name,
      });
    }
  });

  return { pageCount: pages.length, fields };
}

module.exports = { extractFields };
