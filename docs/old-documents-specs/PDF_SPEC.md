# PDF-Specific Specification

Everything specific to PDF handling. Assumes familiarity with the shared document system described in `DOCUMENT_SYSTEM_SPEC.md`.

---

## 1. PDF Upload & Processing

### 1.1 File Detection

An uploaded file is identified as PDF by:
1. **Magic bytes:** MIME type `application/pdf` detected from the file buffer
2. **Extension fallback:** filename ends with `.pdf` (case-insensitive)

### 1.2 Processing Pipeline

```
Receive buffer -> Extract text (primary parser, fallback if needed)
  -> Collect PDF metadata -> Chunk text -> Generate embeddings
  -> Upload original file to cloud storage -> Get public URL
  -> Resolve metadata (shared pipeline) -> Save document record
  -> Attach authors -> Save chunks -> Redirect
```

**Detailed steps:**

1. **Extract text and metadata** (see Section 2 — this is the most complex part)
   - Returns: `{ text: string, metadata: Record<string, unknown>, version?: string }`
   - If extraction fails with a `PdfExtractionError`, return HTTP 422: `"Could not extract text from this PDF. It may be scanned or protected."`
   - For any other error, return HTTP 500

2. **Collect metadata from the PDF info dictionary**
   - Author keys searched: `Author`, `author`, `Creator`, `creator`, `dc:creator`, `dc:contributors`, `meta:author`
   - Date keys searched: `CreationDate`, `ModDate`, `Date`, `xap:CreateDate`, `xmp:CreateDate`, `dcterms:created`, `meta:creation-date`
   - Uses the shared `collectRecordMetadata()` function with the shared metadata value flattening logic

3. **Chunk the extracted text**
   - Uses the shared chunking pipeline: 500-char chunks, 50-char overlap
   - If chunking produces 0 chunks, return HTTP 422: `"PDF contained no readable text"`

4. **Generate embeddings**
   - Uses the shared embedding pipeline: OpenAI `text-embedding-3-small`, 512 dimensions, max 100 parallel calls
   - If embedding generation fails, return HTTP 500: `"Failed to generate embeddings for this PDF"`

5. **Upload original PDF to cloud storage**
   - Generate the document UUID first
   - Filename: `{documentId}.pdf`
   - Upload to an object storage bucket (the implementation uses Supabase Storage)
     - Bucket name: from environment variable `SUPABASE_BUCKET`, default `"documents"`
     - Content type: `application/pdf`
     - Upsert: `false` (fail if file already exists)
   - Get the public URL for the uploaded file
   - Fallback URL if public URL generation fails: `/{bucket}/{filename}`

