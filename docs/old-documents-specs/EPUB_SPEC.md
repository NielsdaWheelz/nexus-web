# EPUB-Specific Specification

Everything specific to EPUB handling. Assumes familiarity with the shared document system described in `DOCUMENT_SYSTEM_SPEC.md`.

---

## 1. EPUB Upload & Processing

### 1.1 File Detection

An uploaded file is identified as EPUB by:
1. **Magic bytes:** MIME type `application/epub+zip` detected from the file buffer
2. **Extension fallback:** filename ends with `.epub` (case-insensitive)

### 1.2 Processing Pipeline

```
Receive buffer -> Write to temp file -> Parse EPUB -> Extract chapters
  -> Concatenate HTML -> Extract metadata -> Resolve metadata (shared pipeline)
  -> Generate document ID -> Save document -> Attach authors -> Delete temp file
```

**Detailed steps:**

1. **Write to temporary file**
   - EPUBs must be parsed from a file path (not a buffer) due to the EPUB parsing library's API
   - Path: `{system_temp_dir}/{uuid}.epub`
   - Written from the in-memory buffer

2. **Parse EPUB**
   - Open the EPUB file using an EPUB parser library
   - The reference implementation uses `epub2` (Node.js) which provides `EPub.createAsync(filepath)`
   - Python equivalents: `ebooklib`, `epub` library

3. **Extract all chapters (flow items)**
   - The EPUB's `flow` property contains an ordered list of content items (chapters/sections)
   - Each flow item has an `id`
   - For each flow item, fetch the raw HTML content: `book.getChapterRawAsync(chapterId)`
   - **All chapters are fetched in parallel** (Promise.all)
   - This returns an array of HTML strings, one per chapter

4. **Concatenate chapter HTML**
   - Join all chapter HTML strings with a single newline: `htmlChapters.join('\n')`
   - This becomes the document's `content` field
   - **No sanitization or transformation** is applied to the HTML at this stage — raw chapter HTML is stored as-is
   - This means the stored HTML may contain `<style>`, `<link>`, embedded CSS, `<img>` references (which won't resolve since we don't store EPUB assets), etc.

5. **Extract plain text preview**
   - From the concatenated HTML, strip:
     1. `<style>...</style>` blocks (regex: `/<style[\s\S]*?<\/style>/gi`)
     2. `<script>...</script>` blocks (regex: `/<script[\s\S]*?<\/script>/gi`)
     3. All remaining HTML tags (regex: `/<[^>]+>/g`)
     4. Collapse whitespace (regex: `/\s+/g` -> single space)
     5. Trim
   - Take only the **first 2000 characters** of the result
   - This plain text is used for:
     - Metadata resolution (LLM context)
     - NOT stored in `textContent` (which is set to `null` for EPUBs)

6. **Extract EPUB metadata**
   - From `book.metadata` (a key-value record), collect:
     - Author keys: `creator`, `creatorfileas`, `contributor`, `author`
     - Date keys: `date`, `modified`, `pubdate`, `published`
   - Uses the shared metadata flattening/parsing pipeline (see DOCUMENT_SYSTEM_SPEC Section 3)

7. **Resolve metadata (shared)**
   - Calls the shared `resolveDocumentMetadata()` with:
     - `url: "epub"` (literal string)
     - `title`: from EPUB metadata `book.metadata.title`, fallback to filename
     - `textContent`: the 2000-char plain text preview
     - `publishedTime`: first date from collected metadata
     - `meta`: the collected metadata structure

8. **Save document record**
   - `id`: newly generated UUID
   - `url`: `"epub"` (literal string — this is the type discriminator)
   - `title`: resolved title, falling back to `book.metadata.title`, then filename (with extension stripped)
   - `content`: the full concatenated chapter HTML
   - `textContent`: `null`
   - `publishedTime`: resolved date or first collected date

9. **Attach authors** using the shared pipeline

10. **Cleanup:** delete the temporary EPUB file (in a `finally` block, errors swallowed)

### 1.3 What is NOT done for EPUBs (gaps vs. PDFs)

- **No file storage:** The EPUB file itself is not stored anywhere. Only the extracted HTML is saved in the database. The original file is deleted after processing. (PDFs, by contrast, are uploaded to cloud storage and their URL is stored.)
- **No text chunking or embeddings:** Unlike PDFs, no `documentChunks` records are created for EPUBs. This means EPUBs are **not searchable via semantic search**. This is a gap in the current implementation.
- **No `textContent`:** The `textContent` field is `null` for EPUBs. The HTML in `content` is the only stored representation.

