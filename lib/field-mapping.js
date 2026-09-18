// DocuSign embeds its own "ignore transform" signature/print-name
// placeholder fields directly in some source PDFs (confirmed on the real
// Charles Schwab IRA Application) — these are hints for DocuSign's own
// (XFA-unsupported) auto-tagging, not real client-facing data fields, so
// they're excluded from both the Milemarker form and DocuSign tabs.
const IGNORE_NAME_PATTERN = /docu.?sign.?ignore.?transform/i;

function sanitizeKey(rawName) {
  const last = rawName.split('.').pop();
  const stripped = last.replace(/\[\d+\]$/, '');
  const s1 = stripped.replace(/(.)([A-Z][a-z]+)/g, '$1_$2');
  const s2 = s1.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  const key = s2.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return key || 'field';
}

function humanize(key) {
  return key
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Turns raw extracted PDF fields (from extract-fields.js) into a de-duplicated
 * list carrying a short, stable `tabLabel` used as both the DocuSign tab
 * label and the Milemarker form field key — this 1:1 naming is what lets the
 * eventual n8n mapping stay a simple lookup instead of hardcoded per field.
 *
 * @param {Array<{page:number,x:number,y:number,width:number,height:number,tabType:string,name:string}>} fields
 * @returns {Array<same shape + {tabLabel: string, label: string}>}
 */
function mapFields(fields) {
  const seen = new Map();
  const result = [];
  for (const f of fields) {
    if (IGNORE_NAME_PATTERN.test(f.name)) continue;
    let key = sanitizeKey(f.name);
    if (seen.has(key)) {
      const n = seen.get(key) + 1;
      seen.set(key, n);
      key = `${key}_${n}`;
    } else {
      seen.set(key, 0);
    }
    result.push({ ...f, tabLabel: key, label: humanize(key) });
  }
  return result;
}

module.exports = { mapFields, sanitizeKey, humanize };
