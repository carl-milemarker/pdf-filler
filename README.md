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
Milemarker Form + Workflow → attach the create-trigger to the shared n8n automation → write the
document-identity mapping record n8n uses to resolve the template. **Requires DocuSign + Milemarker
env vars** (see `.env.example`) — this is a fully wired, end-to-end onboard, not just the
Milemarker/DocuSign records.

```json
{
  "pdf_base64": "<base64-encoded PDF bytes>",
  "document_name": "4.pdf",
  "workflow_name": "Schwab IRA Account Application",
  "workflow_description": "optional"
}
```
```json
{ "formId": 62, "workflowId": 55, "templateId": "8d59e356-...", "fieldCount": 291, "byType": { "text": 150, "checkbox": 141 }, "n8nAttached": true, "mappingRecordId": "01M...", "note": "..." }
```

The new Workflow is created as `status: "draft"` — two steps are still manual on purpose:
placing signature/initial/date tabs (`add_field_tab`, since those are never auto-detected), and
publishing the Workflow once those are confirmed placed, so an unsignable document can't reach a
real client in the meantime.

`lib/milemarker.js#attachN8nProjection` reuses the **existing** n8n projection (one shared
"FLATIRON | Generic Doc Onboarding" n8n workflow serves every onboarded document — no new n8n
workflow gets created per document) via Milemarker's Workflow Projection Setup API
(`POST /workflows/{id}/projections`). `#createDocumentMapping` writes the
`docusign_onboarded_documents` custom-object record n8n looks up by `milemarker_workflow_id` at
submit time — created with the **same** `MILEMARKER_API_KEY` identity that will later query it,
since custom object records are per-user siloed by `created_by` (a real bug hit and fixed by hand
this session: a different identity's writes are invisible to this API key's reads, even with
`context=all`).

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

### `POST /.netlify/functions/mcp`
The same three capabilities (`onboard_pdf`, `extract_fields`, `add_field_tab`) exposed as MCP tools
over the **Streamable HTTP** transport, so a Claude session can call them conversationally instead
of by hand-running curl/API calls — e.g. "convert this PDF to fillable with DocuSign and a new MM
workflow" resolves to an `onboard_pdf` tool call.

Stateless: every request is one JSON-RPC 2.0 message in, one response out — no SSE stream, no
session store (Netlify Functions are short-lived and can't hold a stream open anyway; a server that
doesn't need server-initiated messages or resumable streams is allowed to respond directly instead
of opening one, per the MCP spec). `lib/mcp-tools.js` holds the tool schemas and dispatch; it's a
thin wrapper over the exact same `lib/onboard.js` / `lib/extract-fields.js` /
`lib/docusign-template.js` functions the plain-HTTP endpoints above call — one implementation, two
transports.

Guarded by a shared secret: set `MCP_SERVER_KEY` and every request must carry
`Authorization: Bearer <key>` (checked in `netlify/functions/mcp.js`) — this endpoint can trigger
real DocuSign envelope creation and real Milemarker workflow creation, so unlike `extract-fields` it
shouldn't be left open at a guessable URL. Leaving `MCP_SERVER_KEY` unset disables the check, for
local `netlify dev` only.

To register it in Claude Code, add an entry pointing at
`https://mm-pdf-filler.netlify.app/.netlify/functions/mcp` with the `Authorization: Bearer <key>`
header set.

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

`mcp.js` can be exercised directly with `node`, no server needed:

```js
const { handler } = require('./netlify/functions/mcp.js');
await handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
```

## Hosting

Deployed as its own Netlify site, in its own GitHub repo (`github.com/carl-milemarker/pdf-filler`),
under Carl's own personal GitHub/Netlify account — not the shared Milemarker Core Netlify team (see
project memory on known auth/secret-env issues with that account). Same pattern already used for
`automation/tfg/netlify-pdf-fill/`.

## Secrets

See `.env.example` for the full list. All of them get set directly in Netlify's dashboard
(Site settings → Environment variables) — never through Claude or any automated tool call, per this
project's established private-key-handling convention.