### 1.4 Recommendations for New Implementation

- **Store the original EPUB file** in object storage (S3/equivalent) so it can be re-processed later
- **Generate chunks and embeddings** from the EPUB text content to enable semantic search
- **Store `textContent`** — generate and save the full plain text (not just 2000-char preview) for search and other uses
- **Sanitize HTML** — strip or scope `<style>` tags, rewrite/remove `<img>` and `<link>` references that point to EPUB-internal assets, to avoid broken references and CSS conflicts
- **Consider preserving chapter boundaries** — store chapter HTML separately or with markers, rather than a flat concatenation, to enable chapter-based navigation

---

## 2. EPUB Storage Model

### 2.1 Document Record

For EPUB documents, the document table row looks like:

```
{
  id: "uuid-...",
  url: "epub",                     // literal string, type discriminator
  title: "Book Title",
  content: "<html>...chapter 1 html...</html>\n<html>...chapter 2 html...</html>\n...",
  textContent: null,               // not used for EPUBs
  publishedTime: "2024-01-15" | null,
  createdAt: ...,
  updatedAt: ...
}
```

### 2.2 Size Considerations

EPUB content is stored as a single text column in the database. For large books, this can be a very large string (potentially megabytes of HTML). Consider:
- PostgreSQL `text` type has no practical length limit, but queries that SELECT it will transfer the full content
- Only fetch `content` when rendering the document view; for list views, select only `id`, `title`, `url`

---

## 3. EPUB Rendering

### 3.1 Viewer Selection

The document view page checks `document.url`:
- Does NOT match `/.pdf$/i` -> uses `DocumentContents` component
- Since `url === "epub"` for EPUBs, this routes to the HTML viewer

### 3.2 HTML Rendering

The `DocumentContents` component renders the EPUB's HTML content using `dangerouslySetInnerHTML` (React) or equivalent in other frameworks:

```jsx
<div
  id="doc-container"
  className="docContainer ..."
  dangerouslySetInnerHTML={{ __html: processedHtml }}
/>
```

**Important:** The HTML is first processed by the annotation overlay algorithm (see DOCUMENT_SYSTEM_SPEC Section 7) before being set as innerHTML. The component manages this via React state:
1. Initial state: raw document HTML
2. `useEffect` runs the annotation overlay algorithm on mount and when annotations change
3. Produces modified HTML with `<mark>` elements
4. Updates state, which triggers a re-render with the marked-up HTML

### 3.3 Content Styling

The container has the `docContainer` class which applies:

```css
.docContainer {
  @apply prose;       /* Tailwind typography plugin — readable defaults */
  @apply mx-auto;    /* Centered */
}

.docContainer :where(img, video, iframe, figure) {
  @apply mx-auto my-6 block rounded-lg;
}

.docContainer :where(video, iframe) {
  @apply w-full aspect-video;
}

.docContainer :where(figcaption) {
  @apply text-sm text-muted-foreground text-center mt-2;
}
```

Plus padding (`p-8`), gap (`gap-4`), full height, and vertical scrolling.

### 3.4 Theme Support

The container applies text color based on theme:
- Light theme: `text-[oklch(37.3%_0.034_259.733)]` (dark blue-gray)
- Dark theme: `text-white`

---

## 4. EPUB Annotation Rendering

EPUB annotations use the HTML overlay approach (described in DOCUMENT_SYSTEM_SPEC Section 8). Here's what's EPUB-specific:

### 4.1 Offset Domain

The `start` and `end` offsets on annotations refer to positions in the **concatenated text content** of ALL chapter HTML rendered in the `doc-container`. This means:
- The text from Chapter 1's HTML nodes comes first
- Followed by any text from the `\n` joining chapters
- Followed by Chapter 2's text nodes
- And so on

Since all chapters are concatenated into a single HTML blob and rendered together, the offsets form a single continuous domain across the entire book.

### 4.2 Interaction with EPUB-Internal Styling

EPUB HTML may contain `<style>` tags and inline styles from the original book. These styles are rendered as-is in the browser, which means:
- Book-specific fonts, colors, and layout may apply
- This can sometimes conflict with the application's styles
- Annotation `<mark>` elements are injected into this styled content, so their appearance may be affected by EPUB styles

### 4.3 Broken Asset References

Since the EPUB file is parsed and only HTML is kept:
- `<img src="images/cover.jpg">` references will be broken (the EPUB's internal assets aren't stored)
- CSS `url()` references to EPUB-internal fonts or images won't resolve
- `<link>` tags pointing to EPUB-internal stylesheets won't work