6. **Resolve metadata (shared pipeline)**
   - Input to `resolveDocumentMetadata()`:
     - `url`: the public storage URL
     - `title`: original filename with extension stripped (fallback: `"Untitled PDF"`)
     - `byline`: `null` (PDFs don't have a byline field)
     - `textContent`: the full extracted text (entire text, not truncated — unlike EPUB which sends 2000 chars)
     - `publishedTime`: `null` (let the pipeline find it from metadata)
     - `meta`: the collected metadata structure

7. **Save document record**
   - `id`: the generated UUID
   - `url`: the public storage URL (this is what makes it identifiable as a PDF — ends in `.pdf`)
   - `title`: resolved title, fallback to filename without extension
   - `content`: `""` (empty string — PDFs don't store HTML content)
   - `textContent`: the full extracted plain text
   - `publishedTime`: resolved date

8. **Attach authors** using the shared pipeline (merged from LLM-resolved + metadata-extracted)

9. **Save document chunks** — each chunk gets its own UUID, linked to the document, with its text, index, and embedding vector

### 1.3 Contrast with EPUB Processing

| Aspect | PDF | EPUB |
|---|---|---|
| File storage | Original uploaded to cloud storage | File deleted after processing |
| `url` field | Public URL ending in `.pdf` | Literal string `"epub"` |
| `content` field | Empty string `""` | Concatenated chapter HTML |
| `textContent` field | Full extracted plain text | `null` |
| Chunking & embeddings | Yes | No (gap) |
| Semantic search | Supported | Not supported (gap) |
| Text for metadata LLM | Full extracted text | First 2000 chars |

---

## 2. PDF Text Extraction

The text extraction system uses a **dual-parser architecture** with automatic fallback.

### 2.1 Primary Parser

The primary parser is `pdf-parse` (a dedicated PDF text extraction library).

**Lazy loading:** The parser constructor is dynamically imported and cached (singleton pattern). This avoids loading the PDF library at startup.

**Parse parameters:**
```
{
  itemJoiner: " ",       // join text items on a line with spaces
  pageJoiner: "\n\n",   // separate pages with double newlines
  lineEnforce: true      // enforce line breaks where the PDF indicates them
}
```

**Flow:**
1. Instantiate parser with the file buffer: `new PdfParse({ data: buffer })`
2. Call `parser.getText(parameters)` to get `{ text: string }`
3. If text is empty or whitespace-only after trimming, throw to trigger fallback
4. Call `parser.getInfo()` to get metadata (non-fatal if this fails — logged and ignored)
5. Call `parser.destroy()` in a finally block (best-effort cleanup)

### 2.2 Fallback Parser (pdf.js)

If the primary parser fails or returns empty text, a fallback using `pdfjs-dist` (Mozilla's PDF.js) runs.

**Lazy loading:** The pdfjs-dist legacy build is dynamically imported and cached. The worker is explicitly disabled (`workerSrc = undefined`) since this runs server-side.

**Flow:**
1. Convert buffer to `Uint8Array`
2. Create a loading task: `pdfjs.getDocument({ data })`
3. Await the document promise
4. For each page (1 to `document.numPages`):
   - `document.getPage(pageNumber)`
   - `page.getTextContent()`
   - Extract text from content items: `content.items.map(item => item.str).join(" ")`
5. Join all page texts with `"\n\n"` (same as primary parser's page joiner)
6. Attempt `document.getMetadata()` (non-fatal if fails)
7. Normalize the text
8. **Cleanup (in finally block):**
   - `document.cleanup()` if available
   - `document.destroy()` if available
   - `loadingTask.destroy()` if available
   - All cleanup calls are individually try/caught

### 2.3 Text Normalization

Both parsers' output is normalized through `normalizePdfText()`:

```
1. \r\n and \r  ->  \n           (normalize line endings)
2. \f (form feed)  ->  \n\n      (page breaks become double newlines)
3. \u00a0 (non-breaking space)  ->  regular space
4. multiple spaces/tabs  ->  single space
5. 3+ consecutive newlines  ->  \n\n  (collapse excessive blank lines)
6. trim leading/trailing whitespace
```

If the result is empty after normalization, throw `PdfExtractionError`.

### 2.4 Error Handling

A custom error class `PdfExtractionError` is used:
```
class PdfExtractionError extends Error {
  name: "PdfExtractionError"
  cause: unknown  // the underlying error, if any
}
```

Error scenarios:
- Primary parser fails -> fallback runs. If fallback also fails, `PdfExtractionError` is thrown with the fallback error as cause and the primary error preserved.
- Primary parser returns empty text -> fallback runs (same as above).
- Both parsers produce empty text after normalization -> `PdfExtractionError("No text remaining after normalization")`
- The upload endpoint catches `PdfExtractionError` and returns HTTP 422 with a user-friendly message about scanned/protected PDFs.

### 2.5 Metadata Extraction from PDF

The `getInfo()` / `getMetadata()` calls return a nested structure. Metadata is merged from two sources within this structure:

**Source structure:**
```
{
  info: { Author: "...", CreationDate: "...", ... },   // PDF Info dictionary
  metadata: { ... } | { getAll(): Record }             // XMP metadata
}
```

**Merge logic (`mergeMetadata`):**
1. If `source.info` exists and is an object, shallow-copy all its keys
2. If `source.metadata` exists:
   - If it has a `getAll()` method (XMP metadata object), call it and merge the result
   - Otherwise, shallow-merge it directly
3. Return the combined flat record

Later fields overwrite earlier ones if keys collide (XMP metadata takes precedence over Info dictionary).

### 2.6 PDF Version Extraction

The PDF format version (e.g. `"1.7"`, `"2.0"`) is extracted from metadata for informational purposes.

**Candidate keys checked (in order):**
1. From `source.info`: `PDFFormatVersion`, `Version`, `version`, `pdf:PDFVersion`, `pdf:version`, `dc:format`
2. From merged metadata: `PDFFormatVersion`, `Version`, `version`, `pdf:PDFVersion`, `pdf:version`, `xap:PDFVersion`, `dc:format`

**Extraction:** For each candidate string, try to match a version number pattern: `/(\d+(?:\.\d+)+)/`. Return the first match found, or the raw trimmed string if no version pattern matches.

---

## 3. PDF File Storage

### 3.1 Storage Architecture

Unlike EPUBs (which only store extracted content in the database), PDFs are stored as files in cloud object storage. The original PDF binary is preserved.

**Why:** The PDF viewer on the frontend needs to fetch and render the original PDF file. The backend only extracts text for search/embeddings — the visual rendering is handled entirely client-side by pdf.js.

### 3.2 Storage Details

- **Provider:** Object storage with public URL support (implementation uses Supabase Storage; equivalent to S3, GCS, R2, etc.)
- **Bucket:** Configurable via `SUPABASE_BUCKET` env var, default `"documents"`
- **File naming:** `{documentId}.pdf` — the document's UUID with `.pdf` extension
- **Content type:** `application/pdf`
- **Access:** Public URL (no authentication required to fetch the PDF for viewing)
- **Upsert policy:** `false` — a duplicate upload will fail rather than overwrite

### 3.3 URL as Type Discriminator

The public URL (e.g. `https://storage.example.com/documents/abc-123.pdf`) is stored in the document's `url` field. The frontend uses a regex test on this field to determine the viewer:

```
isPdf = /\.pdf$/i.test(document.url)
```

This means the URL **must** end in `.pdf` for the document to be recognized as a PDF. If using a storage provider that appends query parameters to URLs (e.g. signed URLs), this check would break — ensure the URL path ends with `.pdf`.

### 3.4 CORS Configuration

The PDF viewer (pdf.js) fetches the PDF file from the browser using `fetch()` / XHR. If the storage provider is on a different domain than the application, you **must** configure CORS headers on the storage bucket:

```
Access-Control-Allow-Origin: https://your-app-domain.com  (or * for development)
Access-Control-Allow-Methods: GET, HEAD
Access-Control-Allow-Headers: Range
Access-Control-Expose-Headers: Content-Range, Content-Length
```

The `Range` header support is important because pdf.js may request byte ranges for large PDFs.

**Supabase Storage** handles CORS automatically for public buckets. For S3, GCS, or R2, you must configure the bucket's CORS policy explicitly.

### 3.5 Environment Configuration

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_BUCKET=documents   # optional, defaults to "documents"
```

The Supabase client is initialized as an admin client with `persistSession: false` (server-side only, no session cookies).

---

## 4. PDF Storage Model

### 4.1 Document Record

For PDF documents, the document table row looks like:

```
{
  id: "uuid-...",
  url: "https://storage.example.com/documents/uuid-....pdf",  // public file URL
  title: "Research Paper Title",
  content: "",                   // empty string (PDF content lives in the file)
  textContent: "Full extracted text of the PDF...",  // full plain text
  publishedTime: "2024-03-15T00:00:00Z" | null,
  createdAt: ...,
  updatedAt: ...
}
```

### 4.2 Associated Chunks

PDFs always have associated chunk records (unlike EPUBs):

```
[
  { id: "uuid", documentId: "doc-uuid", text: "chunk 1 text...", chunkIndex: 0, embedding: [0.1, 0.2, ...] },
  { id: "uuid", documentId: "doc-uuid", text: "chunk 2 text...", chunkIndex: 1, embedding: [0.3, 0.4, ...] },
  ...
]
```

---

## 5. PDF Rendering (Frontend)

### 5.1 Viewer Selection

The document view page routes to `PdfViewer` when `document.url` matches `/\.pdf$/i`.

### 5.2 Component Props

```
PdfViewerProps {
  src: string           // public URL of the PDF file
  className?: string    // optional CSS class
  maxPages?: number     // defined but not currently used
  annotations?: Annotation[]  // highlight data
  theme?: string        // defined but not currently used in rendering
}
```

### 5.3 pdf.js Module Loading

The viewer uses `pdfjs-dist` — Mozilla's PDF.js library. Modules are loaded lazily and cached.

**Three modules are loaded:**
1. `pdfjs-dist/build/pdf.mjs` — core library (`pdfjsLib`)
2. `pdfjs-dist/build/pdf.worker.min.mjs` — Web Worker for parsing (loaded as URL)
3. `pdfjs-dist/web/pdf_viewer.mjs` — viewer components (`pdfjsViewer`)

**Worker setup:**
- The worker source URL is loaded via a `?url` import (Vite convention) and set on `pdfjsLib.GlobalWorkerOptions.workerSrc`
- If worker loading fails, pdf.js falls back to its default worker resolution
- The worker is only configured once (`workerConfigured` flag)

**Singleton caching:** The module loading promise is cached at module scope. Multiple component instances share the same loaded modules.

**CSS:** The viewer's base styles are imported from `pdfjs-dist/web/pdf_viewer.css`.

### 5.4 Viewer Initialization

The setup runs inside a `useEffect` keyed on `src` (the PDF URL). It is **async** and uses a `cancelled` flag to handle race conditions during cleanup.

**Step-by-step:**

1. **Teardown previous viewer** (if any): call cleanup functions, null out refs

2. **Prepare container:**
   - Clear the container's innerHTML
   - Set container positioning: `position: absolute; inset: 0; overflow: auto`
   - Create a child `<div class="pdfViewer">` as the viewer host

3. **Load pdf.js modules** (awaits the cached promise)

4. **Create pdf.js components:**
   - `EventBus` — internal event system for pdf.js
   - `PDFLinkService` — handles internal PDF links (connected to the EventBus)
   - `PDFViewer` — the main viewer, configured with:
     - `container`: the scrollable container div
     - `viewer`: the `pdfViewer` host div
     - `eventBus`: the EventBus instance
     - `linkService`: the link service
     - `textLayerMode: 1` — **enables the text layer** (critical for text selection and annotation)
   - Link the viewer to the link service: `linkService.setViewer(viewer)`

5. **Load the PDF document:**
   - `pdfjsLib.getDocument({ url: src, withCredentials: false })`
   - `withCredentials: false` since PDFs are served from public URLs (no cookies needed)
   - Await the loading task's promise to get the PDF document object

6. **Set the document on the viewer:**
   - `linkService.setDocument(pdf, null)`
   - `viewer.setDocument(pdf)`
   - This triggers pdf.js to begin rendering pages

7. **Set initial scale:**
   - `viewer.currentScaleValue = "page-width"` — fits the PDF to the container width
   - Awaits `document.fonts.ready` first (to ensure font metrics are stable before scaling)
   - Calls `viewer.update()` after setting the scale

### 5.5 Event Handling

The viewer subscribes to several pdf.js events. Each triggers annotation re-drawing and/or debug logging.

| Event | When | Action |
|---|---|---|
| `pagesinit` | All pages initialized | Set scale to page-width, then draw overlay highlights |
| `textlayerrendered` | A page's text layer finished rendering | Redraw overlay highlights (the text nodes this page contributed are now in the DOM) |
| `pagerendered` | A page's canvas finished rendering | Debug snapshot only |
| `scalechanging` | Scale is actively changing | Debug snapshot only |
| `scalechange` | Scale change completed | Debug snapshot only |
| `pagesloaded` | All pages loaded | Debug snapshot only |

**Critical event:** `textlayerrendered` is the most important for annotations. Highlights can only be drawn after the text layer exists in the DOM, and pages render lazily as the user scrolls. Every time a new page's text layer appears, highlights must be recomputed across the entire document.

### 5.6 Cleanup

All event listeners and pdf.js objects are tracked in a `cleanupFns` array. On teardown:
1. Remove all event listeners from the EventBus
2. Call `viewer.cleanup()`
3. Disconnect the link service: `linkService.setDocument(null, null)`
4. Destroy the PDF document object: `pdf.destroy()`
5. Destroy the loading task: `loadingTask.destroy()`

All cleanup calls are individually try/caught to prevent one failure from blocking others.

### 5.7 Error Display

If setup fails, the error message is captured in React state and displayed:
```html
<div class="text-red-500 text-sm p-4">{error.message}</div>
```

### 5.8 Component Layout

```html
<div style="width: 100%; height: 100%; position: absolute">  <!-- outer wrapper -->
  <div ref={containerRef} style="position: absolute; inset: 0; overflow: auto">
    <!-- pdf.js creates its DOM here -->
    <div class="pdfViewer">
      <div class="page" data-page-number="1">
        <div class="canvasWrapper"><canvas /></div>
        <div class="textLayer">
          <span>text content...</span>
          <div class="pdfOverlayLayer">  <!-- injected by annotation code -->
            <div class="pdfOverlayHighlight" />
          </div>
        </div>
      </div>
      <!-- more pages... -->
    </div>
  </div>
</div>
```

### 5.9 CSS Requirements

pdf.js internal elements must use `content-box` sizing (pdf.js expects this):

```css
.pdfViewer,
.pdfViewer .page,
.pdfViewer .canvasWrapper,
.pdfViewer .canvasWrapper canvas,
.pdfViewer .textLayer,
.pdfViewer .annotationLayer,
.pdfViewer .svgLayer {
  box-sizing: content-box;
}
```

This is necessary because many CSS resets set `box-sizing: border-box` globally, which breaks pdf.js layout calculations.

---

## 6. PDF Annotation Rendering

PDF annotations use a **completely different rendering approach** from HTML documents. Instead of injecting `<mark>` elements into the content, PDF annotations are rendered as absolutely-positioned overlay `<div>` elements on top of each page's text layer.

### 6.1 Why Overlays Instead of Marks

In HTML documents (EPUBs), the application controls the DOM — it can split text nodes and wrap them in `<mark>` elements. In PDF rendering, pdf.js owns the DOM. The text layer consists of positioned `<span>` elements that pdf.js manages. Modifying these spans would break pdf.js's internal state. Therefore, highlights are drawn as separate overlay divs positioned to visually cover the same region as the text.

### 6.2 Overlay Layer Structure

Each PDF page gets a `pdfOverlayLayer` div:

```html
<div class="pdfOverlayLayer"
  style="position: absolute; inset: 0; pointer-events: none; z-index: 4">
  <!-- highlight divs go here -->
</div>
```

- **Positioned within:** the page's `.textLayer` element (preferred) or the `.page` element (fallback)
- **`pointer-events: none`** — highlights don't intercept mouse events (text selection and scrolling pass through)
- **`z-index: 4`** — above the text layer (z-index 2 in pdf.js) and canvas (z-index 1)
- Created lazily: only when a page has annotations that overlap with its text

### 6.3 The `drawOverlayHighlights` Algorithm

This is the core function that renders all PDF annotations. It runs on the entire viewer root element.

**Step 1: Clear existing overlays**
```
rootEl.querySelectorAll(".pdfOverlayLayer").forEach(el => el.innerHTML = "")
```
Every call wipes and redraws all highlights from scratch. This is simpler and more robust than incremental updates.

**Step 2: Walk text nodes (text layer only)**

```
walker = createTreeWalker(rootEl, SHOW_TEXT)
nodes = []  // Array of { node: Text, start: number, end: number, pageDiv: HTMLElement }
pos = 0
while walker.nextNode():
  node = walker.currentNode
  parent = node.parentElement
  if parent is not inside a ".textLayer": skip
  pageDiv = parent.closest(".page")
  if no pageDiv: skip
  len = node.nodeValue.length
  if len > 0:
    nodes.push({ node, start: pos, end: pos + len, pageDiv })
    pos += len
```

**Key difference from EPUB rendering:** Only text nodes inside `.textLayer` elements are counted. Text nodes in other pdf.js elements (canvas wrappers, annotation layers, etc.) are excluded. Each node also records which `.page` div it belongs to, since highlights must be positioned relative to their page.

**Step 3: Filter and sort annotations** (identical to EPUB)

**Step 4: Map annotations to per-node relative ranges** (identical to EPUB)

**Step 5: Draw overlay divs using client rects**

For each text node with overlapping annotations, use the same sweep-line event algorithm as EPUB to identify segments. But instead of creating `<mark>` elements, create positioned `<div>` elements:

```
function drawSegment(from, to, covering):
  if from >= to or covering is empty: return

  // Create a browser Range over the text node substring
  range = document.createRange()
  range.setStart(node, from)
  range.setEnd(node, to)

  // Get the visual bounding rectangles for this range
  rects = range.getClientRects()
  anchorBCR = anchorEl.getBoundingClientRect()  // the textLayer or page element

  // Account for CSS transforms on the text layer
  { scaleX, scaleY } = getElementScale(anchorEl)

  for r in rects:
    if r.width <= 0 or r.height <= 0: skip

    hl = createElement("div")
    hl.className = "pdfOverlayHighlight"
    hl.style.position = "absolute"

    // Convert viewport coordinates to element-relative coordinates,
    // accounting for any CSS transforms (scaling)
    hl.style.left   = round((r.left - anchorBCR.left) / scaleX) + "px"
    hl.style.top    = round((r.top - anchorBCR.top) / scaleY) + "px"
    hl.style.width  = round(r.width / scaleX) + "px"
    hl.style.height = round(r.height / scaleY) + "px"

    hl.style.background = "rgba(168, 122, 245, 0.35)"  // semi-transparent purple
    hl.style.mixBlendMode = "multiply"
    hl.style.borderRadius = "2px"
    hl.style.pointerEvents = "none"

    if primary annotation has an id:
      hl.dataset.annid = primary.id

    overlayLayer.appendChild(hl)
```

### 6.4 Scale-Aware Coordinate Transformation

pdf.js applies CSS transforms to the text layer for scaling. The text layer's `transform` property might be something like `scale(1.33333)`. If we position overlays using raw `getBoundingClientRect()` values, they'll be off when the text layer is scaled.

**`getElementScale()` function:**
```
function getElementScale(el):
  transform = getComputedStyle(el).transform
  if transform is "none" or missing:
    return { scaleX: 1, scaleY: 1 }

  matrix = new DOMMatrix(transform)
  scaleX = hypot(matrix.a, matrix.b) || 1  // handles rotation too
  scaleY = hypot(matrix.c, matrix.d) || 1
  return { scaleX, scaleY }
```

The client rect coordinates (which are in viewport/screen space and include the transform) are divided by the scale factors to convert back to the element's local coordinate space (where the overlay div is positioned).

### 6.5 Highlight Appearance

All PDF highlights use a single fixed style:
- **Background:** `rgba(168, 122, 245, 0.35)` — semi-transparent purple
- **Blend mode:** `multiply` — blends with the page content underneath rather than obscuring it
- **Border radius:** `2px`
- **Pointer events:** `none`

**Note:** Unlike EPUB highlights which support multiple colors via CSS classes, PDF highlights currently use a single hardcoded color. This is a simplification/gap — the per-annotation color is not applied.

### 6.6 When Highlights Are Redrawn

Highlights are redrawn (full clear + redraw) on:
1. **`pagesinit` event** — after initial page setup and scale is set
2. **`textlayerrendered` event** — each time a page's text layer finishes rendering
3. **Annotations prop change** — when the React annotations array changes (new annotation added/removed)

This means highlights are redrawn frequently, but the full-redraw approach ensures correctness even when pages render lazily during scrolling.

### 6.7 Contrast with EPUB Annotation Rendering

| Aspect | EPUB | PDF |
|---|---|---|
| Strategy | Inject `<mark>` elements into the HTML DOM | Absolutely-positioned overlay `<div>` elements |
| Text node source | All text nodes in the content | Only text nodes inside `.textLayer` |
| Color support | Per-annotation colors via CSS classes | Single hardcoded purple color |
| Hover/click states | `is-hovered`, `is-selected` CSS classes | No interactive states |
| Note display | `data-note` attribute on marks | `data-annid` only |
| Blend mode | None (opaque background colors) | `mix-blend-mode: multiply` |
| Coordinate system | DOM flow (marks are inline elements) | Absolute positioning with scale correction |
| Re-render trigger | innerHTML replacement | Overlay layer clear + redraw |

---

## 7. PDF Text Selection & Annotation Offsets

### 7.1 How Text Selection Works in PDFs

pdf.js creates a **text layer** (`<div class="textLayer">`) on top of each page's canvas. This layer contains invisible `<span>` elements positioned to exactly overlay the text rendered on the canvas. These spans enable browser-native text selection.

When a user selects text in the PDF viewer, the browser's `Selection` and `Range` APIs work against these text layer spans — exactly as they would for normal HTML text.

### 7.2 Offset Calculation

The `doc-container` div wraps the entire `PdfViewer` component. The shared `getCharOffset()` / `rangeToOffsets()` functions (from `DOCUMENT_SYSTEM_SPEC.md` Section 6.1) run on this container.

**IMPORTANT — Offset domain asymmetry:** The selection handler (defined in the parent document page) walks ALL text nodes in the container. The annotation overlay renderer (`drawOverlayHighlights`) walks ONLY text nodes inside `.textLayer` elements. This is an asymmetry in the reference implementation.

In practice, these produce the same offsets because all user-selectable text lives in `.textLayer` spans. But if pdf.js ever adds visible text outside `.textLayer` (e.g. annotation tooltips, form field labels), the offset domains would diverge. **A robust new implementation should use the same text-node filtering in both the selection handler and the overlay renderer** — either both filter to `.textLayer` only, or neither does.

The selection handler runs against whatever text nodes exist in the DOM at selection time. Since pdf.js renders pages lazily (only rendering pages near the viewport), the offsets will only be correct for text on pages that have been rendered. For practical purposes this is fine — users can only select text on rendered pages.

### 7.3 Offset Persistence

The same `start`/`end` offsets stored in the annotation record are used by both:
- The selection handler (to compute offsets when creating an annotation)
- The `drawOverlayHighlights()` function (to position highlights when viewing)

Both use the same tree-walker approach to enumerate text nodes, so the offsets are consistent — as long as the same pages are rendered (see Section 7.4).

### 7.4 Lazy Page Rendering Implications

pdf.js only renders pages near the current viewport. This has implications:

- **Creating annotations:** Only possible on rendered pages (you can only select visible text). This is a non-issue in practice.
- **Displaying annotations:** Annotations on unrendered pages won't show until those pages render. This is why `drawOverlayHighlights` is called on `textlayerrendered` — as each page's text layer appears, all highlights are recomputed, and any annotations on that newly-rendered page will now have matching text nodes.
- **Offset stability:** When more pages render, the total text content grows. But since pages render in document order and text nodes accumulate monotonically, previously-valid offsets remain correct. New pages just add text nodes at higher offsets.

---

## 8. PDF Metadata Specifics

### 8.1 PDF Info Dictionary Keys

Standard PDF metadata fields that may appear:

| Key | Description | Example |
|---|---|---|
| `Author` | Document author | `"Jane Smith"` |
| `Creator` | Application that created the PDF | `"Microsoft Word"` |
| `Producer` | PDF library/tool that generated the file | `"macOS Quartz PDFContext"` |
| `Title` | Document title | `"Quarterly Report"` |
| `Subject` | Subject/description | |
| `Keywords` | Keyword string | |
| `CreationDate` | When the PDF was created | `"D:20240315120000Z"` |
| `ModDate` | When the PDF was last modified | `"D:20240320150000Z"` |

### 8.2 XMP Metadata Keys

PDFs may also contain XMP (Extensible Metadata Platform) metadata with namespaced keys:

| Key | Namespace | Description |
|---|---|---|
| `dc:creator` | Dublin Core | Author(s) |
| `dc:contributors` | Dublin Core | Contributors |
| `dc:format` | Dublin Core | MIME type / format version |
| `xap:CreateDate` | XAP (Adobe) | Creation date |
| `xmp:CreateDate` | XMP | Creation date |
| `dcterms:created` | Dublin Core Terms | Creation date |

### 8.3 PDF Date Format

PDF dates use a specific format: `D:YYYYMMDDHHmmSSOHH'mm'`
- Example: `D:20240315120000+05'30'`
- The shared date normalization pipeline handles this via regex fallback

### 8.4 Metadata Merge Priority

When both Info dictionary and XMP metadata contain the same information:
- XMP metadata overwrites Info dictionary values (it's merged second)
- This is generally correct since XMP is the more modern standard

### 8.5 PDF Version

The PDF format version (e.g. `1.4`, `1.7`, `2.0`) is extracted and stored for informational purposes. Candidate keys searched:
- `PDFFormatVersion`, `Version`, `version`
- `pdf:PDFVersion`, `pdf:version`
- `xap:PDFVersion`
- `dc:format` (may contain something like `application/pdf; version=1.7`)

---

## 9. Debug Logging System

The PDF viewer includes a comprehensive debug logging system, disabled by default.

### 9.1 Enabling Debug Mode

Set `PDF_DEBUG = true` in the source (compile-time constant). Additionally, `window.__PDF_DEBUG__` can be set to `false` at runtime to override.

### 9.2 Debug Snapshots

The `logLayerSnapshot()` function captures the state of every page in the viewer:

**Per-page metrics captured:**
- Canvas wrapper dimensions (getBoundingClientRect)
- Text layer dimensions (getBoundingClientRect)
- Width/height difference between canvas and text layer
- Width/height ratio between canvas and text layer
- Canvas transform CSS property
- Text layer transform CSS property
- Text layer transform-origin CSS property

**Container metrics:**
- clientWidth, clientHeight, scrollWidth, scrollHeight

**Viewer state:**
- currentScale (numeric zoom level)
- currentScaleValue (e.g. `"page-width"`, `"auto"`, or a numeric string)

Output is logged using `console.groupCollapsed` / `console.table` for easy exploration in dev tools.

### 9.3 Events Logged

Debug snapshots are taken after: viewer init, setDocument, ensurePageWidth, pagesinit, textlayerrendered, pagerendered, scalechanging, scalechange, pagesloaded, annotation effect, and overlay highlight draw start/end.

---

## 10. Known Limitations & Improvement Opportunities

### 10.1 Single Highlight Color

PDF highlights use a single hardcoded purple (`rgba(168, 122, 245, 0.35)`). The per-annotation `color` field is stored but not applied during rendering. Implementing per-color highlights would require mapping the color index to an RGBA value in `drawSegment()`.

### 10.2 No Hover/Click Interaction on PDF Highlights

Unlike EPUB highlights (which support hover highlighting, click-to-select, and note popovers), PDF overlay highlights have `pointer-events: none` and no interactive behavior. Clicking on a highlighted area in a PDF does not show the annotation's note.

To add interactivity:
- Set `pointer-events: auto` on overlay highlights (or a transparent click target above them)
- Add `mouseover`/`click` handlers that read `data-annid` and dispatch to the popover system
- Need to handle the interaction between text selection and highlight clicking (currently, text selection always wins)

### 10.3 No Annotation Layer Integration

pdf.js has a built-in annotation layer for PDF form fields, links, and comments. The current implementation does not use this layer for custom annotations — it uses a completely separate overlay system. This is fine for text highlights but means the application can't leverage pdf.js's annotation infrastructure.

### 10.4 Scanned/Image-Only PDFs

PDFs that are scans (images without a text layer) will fail text extraction with a `PdfExtractionError`. The error message hints at this: `"Could not extract text from this PDF. It may be scanned or protected."` To support scanned PDFs, OCR (e.g. Tesseract) would be needed as an additional extraction step.

### 10.5 Protected/Encrypted PDFs

Password-protected or permission-restricted PDFs will likely fail at the text extraction stage. No handling exists for prompting the user for a password.

### 10.6 Very Large PDFs

- **Backend:** Text extraction processes all pages sequentially (in fallback mode). Very large PDFs could cause timeout issues.
- **Frontend:** pdf.js handles large PDFs well via lazy page rendering, but having all text layer nodes in the DOM simultaneously (after scrolling through the whole document) could impact performance for the overlay highlight algorithm, which walks all text nodes on every re-draw.

### 10.7 No Page-Level Annotation Context

Annotations only store character offsets, not page numbers. A future implementation might also store the page number to:
- Jump to the annotation's page when clicked in a sidebar
- Optimize highlight rendering by only processing the relevant page
- Provide page context in annotation lists/exports
