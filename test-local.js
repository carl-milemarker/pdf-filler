// Local smoke test — runs the extraction logic directly (no Netlify dev
// server needed). Usage: node test-local.js <path-to-pdf>
const fs = require('fs');
const path = require('path');
const { extractFields } = require('./lib/extract-fields');

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('Usage: node test-local.js <path-to-pdf>');
    process.exit(1);
  }
  const bytes = fs.readFileSync(path.resolve(pdfPath));
  const { pageCount, fields } = await extractFields(bytes);

  console.log(`pages: ${pageCount}`);
  console.log(`fields found: ${fields.length}`);

  const byType = {};
  for (const f of fields) byType[f.tabType] = (byType[f.tabType] || 0) + 1;
  console.log('by type:', byType);

  console.log('\nfirst 20 fields:');
  for (const f of fields.slice(0, 20)) {
    console.log(`  p${f.page} (${f.x},${f.y}) ${f.width}x${f.height} [${f.tabType}] ${f.name}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
