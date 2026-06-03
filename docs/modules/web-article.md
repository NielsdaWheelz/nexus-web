# Web Articles

Web article media is `media.kind = 'web_article'`, but source ownership is split
by provenance.

- `media_ingest.py`: URL dispatch.
- `x_ingest.py`: X same-author thread snapshots and refresh; no oEmbed fallback.
- `media.py`: browser-captured article persistence and generic provisional web
  article rows.
- `web_article_structure.py`: sanitization, canonical text, and fragment block
  preparation.
- `web_article_indexing.py`: content-index rebuild and failure marking for web
  article fragments.

Routes stay transport-only. X URLs fail closed through `x_ingest.py`; they do not
fall back to generic web article capture or oEmbed.
