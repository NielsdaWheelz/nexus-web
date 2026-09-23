# extension extraction omits existing article selection rules

status: open · origin: 2026-09-23 firefox v1 review · area: article extraction

`apps/extension/content.js:6` runs plain readability on the whole cloned dom.
`node/ingest/article_extraction.mjs:3-59` additionally handles wikisource bodies,
prefers a unique semantic main landmark and retains classes for downstream
processing. browser capture does not receive those existing quality fixes.
this is source-confirmed divergence; no live browser mis-extraction was observed.
`content.js:11-24` also substitutes its own limited date/site-name lookups for
the extractor's returned metadata.

fix: share the browser-safe document-selection/extraction policy and pinned
readability dependency. retain separate network acquisition adapters. confirm
that live-dom extraction preserves the base url and required apparatus evidence.

acceptance: the same representative documents produce equivalent intended
article bodies through server and browser extraction; the live page is unchanged
and source acquisition remains environment-specific.
