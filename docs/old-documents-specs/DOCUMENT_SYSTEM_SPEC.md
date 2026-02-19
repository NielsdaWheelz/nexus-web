# Document System Specification

Stack-agnostic specification for the core document handling system: upload, processing, storage, viewing, annotation/highlighting, and search. This covers all functionality shared across document types (EPUB, PDF, web articles, etc.). Format-specific details live in separate specs.

---

## 0. Environment Variables

All environment variables required by the document system, consolidated in one place.

| Variable | Required | Default | Used By |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | Embedding generation (text-embedding-3-small) and LLM metadata resolution |
| `SUPABASE_URL` | Yes | — | Object storage for PDF files |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | — | Server-side Supabase admin client (also accepted as `SUPABASE_SERVICE_ROLE`) |
| `SUPABASE_BUCKET` | No | `"documents"` | Storage bucket name for PDF uploads |
| `DATABASE_URL` | Yes | — | PostgreSQL connection (must have pgvector extension installed) |

For a Python + Next.js implementation, the object storage provider is interchangeable (S3, GCS, R2, etc.). The key requirements are: the bucket supports public read access (for PDF serving to the browser), and the upload API returns a URL ending in `.pdf`.

---

## 1. Data Model

### 1.1 Document

The central record for any ingested content.

| Field | Type | Notes |
|---|---|---|
| `id` | string (UUID) | Primary key, generated server-side |
| `url` | string, nullable | Discriminator for document type. For PDFs: the public file URL. For EPUBs: the literal string `"epub"`. For web articles: the source URL. |
| `title` | string | Required. Extracted from metadata or filename. |
| `content` | string | The renderable content. For EPUBs: concatenated raw chapter HTML. For web articles: extracted HTML. For PDFs: empty string `""`. |
| `textContent` | string, nullable | Plain text representation. For PDFs: the extracted full text. For EPUBs: `null` (the HTML in `content` is the source of truth). |
| `publishedTime` | string, nullable | ISO 8601 date string when available. |
| `createdAt` | timestamp | Auto-set on insert. |
| `updatedAt` | timestamp | Auto-set on insert, auto-updated on change. |

**Key design decision:** The `url` field doubles as a type discriminator. To determine how to render a document:
- If `url` ends with `.pdf` -> render as PDF (fetch the file from the URL)
- If `url === "epub"` -> render as HTML (use the `content` field)
- Otherwise -> render as HTML (use the `content` field)

### 1.2 Author

Deduplicated author records shared across documents.

| Field | Type | Notes |
|---|---|---|
| `id` | string (UUID) | Primary key |
| `name` | string | Required, deduplicated case-insensitively |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

### 1.3 Document-Author Link (many-to-many)

| Field | Type | Notes |
|---|---|---|
| `id` | string (UUID) | Primary key |
| `documentId` | string | FK -> Document, cascade delete |
| `authorId` | string | FK -> Author, cascade delete |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

### 1.4 Document Chunks (for semantic search)

Text is split into overlapping chunks, each with a vector embedding.

| Field | Type | Notes |
|---|---|---|
| `id` | string (UUID) | Primary key |
| `documentId` | string | FK -> Document, cascade delete |
| `text` | string | The chunk's text content |
| `chunkIndex` | integer | 0-based position within the document |
| `embedding` | vector(512) | 512-dimensional float vector. Requires pgvector or equivalent. |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

### 1.5 Annotation

A highlighted selection with an optional note, anchored by character offsets into the document's text content.

| Field | Type | Notes |
|---|---|---|
| `id` | string (UUID) | Primary key |
| `userId` | string | FK -> User, cascade delete |
| `documentId` | string | FK -> Document, cascade delete |
| `start` | integer | **Inclusive** start character offset in the document's rendered text |
| `end` | integer | **Exclusive** end character offset |
| `color` | string, nullable | Index into a color palette (stored as string, e.g. `"0"`, `"1"`, ...). See Section 7.3. |
| `body` | string, nullable | User's note/annotation text |
| `quote` | string, nullable | The exact highlighted text (for display/verification) |
| `prefix` | string, nullable | Up to 30 chars of context before the selection |
| `suffix` | string, nullable | Up to 30 chars of context after the selection |
| `visibility` | enum: `"private"` \| `"public"` | Default: `"private"` |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

