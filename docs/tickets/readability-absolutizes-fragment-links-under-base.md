# readability absolutizes in-document links when `<base>` differs from the page url

status: open · origin: 2026-09-23 firefox v1 track b · area: article extraction / reader apparatus

`node/ingest/article_extraction.mjs` hands the document to Readability, whose
`_fixRelativeUris` leaves an `href="#id"` alone only when the document's
`baseURI` equals its `documentURI`. On a page with `<base href>` pointing
elsewhere (or a trailing-slash difference), a note marker `<a href="#fn1">`
becomes `https://host/base/#fn1`, so `html_apparatus._local_target_id`
(`python/nexus/services/html_apparatus.py`) no longer sees a local target and
the footnote/bibliography graph is lost. both the server ingest and the browser
capture share the extractor, so both lose the apparatus. the browser projection
in `apps/web/src/extension/content.ts` deliberately keeps `#…` hrefs verbatim
and cannot recover ones the extractor already rewrote. observed in the track b
jsdom harness (`tools/firefox-harness/runtime/content.test.ts`, readability
path with `<base href="https://example.com/dir/">`); no production page was
checked.

fix: in `article_extraction.mjs`, after `parse()`, restore hrefs of the form
`${baseURI}#id` (and `${documentURI}#id`) to `#id` when `id` resolves inside
the extracted content, or run Readability on a clone whose `<base>` is removed
and resolve relative links against the real base afterwards. a browser-safe
change in the extractor is within track b's remit per the freeze; it is not
made here because it changes server extraction output for existing pages.

acceptance: a fixture with `<base href>` different from the page url and a
`<sup><a href="#n1">` marker with a backlinked `<li id="n1">` yields
`html_apparatus` items/edges through both node ingest and browser capture.
