# article capture retains the entire authenticated dom

status: open · origin: 2026-09-23 firefox v1 review · area: capture privacy

`apps/extension/content.js:25-26` sends readable html and the full
`document.documentElement.outerHTML`. the latter includes unrelated account
markup, hidden inputs and inline scripts when present. both blobs are stored
before reader sanitization (`python/nexus/services/media_source_ingest.py:1062-1085`).
private storage and later sanitization do not minimize what leaves the browser.
no actual credential exposure was observed in this review. a read-only node
probe on 2026-09-23 also confirmed `node/ingest/article_extraction.mjs:53` retains
`data-private-token="fixture-secret"` on an ordinary readable paragraph. removing
full-dom source alone does not remove hidden state from extracted content.

prerequisite: raw source has a real embed-recovery consumer:
`python/nexus/services/web_article_structure.py:104-109`. removing it without
preserving that evidence changes article behavior.

fix: specify the minimum retained article/source evidence, remove unrelated
forms/scripts/account markup and arbitrary content attributes before
transmission, and preserve required embed/apparatus evidence in a bounded
representation. keep server sanitization authoritative.

acceptance: a sample page with article text, embedded document, hidden token and
account navigation, plus private `data-*` inside readable text, saves its
article/embed evidence without transmitting unrelated state; reader html remains
sanitized. this is minimization, not a promise that article prose is non-sensitive.