**Character offset system (critical):** The `start` and `end` values represent offsets into the **cumulative plain text** of the rendered document. This is computed by walking all text nodes in DOM order within the document container and summing their lengths. This system is shared across all document types — EPUB, PDF, and web articles all use the same offset scheme, though the DOM structure they operate on differs. See Section 7 for full details.

### 1.6 User-Document Link

Associates users with documents they own or can view.

| Field | Type | Notes |
|---|---|---|
| `userId` | string | Composite PK part 1 |
| `documentId` | string | Composite PK part 2 |
| `role` | enum: `"owner"` \| `"viewer"` | Default: `"owner"` for uploaders |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

On conflict (same user + document), the role is upserted.

---

## 2. Upload & File Handling

### 2.1 Upload Endpoint

A single endpoint handles all document type uploads.

**Route:** `POST /api/upload`
**Content-Type:** `multipart/form-data`
**Body:** a single field `file` containing the uploaded file

**Constraints:**
- Maximum file size: **15 MB**
- Accepted MIME types: `application/pdf`, `application/epub+zip`
- Client-side file input should set `accept=".pdf,application/pdf,.epub,application/epub+zip"`

**Type detection:** Use binary magic-byte detection (e.g. the `file-type` library or Python `python-magic`) on the raw buffer first. Fall back to file extension matching (`.pdf`, `.epub`) if magic-byte detection fails.

**Response:** This is NOT a JSON API. On success, it returns an HTTP **redirect** (302/303) to `/workspace/document/{id}`. The client follows the redirect and loads the document view page. This means annotation creation triggers a full page navigation, not an XHR response.

**Error responses:**

| Status | Condition | Body |
|---|---|---|
| 400 | No file in form data | `"missing file"` |
| 413 | File exceeds 15 MB | `"file too large"` |
| 415 | Not PDF or EPUB | `"unsupported file type"` |
| 422 | PDF: text extraction failed (scanned/protected) | `"Could not extract text from this PDF. It may be scanned or protected."` |
| 422 | PDF: no readable text after chunking | `"PDF contained no readable text"` |
| 500 | PDF: embedding generation failed | `"Failed to generate embeddings for this PDF"` |
| 500 | PDF: file upload to storage failed | `"failed to upload to storage"` |

**Flow:**
1. Authenticate user
2. Read file from form data
3. Validate size <= 15 MB
4. Detect file type from buffer bytes
5. Dispatch to format-specific processing (see format-specific specs)
6. On success, **redirect** to `/workspace/document/{documentId}`

### 2.2 Document ID Generation

All document IDs are UUID v4, generated server-side before any database writes. This allows the ID to be used for file naming (e.g. `{id}.pdf` in cloud storage) before the document record exists.

---

## 3. Metadata Extraction Pipeline

All document types go through the same metadata resolution pipeline after format-specific parsing. This is a multi-source pipeline that combines structured metadata with LLM inference.

### 3.1 Metadata Collection

For each document type, format-specific metadata is collected into a common structure:

```
CollectedMetadata {
  authors: string[]         // raw author name candidates
  publishedTimes: string[]  // raw date/time candidates
  raw: Record<string, string>  // all key-value pairs for LLM context
}
```

**For EPUBs**, metadata is extracted from the EPUB's internal metadata record. Searched keys:
- Authors: `creator`, `creatorfileas`, `contributor`, `author`
- Dates: `date`, `modified`, `pubdate`, `published`

**For PDFs**, metadata is extracted from the PDF info dictionary. Searched keys:
- Authors: `Author`, `author`, `Creator`, `creator`, `dc:creator`, `dc:contributors`, `meta:author`
- Dates: `CreationDate`, `ModDate`, `Date`, `xap:CreateDate`, `xmp:CreateDate`, `dcterms:created`, `meta:creation-date`

