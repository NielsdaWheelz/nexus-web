# PDF

PDF source acceptance is owned by `media_source_ingest.py`.

- Public URL, upload, and browser-file capture entry points create a `media` row
  plus a `media_source_attempts` row before PDF fetch/extraction work starts.
- `ingest_media_source` is the only worker job kind that starts source
  processing. It dispatches remote PDF fetches, uploaded PDFs, and
  browser-captured PDFs into the PDF extraction task after the source is durable.
- `pdf_ingest.py` owns PDF text extraction artifacts, page spans, plain text,
  and evidence-index handoff.
- `pdf_readiness.py`, `pdf_highlights.py`, and related reader services own PDF
  quote/highlight readiness and locator behavior.

Retry and refresh create a new source attempt. They do not enqueue `ingest_pdf`
directly from routes or UI clients.
