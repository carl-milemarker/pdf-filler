# DocuSign PDF Onboarding Service

Netlify Functions that turn any PDF into a fillable DocuSign template paired with a matching
Milemarker Workflow + Form — the "onboard this PDF" pipeline. Built alongside the original DocuSign
POC (Flatiron workflow 54 / form 61) without touching it.

## Why this exists

DocuSign's own "import PDF form fields" auto-tagging only works on plain AcroForms, not
**XFA-hybrid** PDFs (the format most real financial-institution forms use, e.g. Charles Schwab's IRA
Account Application). n8n's Code node also can't `require()` a PDF-parsing npm package, so none of
this logic can live inside an n8n workflow — it needs to run somewhere with a real Node runtime.

## Endpoints

### `POST /.netlify/functions/extract-fields`
Reads a PDF's native fillable-field geometry. No secrets needed.

```json
{ "pdf_base64": "<base64-encoded PDF bytes>" }
```
```json
{ "pageCount": 21, "fields": [{ "page": 1, "x": 152, "y": 706, "width": 98, "height": 10, "tabType": "text", "name": "clients[0]...SchwabAccountNumber[0]" }] }
```

`lib/extract-fields.js` walks each page's raw `/Annots` → `/Widget` entries directly — **not**
`pdfDoc.getForm()`'s high-level Form API, which is unreliable against XFA-hybrid PDFs. It resolves
`/FT`/`/Ff`/`/T` up the `/Parent` chain (XFA-hybrid PDFs often inherit these rather than setting them
directly on the widget), filters out UI chrome (clear/print buttons, QR/barcode fields), maps
`/Tx`→text, `/Ch`→dropdown/list, `/Btn`→checkbox/radio, and converts the PDF's bottom-left-origin
`/Rect` to DocuSign's top-left-origin tab coordinates.

Verified against the real 21-page Schwab IRA Application: 293 real fields extracted, all correctly
positioned (confirmed visually via a test envelope — see the plan doc for details).

### `POST /.netlify/functions/onboard-pdf`
The full pipeline: extract → map field names → create a DocuSign Template → create a matching
Milemarker Form + Workflow. **Requires DocuSign + Milemarker env vars** (see `.env.example`).

```json
{
  "pdf_base64": "<base64-encoded PDF bytes>",
  "document_name": "4.pdf",
  "workflow_name": "Schwab IRA Account Application",
  "workflow_description": "optional"
}
```
```json
{ "formId": 62, "workflowId": 55, "templateId": "8d59e356-...", "fieldCount": 291, "byType": { "text": 150, "checkbox": 141 } }
```

`lib/field-mapping.js` turns raw hierarchical PDF field names (e.g.
`clients[0].Form[0]...SelectIRAType[0]...Checkboxes[0].contributory[0]`) into short, de-duplicated
snake_case keys (`contributory`, `contributory_1`, ...) used as **both** the DocuSign tab label and
the Milemarker form field key — this 1:1 naming is what a future n8n workflow can use as a simple
lookup instead of hardcoded field names. It also filters out DocuSign's own embedded
"IgnoreTransform" signature/print-name placeholder fields (found baked into the real Schwab PDF —
not real client data fields).

`lib/docusign-template.js` creates the Template with every mapped field as a signer-fillable tab,
**explicitly `required: false`** — DocuSign defaults text/checkbox tabs to `required: true`, which
would otherwise block a signer from finishing until they filled in literally every detected field
(a real bug caught and fixed by hand before this was ported into code).

`lib/milemarker.js` builds the matching Milemarker form schema (one field per detected PDF field,
per the "auto-create everything" decision) and creates the Form + Workflow via Milemarker's raw REST
API (`POST /forms`, `POST /workflows`) — note `schema`/`form` must be sent as pre-stringified JSON
(Milemarker stores them double-encoded; confirmed by reading a live form's raw API response).

### `POST /.netlify/functions/add-field-tab`
Patches a field the automatic extraction missed onto an already-created template — including
signature/initial/date lines, which are never detectable as normal form fields (they're just
printed lines in the source PDF).

```json
{ "template_id": "8d59e356-...", "tab_type": "signHere", "anchor_string": "Signature: Account Holder", "y_offset": -15 }
```

Prefers **anchor-string placement** (DocuSign finds the given text on the page itself) over raw
coordinates — no manual dragging in the DocuSign console needed. Falls back to explicit
`page`/`x`/`y` when there's no anchor text to use at all: a real case hit this session — the Schwab
PDF's attached IRS Form W-4R page turned out to be a **flattened scanned image with zero text
layer** (`get_text()` returns `''`), so its signature/date tabs had to be placed by estimating pixel
coordinates from a rendered image instead.

## Local testing

```bash
npm install
node test-local.js /path/to/some.pdf   # extraction only, no secrets needed
```

`onboard-pdf` and `add-field-tab` need real DocuSign/Milemarker credentials to test — set them in a
local `.env.local` (gitignored, never committed) and use `netlify dev`, or test against the deployed
Netlify site directly. The DocuSign private key is never typed, echoed, or transmitted through
Claude at any point — only pasted directly by a human into Netlify's dashboard or a local
`.env.local`.

## Hosting

Deployed as its own Netlify site, in its own GitHub repo (`github.com/carl-milemarker/pdf-filler`),
under Carl's own personal GitHub/Netlify account — not the shared Milemarker Core Netlify team (see
project memory on known auth/secret-env issues with that account). Same pattern already used for
`automation/tfg/netlify-pdf-fill/`.

## Secrets

See `.env.example` for the full list. All of them get set directly in Netlify's dashboard
(Site settings → Environment variables) — never through Claude or any automated tool call, per this
project's established private-key-handling convention.