**For web articles**, metadata is extracted from HTML meta tags using CSS selectors:
- Authors: `meta[name="author"]`, `meta[property="article:author"]`, `meta[name="dc.creator"]`, `[itemprop="author"]`, and others
- Dates: `meta[property="article:published_time"]`, `meta[name="pubdate"]`, `meta[name="dc.date"]`, `time[datetime]`, and others

**Metadata value flattening:** Values from metadata records can be strings, arrays, or objects. The flattening logic:
- String -> `[value]`
- Array -> recursively flatten each element
- Object -> extract from keys `name`, `value`, `text`, `title` (in that priority)
- Null/undefined -> `[]`

### 3.2 Author Name Parsing

Raw author strings are parsed to extract individual names:

1. **Split** on: ` and `, ` & `, `,`, `;`, `/`, `|`, ` with `
2. **Strip byline prefixes:** remove leading `By `, `From `, `Article by `
3. **Sanitize each name:**
   - Normalize whitespace
   - Remove trailing dashes/em-dashes
   - Remove journalistic noise words: `staff`, `reporting`, `reports`, `analysis`, `for <publication>`
   - Normalize ALL-CAPS names: if a word is >3 chars and all uppercase, title-case it (e.g. `SMITH` -> `Smith`; `AP` stays `AP`)
4. **Filter out stopword authors:** `ap`, `associated press`, `reuters`, `staff`, `staff writer`, `editorial board`, `editors`, `correspondent`, `contributors`, `news service`, `news desk`, `press release`
5. **Validation:** reject if <2 chars, contains no letters, or contains digits
6. **Deduplicate** case-insensitively

### 3.3 LLM-Assisted Metadata Resolution

After collecting raw metadata, an LLM call normalizes and fills gaps:

**Input prompt includes:**
- Document URL
- Title (from EPUB metadata or filename)
- Byline (if available)
- First ~1800 chars of text content (first 3 paragraphs)
- All collected raw metadata key-value pairs

**LLM output schema:**
```
{
  authors: string[] (max 8, each min 2 chars) | null
  publishedDate: string (min 4 chars, prefer ISO 8601) | null
  title: string (min 4 chars) | null
}
```

**Model:** A small/cheap model (the implementation uses `gpt-5-nano` / equivalent to `gpt-4o-mini`). Max 256 tokens.

**Merging priority:**
- Authors: LLM result > byline-parsed > metadata-extracted (all merged, deduplicated)
- Published date: LLM result > explicit input > metadata-extracted (first valid one wins)
- Title: LLM result > input title (first non-empty wins)

**Date normalization:** Attempt `Date.parse()` first. If that fails, try regex matching `YYYY-MM-DD` with optional time/timezone. Fall through to raw string if nothing matches. Reject dates that parse to epoch (1970-01-01).

### 3.4 Author Storage

After metadata resolution, authors are attached to the document:

1. For each unique author name (case-insensitive dedup):
2. Look up existing author by case-insensitive name match
3. If not found, create a new author record
4. Create a document-author link (idempotent, skip if already linked)

---

## 4. Text Chunking & Embeddings

Used for semantic search. Currently only applied to PDFs (not EPUBs — see note below).

### 4.1 Chunking

Plain text is split using a recursive character text splitter:
- **Chunk size:** 500 characters
- **Chunk overlap:** 50 characters
- Algorithm: Recursively split on paragraph breaks, then sentences, then words, trying to keep chunks at the target size while respecting natural boundaries.

### 4.2 Embedding Generation

Each chunk is embedded using an embedding model:
- **Model:** OpenAI `text-embedding-3-small` (or equivalent)
- **Dimensions:** 512
- **Max parallel calls:** 100 (batch the embedding calls)

### 4.3 Storage

Chunks are stored with their embedding vectors in a table with a vector column (e.g. pgvector). Each chunk has an index preserving document order.

### 4.4 Note on EPUB Embeddings

**The current implementation does NOT generate embeddings/chunks for EPUBs.** This is likely a gap rather than a design choice — EPUBs only store their concatenated HTML in `content`, and no chunking/embedding step is performed. A new implementation should probably chunk and embed EPUB text content as well.

---

## 5. Semantic Search

### 5.1 Query Flow

