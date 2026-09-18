# DocuSign PDF Field Extractor

Netlify Function that reads any PDF's native fillable-field geometry (page, position, type) and
returns a DocuSign-ready tab list. This is the first building block of the generic "onboard any PDF
into a new Milemarker + DocuSign workflow" pipeline — see the plan for the full design.

## Why this exists

DocuSign's own "import PDF form fields" auto-tagging only works on plain AcroForms, not
**XFA-hybrid** PDFs (the format most real financial-institution forms use, e.g. Charles Schwab's IRA
Account Application). n8n's Code node also can't `require()` a PDF-parsing npm package, so this
logic can't live inside an n8n workflow either — it needs to run somewhere with a real Node runtime.

Verified against a real 21-page, XFA-hybrid Schwab PDF (via Python `pypdf`, read-only, before this
service was written): even though DocuSign can't self-detect anything from the file, the underlying
`/Widget` annotations still carry full geometry (page, `/Rect`, `/FT` type, `/T` name) for every real
field. This service ports that same approach to Node (`pdf-lib`) so it can run as part of the actual
pipeline.

## How it works

`lib/extract-fields.js` walks each page's raw `/Annots` → `/Widget` entries directly — **not**
`pdfDoc.getForm()`'s high-level Form API, which is unreliable against XFA-hybrid PDFs. For each
widget it:
- Resolves `/FT` (field type), `/Ff` (flags), and `/T` (name) up the `/Parent` chain, since XFA-hybrid
  PDFs often inherit these from a parent field object rather than setting them directly on the widget.
- Filters out UI-chrome widgets that aren't real data fields (clear/print buttons, QR/barcode helper
  fields) by name pattern.
- Maps `/Tx` → `text`, `/Ch` → `dropdown`/`list` (via the Combo flag), `/Btn` → `checkbox`/`radio`
  (via the Radio/Pushbutton flags; pushbuttons are skipped entirely).
- Converts the PDF's bottom-left-origin `/Rect` coordinates to DocuSign's top-left-origin tab
  coordinates.

## API

`POST /.netlify/functions/extract-fields`

```json
{ "pdf_base64": "<base64-encoded PDF bytes>" }
```

Response:

```json
{
  "pageCount": 21,
  "fields": [
    { "page": 1, "x": 152, "y": 706, "width": 98, "height": 10, "tabType": "text", "name": "SchwabAccountNumber[0]" },
    ...
  ]
}
```

## Local testing

```bash
npm install
node test-local.js /path/to/some.pdf
```

Prints page count, field count, a breakdown by type, and the first 20 extracted fields.

## Hosting

Deployed as its own Netlify site, in its own GitHub repo, under Carl's own personal GitHub/Netlify
account (not the shared Milemarker Core Netlify team — see project memory on known auth/secret-env
issues with that account) — same pattern already used for `automation/tfg/netlify-pdf-fill/`.

## Secrets

This function is currently stateless and needs no secrets. See `.env.example` for what future
pipeline stages (Milemarker/DocuSign/n8n API calls) will need — those get set directly in Netlify's
dashboard, never typed or transmitted through Claude, per this project's established
private-key-handling convention.