This doesn't break annotation functionality but affects visual fidelity.

---

## 5. EPUB Metadata Specifics

### 5.1 EPUB Metadata Record

EPUB files contain OPF metadata. After parsing, the library exposes this as `book.metadata`, a flat key-value record. Common keys include:

| Key | Description | Example |
|---|---|---|
| `title` | Book title | `"Moby Dick"` |
| `creator` | Primary author | `"Herman Melville"` |
| `creatorfileas` | Author in "Last, First" format | `"Melville, Herman"` |
| `contributor` | Additional contributors | `"Editor Name"` |
| `author` | Sometimes present as alias for creator | |
| `date` | Publication date | `"2020-01-15"` |
| `modified` | Last modified date | |
| `pubdate` | Publication date (alternate key) | |
| `published` | Publication date (alternate key) | |
| `language` | Language code | `"en"` |
| `publisher` | Publisher name | |
| `description` | Book description/blurb | |
| `subject` | Genre/category | |
| `rights` | Copyright info | |
| `identifier` | ISBN or other identifier | |

### 5.2 Title Resolution

Title priority (first non-empty wins):
1. LLM-resolved title (from metadata resolution pipeline)
2. `book.metadata.title` (from the EPUB's OPF)
3. Original filename (with extension stripped)

### 5.3 Author Resolution

Author candidates are merged from:
1. LLM-inferred authors
2. EPUB metadata fields: `creator`, `creatorfileas`, `contributor`, `author`

All run through the shared author name parsing pipeline (splitting, sanitizing, deduplicating).

---

## 6. EPUB Flow (book.flow)

### 6.1 What is "flow"?

The EPUB `flow` is the ordered list of content documents (XHTML files) that make up the book's reading order. This comes from the EPUB's OPF `<spine>` element.

Each flow item has:
- `id`: a reference to a manifest item
- The content can be fetched by ID to get the raw XHTML/HTML

### 6.2 Chapter Extraction

```python
# Pseudocode
chapters = []
for item in book.flow:
    html = book.get_chapter_raw(item.id)
    chapters.append(html)

full_html = "\n".join(chapters)
```

**All chapters are extracted** — there is no filtering, no table-of-contents awareness, no special handling for front matter, back matter, or non-content items. Everything in the spine is concatenated.

### 6.3 Structural Implications

Because all chapters are joined into one HTML string:
- There are no chapter boundaries in the rendered output
- There is no chapter navigation or table of contents
- The entire book renders as one long scrollable page
- Very long books may result in a very large DOM and slow rendering

---

## 7. Known Limitations & Improvement Opportunities

### 7.1 No Semantic Search for EPUBs
EPUBs don't get chunked or embedded. Adding this would require:
1. Strip HTML from the concatenated content to get plain text
2. Run through the shared chunking pipeline (500 chars, 50 overlap)
3. Generate embeddings
4. Save chunks

### 7.2 No Chapter Navigation
The current implementation renders all chapters as a single continuous scroll. A better approach:
- Parse the EPUB's table of contents (NCX or nav document)
- Store chapter boundaries (could be offset ranges or separate records)
- Provide a sidebar/dropdown for jumping to chapters

### 7.3 No EPUB Asset Handling
Images, fonts, and CSS from within the EPUB are lost. Options:
- Extract and store EPUB assets (images, CSS) in object storage alongside the HTML
- Rewrite `src` and `href` attributes to point to stored assets
- Or: render using an EPUB.js-style reader that works with the original EPUB file (requires storing the file)

### 7.4 No Original File Preservation
The EPUB file is deleted after processing. If the parsing logic changes or needs to be re-run, the original is gone. Store it in object storage.

### 7.5 CSS Isolation
EPUB stylesheets can leak into the application UI. Consider:
- Scoping EPUB styles with Shadow DOM or iframe isolation
- Stripping EPUB `<style>` tags entirely and applying only the app's typography styles
- Using a CSS namespace/prefix for EPUB content

### 7.6 Large Book Performance
Rendering an entire book as one HTML blob can be slow. Consider:
- Virtualized/paginated rendering (render only visible chapters)
- Lazy-loading chapter content as the user scrolls
- Splitting storage: one record per chapter, assembled on the client

### 7.7 EPUB 3 Support
The current implementation uses `epub2` which handles EPUB 2 well but may have limited EPUB 3 support. EPUB 3 features that might need attention:
- Media overlays (audio sync)
- MathML content
- SVG content
- Fixed-layout EPUBs
- JavaScript in EPUBs (generally should be stripped for security)