1. Embed the query string using the same model/dimensions as document chunks
2. Compute cosine similarity: `1 - (chunk_embedding <=> query_embedding)` (using pgvector's `<=>` operator)
3. Optionally filter by specific document IDs
4. Order by similarity descending
5. Return top K results (default K=5)

### 5.2 Search Result Shape

```
SearchResult {
  chunkId: string
  chunkText: string
  chunkIndex: number
  documentId: string
  documentTitle: string
  documentUrl: string | null
  publishedTime: string | null
  similarity: number  // 0.0 to 1.0
}
```

### 5.3 Title-Based Search

A separate simple search finds documents by title substring match (case-insensitive `ILIKE`). Returns up to 10 results ordered by recency. Used for mention/autocomplete features.

---

## 6. API Endpoint Reference

All document-related endpoints. All require authentication. All mutation endpoints return **redirects** (not JSON) on success.

### 6.1 Upload

```
POST /api/upload
Content-Type: multipart/form-data
Body: { file: File }
Success: 302 -> /workspace/document/{id}
Errors: see Section 2.1
```

### 6.2 Save Annotation

```
POST /workspace/document/{documentId}/save-annotation
Content-Type: application/json OR multipart/form-data

JSON body:
{
  "start": number,          // required, character offset (inclusive)
  "end": number,            // required, character offset (exclusive), must be > start
  "quote": string,          // the selected text
  "prefix": string,         // up to 30 chars before selection
  "suffix": string,         // up to 30 chars after selection
  "body": string,           // user's note (empty string if none)
  "color": string           // color index as string (e.g. "0", "1")
}

FormData alternative:
  Field "annotation" = JSON string of the above object

Success: 302 -> /workspace/document/{documentId}
Errors:
  400 "Missing 'annotation' field" (FormData mode, missing field)
  400 "Invalid JSON in 'annotation'" (FormData mode, bad JSON)
  400 "Invalid selection span" (start/end validation failed)
```

**Server-side processing:**
1. Validate start/end are numbers and end > start
2. Generate UUID for the annotation
3. Set `createdAt` and `updatedAt` to current server time (NOT provided by client)
4. Set `visibility` to `"private"` (default)
5. Insert annotation record
6. Redirect back to document view

### 6.3 Delete Annotation

```
POST /workspace/delete-annotation/{documentId}/{annotationId}
Content-Type: any (body is ignored)
Success: 302 -> /workspace/document/{documentId}
```

### 6.4 Document View (Page Load)

```
GET /workspace/document/{documentId}

Server-side loader:
1. Authenticate user
2. Fetch document by ID (SELECT all columns — needed for rendering)
3. Fetch all visible annotations for this document + user
4. Fetch user's color preference
5. Return all data to the page component
```

### 6.5 Document List (for sidebar)

```
Query: SELECT id, title, url FROM documents WHERE user has access
```

**IMPORTANT: Do NOT select `content` or `textContent` for list views.** These columns can be megabytes per row (especially `content` for EPUBs). Only fetch them when rendering the document view. A list query selecting all columns from 50 documents with EPUB content would transfer hundreds of megabytes.

---

## 7. Annotation System

The annotation system is the most complex shared subsystem. It handles creating, storing, rendering, and interacting with text highlights across all document types.

### 7.1 Character Offset Calculation (Selection -> Offsets)

When a user selects text in the document viewer, the browser selection is converted to absolute character offsets.

**Algorithm:**

```
function getCharOffset(containerEl, node, nodeOffset):
  walker = createTreeWalker(containerEl, SHOW_TEXT)
  charCount = 0
  while walker.nextNode():
    current = walker.currentNode
    if current === node:
      return charCount + nodeOffset
    charCount += current.nodeValue.length
  return -1  // not found

function rangeToOffsets(containerEl, range):
  start = getCharOffset(containerEl, range.startContainer, range.startOffset)
  end = getCharOffset(containerEl, range.endContainer, range.endOffset)
  return { start, end }
```

This walks every text node in the document container in DOM order, accumulating character counts. When the target node (the one the browser selection starts/ends in) is found, the offset within that node is added to the cumulative count.

**CRITICAL — Container element identity:** The selection handler needs a reference to the document container element to walk its text nodes. The reference implementation uses `getElementById("doc-container")`, but the original codebase has a bug where **two elements** share the same `id="doc-container"` — the parent wrapper div and the child `DocumentContents` div. This works by accident because `getElementById` returns the first match, and the tree walker on the outer div still reaches the inner div's text nodes. **In a new implementation, use a React ref (or equivalent) instead of `getElementById`.** Pass the ref from the parent component to the viewer, and use it for both the selection handler and the annotation rendering algorithm.

**Context capture:** Along with the offsets, the system captures:
- `quote`: the selected text (`textContent.slice(start, end)`)
- `prefix`: up to 30 characters before the selection
- `suffix`: up to 30 characters after the selection

These provide redundancy for offset verification and human-readable previews.

**PDF offset domain warning:** For PDFs, the selection handler walks ALL text nodes in the container (including any non-textLayer nodes pdf.js might create), while the annotation overlay renderer (`drawOverlayHighlights`) walks ONLY text nodes inside `.textLayer` elements. In practice these produce the same offsets because all selectable text lives in `.textLayer`, but be aware of this asymmetry. If pdf.js adds any visible text outside `.textLayer` (e.g. annotation tooltips), the offset domains could diverge. A robust implementation should use the same filtering logic in both places.

### 7.2 Saving an Annotation

See Section 6.2 for the full endpoint contract. The key fields are:

**Client-side payload:**
```
{
  start: number,     // required, character offset (inclusive)
  end: number,       // required, character offset (exclusive), must be > start
  quote: string,     // the selected text
  prefix: string,    // up to 30 chars context before
  suffix: string,    // up to 30 chars context after
  body: string,      // user's note (empty string if none)
  color: string      // color index as string
}
```

**Field mapping (client -> database):**

| Client payload field | Database column | Notes |
|---|---|---|
| `start` | `start` | |
| `end` | `end` | |
| `quote` | `quote` | **Must map to `quote`, not any other name** |
| `prefix` | `prefix` | |
| `suffix` | `suffix` | |
| `body` | `body` | |
| `color` | `color` | |
| *(not sent)* | `id` | Generated server-side (UUID) |
| *(not sent)* | `userId` | From authenticated session |
| *(not sent)* | `documentId` | From URL parameter |
| *(not sent)* | `visibility` | Default `"private"` |
| *(not sent)* | `createdAt` | Server-side `now()` |
| *(not sent)* | `updatedAt` | Server-side `now()` |

**Post-save flow:** The save endpoint returns a **redirect** (not JSON). The browser follows the redirect to reload the document view page. This means:
- The page re-fetches the document and all annotations from the database
- The newly saved annotation appears because it's now in the annotation query results
- There is no optimistic update or WebSocket push — it's a full page reload

### 7.3 Annotation Colors

Colors are stored as string indices (`"0"`, `"1"`, etc.) mapping to a palette:

| Index | Name | CSS Background |
|---|---|---|
| 0 | red | `#fdd8d8` |
| 1 | purple | `#e9d8fd` |
| 2 | blue | `#d8defd` |
| 3 | green | `#d8fdea` |
| 4 | orange | `#fdebd8` |
| 5 | gray | (no explicit color — uses base mark styling) |

Each user has a color assigned to them (stored on the user record). When they create an annotation, their user color index is attached.

Additional palette colors available in CSS (not currently in the index array but defined):
- yellow: `#fff9d8`
- teal: `#d8fdf6`
- pink: `#fdd8f6`
- brown: `#f5e9d8`

### 7.4 Deleting an Annotation

**Endpoint:** POST to a delete-annotation route (parameterized by document ID and annotation ID)

**Server-side:** Verify the user has write permission on the annotation, then delete it. Redirect back to the document view.

### 7.5 Annotation Retrieval

When loading a document view, all annotations for that document visible to the current user are fetched. The visibility rules (simplified, ignoring permissions):
- User always sees their own annotations
- `visibility: "public"` annotations are visible to all users who can access the document
- `visibility: "private"` annotations are only visible to the creator

---

## 8. Annotation Rendering (HTML Documents)

This is the rendering approach for HTML-based content (EPUBs and web articles). PDF annotation rendering is described in the PDF-specific spec.

### 8.1 Overview

The rendering pipeline takes raw HTML content + a list of annotations and produces modified HTML with `<mark>` elements wrapping highlighted regions. This runs client-side as a React effect.

### 8.2 Algorithm

**Step 1: Build a detached DOM**
```
root = createElement("div")
root.innerHTML = documentHTML
```

**Step 2: Walk text nodes and record absolute offsets**
```
walker = createTreeWalker(root, SHOW_TEXT)
nodes = []   // Array of { node: TextNode, start: number, end: number }
pos = 0
while walker.nextNode():
  node = walker.currentNode
  len = node.nodeValue.length
  if len > 0:
    nodes.push({ node, start: pos, end: pos + len })
    pos += len
```

**Step 3: Filter and sort annotations**
```
anns = annotations
  .filter(a => isFinite(a.start) && isFinite(a.end) && a.end > a.start)
  .sort((a, b) => a.start - b.start)
```

**Step 4: Map annotations to per-node relative ranges**

For each annotation, find which text nodes it overlaps with and compute the relative character range within each node:

```
perNode = Map<TextNode, Array<{ rs: number, re: number, ann: Annotation }>>

ni = 0  // node index cursor (optimization: don't re-scan from 0 each time)
for ann in anns:
  // advance cursor past nodes that end before this annotation starts
  while ni < nodes.length && nodes[ni].end <= ann.start:
    ni++

  for j = ni to nodes.length:
    { node, start: ns, end: ne } = nodes[j]
    if ns >= ann.end: break

    s = max(ann.start, ns)
    e = min(ann.end, ne)
    if s < e:
      perNode[node].push({ rs: s - ns, re: e - ns, ann })
```

**Step 5: Split text nodes and wrap with `<mark>` elements**

For each text node that has overlapping annotations, use a sweep-line algorithm to handle overlapping highlights:

```
for (node, rangesRaw) in perNode:
  full = node.nodeValue

  // Create start/end events
  events = []
  for { rs, re, ann } in rangesRaw:
    events.push({ x: rs, type: "start", ann })
    events.push({ x: re, type: "end", ann })

  // Sort: by position, then "end" events before "start" at same position
  events.sort(by x, then end-before-start)

  frag = createDocumentFragment()
  active = []  // currently-covering annotations
  cursor = 0

  for event in events:
    if cursor < event.x:
      // emit text from cursor to event.x
      text = full.slice(cursor, event.x)
      if active.length == 0:
        frag.append(textNode(text))     // plain text
      else:
        frag.append(createMark(text, active))  // highlighted

    if event.type == "start":
      active.push(event.ann)
    else:
      active.remove(event.ann)

    cursor = event.x

  // emit remaining text after last event
  if cursor < full.length:
    emit(full.slice(cursor, full.length))

  // replace original text node with the fragment
  node.parentNode.replaceChild(frag, node)
```

**Step 6: Extract and set innerHTML**
```
setRenderedHTML(root.innerHTML)
```

### 8.3 Mark Element Structure

Each `<mark>` element has:
- `class="anno-mark {colorName}"` — base class + color class (e.g. `red`, `purple`, `blue`, `green`, `orange`)
- `data-annid="{primaryAnnotationId}"` — the first (primary) annotation's ID, used for hover/click grouping
- `data-annids='["id1","id2"]'` — JSON array of ALL overlapping annotation IDs at this point
- `data-note="{body}"` — the annotation's note text (if any)
- `data-ranges='[{"start":N,"end":M}]'` — JSON array of all covering annotations' ranges

### 8.4 Interaction: Hover

Uses event delegation on the document container (not per-mark listeners). This survives innerHTML re-renders.

**Hover in:**
1. On `mouseover`, find the closest `.anno-mark` ancestor
2. Read its `data-annid`
3. Find ALL `.anno-mark` elements in the container with the same `data-annid`
4. Add class `is-hovered` to all of them
5. Track the current hovered ID to avoid redundant DOM queries

**Hover out:**
1. On `mouseout`, check if the `relatedTarget` is still inside an `.anno-mark`
2. If not, remove `is-hovered` from all marks

### 8.5 Interaction: Click (Select)

**Click on a mark:**
1. Read `data-annid` from the clicked mark
2. If same as currently selected ID: deselect (remove `is-selected` from all, clear browser selection)
3. If different: remove `is-selected` from all, add `is-selected` to all marks sharing this `data-annid`
4. Create a browser `Range` spanning from the first piece's first text child to the last piece's last text child, and set it as the browser selection (enables copy)

### 8.6 Interaction: Click on Mark -> Note Popover

When an `.anno-mark` is clicked, a NotePopover appears showing:
- The annotation's note text (from `data-note`), or "// no note saved" if empty
- A delete button that POSTs to the delete-annotation endpoint
- Positioned at the mark's bounding rect (`left`, `bottom + 8px`)
- Closes on pointer-down outside the popover

### 8.7 CSS

```css
.anno-mark {
  cursor: pointer;
  transition: background-color 0.2s ease;
}

mark.anno-mark.is-hovered {
  background-color: #ffea80;     /* bright yellow */
}

mark.anno-mark.is-selected {
  background: rgba(255, 215, 64, 0.35);
}
```

Color classes (`.red`, `.purple`, `.blue`, `.green`, `.orange`, `.yellow`, `.teal`, `.pink`, `.brown`) set `background-color` to their respective light pastel values.

---

## 9. Selection & Annotation Creation UI

### 9.1 UI State Machine

The annotation creation flow has distinct states. Understanding these prevents subtle bugs.

```
IDLE
  -> user selects text (mouseup)
  -> if valid selection: push temporary annotation, show popover -> POPOVER_OPEN
  -> if invalid (collapsed or outside container): stay IDLE

POPOVER_OPEN
  -> user clicks Save: serialize payload, submit form -> SAVING
  -> user clicks outside popover: remove temporary annotation (.pop()), hide popover -> IDLE
  -> user clicks an existing annotation mark: close popover, remove temp annotation -> IDLE

SAVING
  -> form POST fires, browser follows redirect -> full page reload
  -> page re-renders with annotation from database -> IDLE
```

**The temporary preview annotation pattern:** When the user selects text, a temporary annotation object is immediately pushed onto the annotations array. This annotation has empty `id` and `userId` fields but valid `start`, `end`, and `color`. This causes the viewer to re-render with a preview highlight visible instantly. A counter state variable (`rerenderToShowHighlight`) is incremented to force the re-render.

If the user dismisses the popover without saving, the temporary annotation is removed by calling `.pop()` on the annotations array. If the user saves, the form submission triggers a redirect/page reload, at which point the temporary annotation is gone (replaced by the real one from the database).

### 9.2 Selection Handler

On `mouseup` within the document container:

1. Get the browser `Selection` and its first `Range`
2. Get the container element (see Section 7.1 about using refs instead of getElementById)
3. Compute `{ start, end }` offsets using the tree-walker algorithm (Section 7.1)
4. Validate: `start >= 0` and `end > start`
5. Extract context:
   - `quote = containerEl.textContent.slice(start, end)`
   - `prefix = containerEl.textContent.slice(start - 30, start)` (clamped to 0)
   - `suffix = containerEl.textContent.slice(end, end + 30)` (clamped to length)
6. Store as JSON in a ref (used later by the form submission)
7. Get the selection's bounding rect for popover positioning
8. Show the annotation creation popover at `(rect.left, rect.top + 40)`
9. Push a temporary annotation: `{ id: "", userId: "", documentId, body: "", start, end, color: userColor, ... }`
10. Force a re-render to display the preview highlight

**The `sliceSafe` helper:** Context capture uses a bounds-clamped slice to avoid index-out-of-range:
```
function sliceSafe(s, start, end):
  a = max(0, min(s.length, start))
  b = max(0, min(s.length, end))
  return s.slice(a, b)
```

### 9.3 Annotation Creation Popover (CustomPopover)

A floating panel positioned at the selection point with:

**Layout:**
- Left column (main content):
  - The selected text displayed in a bordered block (max-height 120px, scrollable)
  - A textarea for adding a note (placeholder: `"// add note..."`)
    - Auto-resizes up to 3 lines (max height = 3 * line-height)
- Right column (actions):
  - **Save annotation** button (CornerDownLeft icon): submits the annotation form
  - *(Other buttons for chat integration — omitted per spec scope)*

**Behavior:**
- Fixed positioning at the selection coordinates
- Width: 360px
- z-index: 1000
- Closes on pointer-down outside the popover (uses `pointerdown` event in capture phase)
- On close, the temporary preview annotation is removed (`.pop()` from annotations array)
- On submit: serializes `{ documentId, start, end, color, quote, prefix, suffix, body }` as JSON into a hidden input named `"annotation"`, then submits the form via POST to the save-annotation endpoint

**Popover positioning note:** The popover is positioned with `position: fixed` at the bounding rect of the selection. The current implementation does NOT handle viewport edge cases — if the selection is near the bottom or right edge of the viewport, the popover may overflow off-screen. A production implementation should clamp the position to stay within the viewport.

---

## 10. Document List

A sidebar component listing the user's documents. Each entry shows:
- A file icon
- The document title (or URL/ID as fallback if title is empty)
- Truncated to 2 lines with `line-clamp-2`
- Links to `/workspace/document/{id}`
- Tooltip on hover showing the full title

---

## 11. Document View Page (Container)

The document view is the main page for reading and annotating a document.

### 11.1 Data Loading

On page load:
1. Authenticate the user
2. Load the document record by ID
3. Load all visible annotations for this document + user
4. Load the user's color preference

### 11.2 Routing to the Correct Viewer

The page determines the viewer component by checking the document's `url` field:
- If `url` matches `/\.pdf$/i` -> render `PdfViewer` with `src={document.url}`
- Otherwise -> render `DocumentContents` with `documentHTML={document.content}`

Both viewers receive the same `annotations` array and use the same offset-based annotation system.

### 11.3 Container Structure

```
<NotePopover />          (conditionally rendered when clicking an existing annotation)
<CustomPopover />        (conditionally rendered when text is selected)

<div ref={containerRef} onMouseUp={handleSelectionEnd} onClick={handleDocClick}
     style={{ userSelect: "text" }}>
  <PdfViewer /> or <DocumentContents />
</div>
```

**Use a ref, not an ID.** Pass `containerRef` to both the selection handler (for offset calculation) and the viewer component (for annotation rendering). This avoids the duplicate-ID problem described in Section 7.1.

The container div handles both selection (`mouseup`) and annotation click (`click` on `.anno-mark`). The click handler calls `stopPropagation()` to prevent the selection handler from firing when clicking an existing annotation.

`userSelect: "text"` must be explicitly set on the container to ensure text selection works in both PDF and HTML viewers.

### 11.4 HTML Document Rendering (docContainer)

HTML content is rendered inside a container with these styles:
- Tailwind `prose` class (typography plugin) for readable formatting
- `mx-auto` for centering
- Images, videos, iframes: centered, rounded, max-width
- Videos/iframes: 16:9 aspect ratio
- Figcaptions: small, muted, centered

---

## 12. Data Flow Summary

### Upload Flow
```
File Upload -> Authenticate -> Validate size -> Detect type
  -> Format-specific parsing (extract text, HTML, metadata)
  -> Metadata resolution pipeline (collect -> LLM-infer -> merge)
  -> Generate document ID (UUID)
  -> Save document record
  -> Attach authors
  -> [If applicable] Chunk text -> Generate embeddings -> Save chunks
  -> Redirect to document view
```

### View Flow
```
Request document page -> Authenticate -> Load document -> Load annotations
  -> Determine viewer type (PDF vs HTML)
  -> Render viewer component
  -> [For HTML] Run annotation overlay algorithm -> Render marked HTML
  -> [For PDF] Render PDF pages -> Draw overlay highlights
  -> Attach selection/click handlers
```

### Annotation Creation Flow
```
User selects text -> mouseup fires -> Compute character offsets
  -> Capture quote/prefix/suffix -> Show popover with preview highlight
  -> User optionally adds note -> User clicks save
  -> POST annotation data -> Server validates & saves -> Redirect
  -> Page reloads with new annotation in the annotations list
```
